// SPDX-License-Identifier: MIT OR Apache-2.0
use super::{engine::Engine, types::*};
use pdfium_render::prelude::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
};

pub fn run(library: &Path) -> Result<(), String> {
    if !library.is_absolute() {
        return Err("对比引擎路径必须是受控绝对路径。".into());
    }
    let pdfium = Pdfium::new(
        Pdfium::bind_to_library(library.canonicalize().map_err(|_| "对比引擎资源缺失。")?)
            .map_err(|_| "对比引擎加载失败。")?,
    );
    let output = Arc::new(Mutex::new(std::io::BufWriter::new(std::io::stdout())));
    let send = {
        let output = output.clone();
        move |reply: Reply| {
            if let Ok(mut writer) = output.lock() {
                let _ = serde_json::to_writer(&mut *writer, &reply);
                let _ = writer.write_all(b"\n");
                let _ = writer.flush();
            }
        }
    };
    let send = Arc::new(send);
    let token = Arc::new(AtomicBool::new(false));
    let busy = Arc::new(AtomicBool::new(false));
    let job = Arc::new(Mutex::new(String::new()));
    let (tx, rx) = mpsc::sync_channel::<Request>(8);
    {
        let (send, token, busy, job) = (send.clone(), token.clone(), busy.clone(), job.clone());
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            let mut reader = BufReader::new(stdin.lock());
            loop {
                let mut line = String::new();
                let size = (&mut reader).take(1024 * 1024 + 1).read_line(&mut line);
                if !matches!(size, Ok(1..=1048576)) || !line.ends_with('\n') {
                    break;
                }
                let Ok(request) = serde_json::from_str::<Request>(&line) else {
                    break;
                };
                if request.command == "cancel" {
                    let wanted = request
                        .args
                        .get("jobId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let current = job.lock().unwrap();
                    let same = *current == wanted && busy.load(Ordering::Acquire);
                    if same {
                        token.store(true, Ordering::Release)
                    }
                    send(Reply::response(request.id, Ok(json!({"accepted":same}))));
                    continue;
                }
                if busy.load(Ordering::Acquire) {
                    send(Reply::response(
                        request.id,
                        Err("对比正在计算，请先取消或等待完成。".into()),
                    ));
                    continue;
                }
                if request.command == "start" {
                    busy.store(true, Ordering::Release);
                    token.store(false, Ordering::Release);
                    *job.lock().unwrap() = request
                        .args
                        .get("jobId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                }
                match tx.try_send(request) {
                    Ok(()) => {}
                    Err(mpsc::TrySendError::Full(request)) => {
                        if request.command == "start" {
                            busy.store(false, Ordering::Release)
                        }
                        send(Reply::response(
                            request.id,
                            Err("对比请求过多，请稍后重试。".into()),
                        ))
                    }
                    Err(_) => break,
                }
            }
            token.store(true, Ordering::Release);
        });
    }
    let mut engine = Engine::new(&pdfium);
    for request in rx {
        if request.command == "start" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Start {
                job_id: String,
                options: Options,
            }
            let parsed = serde_json::from_value::<Start>(request.args)
                .map_err(|_| "无效的对比任务参数。".to_owned())
                .and_then(|value| {
                    value.options.validate()?;
                    if value.job_id.is_empty()
                        || value.job_id.len() > 100
                        || !value
                            .job_id
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '-')
                    {
                        return Err("无效任务标识。".into());
                    }
                    Ok(value)
                });
            let input = match parsed {
                Ok(input) => input,
                Err(error) => {
                    busy.store(false, Ordering::Release);
                    send(Reply {
                        id: None,
                        result: None,
                        error: None,
                        progress: Some(Progress {
                            job_id: job.lock().unwrap().clone(),
                            status: "failed".into(),
                            error: Some(error.clone()),
                            ..Progress::default()
                        }),
                    });
                    send(Reply::response(request.id, Err(error)));
                    continue;
                }
            };
            send(Reply::response(
                request.id,
                Ok(json!({"jobId":input.job_id})),
            ));
            let job_id = input.job_id.clone();
            let result = engine.compare(input.job_id, input.options, &token, |completed, total| {
                send(Reply {
                    id: None,
                    result: None,
                    error: None,
                    progress: Some(Progress {
                        job_id: job_id.clone(),
                        status: "running".into(),
                        completed,
                        total,
                        report: None,
                        error: None,
                    }),
                })
            });
            let state = match result {
                Ok(report) => Progress {
                    job_id,
                    status: "complete".into(),
                    completed: report.tile_count,
                    total: report.tile_count,
                    report: Some(report),
                    error: None,
                },
                Err(error) => Progress {
                    job_id,
                    status: if error == "COMPARE_CANCELLED" {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into(),
                    completed: 0,
                    total: 0,
                    report: None,
                    error: if error == "COMPARE_CANCELLED" {
                        None
                    } else {
                        Some(error)
                    },
                },
            };
            busy.store(false, Ordering::Release);
            send(Reply {
                id: None,
                result: None,
                error: None,
                progress: Some(state),
            });
            continue;
        }
        let result = (|| -> Result<Value, String> {
            match request.command.as_str() {
                "open" => {
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Open {
                        side: String,
                        path: String,
                        password: Option<String>,
                    }
                    let input: Open =
                        serde_json::from_value(request.args).map_err(|_| "无效的文件请求。")?;
                    engine
                        .open(&input.side, &input.path, input.password.as_deref())
                        .map(|v| json!(v))
                }
                "preview" => {
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct PreviewRequest {
                        options: Options,
                        width: u32,
                        rect: Option<Rect>,
                    }
                    let input: PreviewRequest =
                        serde_json::from_value(request.args).map_err(|_| "无效的预览请求。")?;
                    engine
                        .preview(&input.options, input.width, input.rect)
                        .map(|v| json!(v))
                }
                "export" => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct Export {
                        job_id: String,
                        path: String,
                        kind: String,
                        #[serde(default)]
                        reviewed: Vec<u32>,
                    }
                    let input: Export =
                        serde_json::from_value(request.args).map_err(|_| "无效的导出请求。")?;
                    if input.reviewed.len() > 5000 {
                        return Err("复核列表超过限制。".into());
                    }
                    engine.export(&input.job_id, &input.path, &input.kind, &input.reviewed)
                }
                "status" => Ok(json!({"ready":true,"inputBytes":engine.input_bytes()})),
                _ => Err("不支持的对比请求。".into()),
            }
        })();
        send(Reply::response(request.id, result));
    }
    Ok(())
}
