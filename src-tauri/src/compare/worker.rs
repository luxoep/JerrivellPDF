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
                #[serde(default)]
                task: String,
                #[serde(default)]
                pairs: Vec<Options>,
                #[serde(default)]
                auto_align: bool,
            }
            let parsed = serde_json::from_value::<Start>(request.args)
                .map_err(|_| "无效的对比任务参数。".to_owned())
                .and_then(|value| {
                    value.options.validate()?;
                    if !["", "compare", "align", "batch"].contains(&value.task.as_str()) {
                        return Err("无效的任务类型。".into());
                    }
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
            let progress = |completed, total| {
                send(Reply {
                    id: None,
                    result: None,
                    error: None,
                    progress: Some(Progress {
                        job_id: job_id.clone(),
                        status: "running".into(),
                        completed,
                        total,
                        ..Progress::default()
                    }),
                })
            };
            let mut state = Progress {
                job_id: job_id.clone(),
                ..Progress::default()
            };
            let result = match input.task.as_str() {
                "align" => engine
                    .auto_align(&input.options, &token, progress)
                    .map(|a| {
                        state.alignment = Some(a);
                        state.completed = 100;
                        state.total = 100
                    }),
                "batch" => engine
                    .compare_batch(
                        input.job_id,
                        input.pairs,
                        input.auto_align,
                        &token,
                        progress,
                    )
                    .map(|b| {
                        state.completed = b.items.len() as u32;
                        state.total = state.completed;
                        state.batch = Some(b)
                    }),
                _ => engine
                    .compare(input.job_id, input.options, &token, progress)
                    .map(|r| {
                        state.completed = r.tile_count;
                        state.total = r.tile_count;
                        state.report = Some(r)
                    }),
            };
            match result {
                Ok(()) => state.status = "complete".into(),
                Err(error) => {
                    state.status = if error == "COMPARE_CANCELLED" {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                    if error != "COMPARE_CANCELLED" {
                        state.error = Some(error)
                    }
                }
            }
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
                "clear" => {
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Clear {
                        side: String,
                    }
                    let v: Clear =
                        serde_json::from_value(request.args).map_err(|_| "无效的清除请求。")?;
                    engine.clear(&v.side)
                }
                "page_preview" => {
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct PagePreview {
                        side: String,
                        page: u32,
                        width: u32,
                    }
                    let v: PagePreview =
                        serde_json::from_value(request.args).map_err(|_| "无效的单页预览参数。")?;
                    engine
                        .page_preview(&v.side, v.page, v.width)
                        .map(|p| json!(p))
                }
                "text_assist" => {
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Text {
                        options: Options,
                    }
                    let v: Text =
                        serde_json::from_value(request.args).map_err(|_| "无效的文字辅助请求。")?;
                    engine.text_assist(&v.options)
                }
                "export_batch" => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct ExportBatch {
                        job_id: String,
                        path: String,
                    }
                    let v: ExportBatch =
                        serde_json::from_value(request.args).map_err(|_| "无效的批量导出请求。")?;
                    engine.export_batch(&v.job_id, &v.path)
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
