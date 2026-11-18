use crate::engine::PdfEngine;
use crate::model::{WorkerRequest, WorkerResponse};
use pdfium_render::prelude::Pdfium;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

const MAX_REQUEST_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 104 * 1024 * 1024;

/// The same executable enters this mode before starting any GUI/runtime threads.
pub fn run_worker(library_path: &Path) -> Result<(), String> {
    if !library_path.is_absolute() {
        return Err("PDFium 动态库必须是受控绝对路径。".into());
    }
    let library_path = library_path
        .canonicalize()
        .map_err(|e| format!("找不到 PDFium 动态库：{e}"))?;
    let bindings =
        Pdfium::bind_to_library(&library_path).map_err(|e| format!("无法加载 PDFium：{e}"))?;
    let pdfium = Pdfium::new(bindings);
    let mut engine = PdfEngine::new(&pdfium);
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    loop {
        let mut line = String::new();
        let length = (&mut input)
            .take(MAX_REQUEST_BYTES + 1)
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        if length == 0 {
            return Ok(());
        }
        if length as u64 > MAX_REQUEST_BYTES || !line.ends_with('\n') {
            return Err("PDF 工作进程请求过大或不完整。".into());
        }
        let response = match serde_json::from_str::<WorkerRequest>(&line) {
            Ok(request) => match engine.dispatch(&request) {
                Ok(result) => WorkerResponse {
                    id: request.id,
                    result: Some(result),
                    error: None,
                },
                Err(error) => WorkerResponse {
                    id: request.id,
                    result: None,
                    error: Some(error),
                },
            },
            Err(error) => WorkerResponse {
                id: 0,
                result: None,
                error: Some(format!("请求格式无效：{error}")),
            },
        };
        serde_json::to_writer(&mut output, &response).map_err(|e| e.to_string())?;
        output.write_all(b"\n").map_err(|e| e.to_string())?;
        output.flush().map_err(|e| e.to_string())?;
    }
}

struct RunningWorker {
    child: Child,
    input: ChildStdin,
    responses: Receiver<Result<String, String>>,
}

impl Drop for RunningWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct WorkerClient {
    library_path: PathBuf,
    worker: Option<RunningWorker>,
    next_id: u64,
}

impl WorkerClient {
    pub fn library_path(&self) -> &Path {
        &self.library_path
    }

    pub fn new(library_path: PathBuf) -> Self {
        Self {
            library_path,
            worker: None,
            next_id: 1,
        }
    }

    fn start(&mut self) -> Result<(), String> {
        if self.worker.is_some() {
            return Ok(());
        }
        let library_path = self
            .library_path
            .canonicalize()
            .map_err(|e| format!("PDFium 引擎资源缺失，请重新安装完整应用：{e}"))?;
        let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        command
            .arg("--pdf-worker")
            .arg("--pdfium-path")
            .arg(library_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动 PDF 工作进程：{e}"))?;
        let input = match child.stdin.take() {
            Some(input) => input,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("无法建立 PDF 请求通道。".into());
            }
        };
        let output = match child.stdout.take() {
            Some(output) => output,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("无法建立 PDF 响应通道。".into());
            }
        };
        let (sender, responses) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut output = BufReader::new(output);
            loop {
                let mut line = String::new();
                let response = match (&mut output)
                    .take(MAX_RESPONSE_BYTES + 1)
                    .read_line(&mut line)
                {
                    Ok(0) => Err("PDF 工作进程已退出。".into()),
                    Ok(length) if length as u64 > MAX_RESPONSE_BYTES || !line.ends_with('\n') => {
                        Err("PDF 工作进程返回了过大或不完整的响应。".into())
                    }
                    Ok(_) => Ok(line),
                    Err(error) => Err(format!("无法读取 PDF 工作进程响应：{error}")),
                };
                let failed = response.is_err();
                if sender.send(response).is_err() || failed {
                    break;
                }
            }
        });
        self.worker = Some(RunningWorker {
            child,
            input,
            responses,
        });
        Ok(())
    }

    pub fn reset(&mut self) {
        self.worker = None;
    }

    fn invalidate(&mut self, reason: impl std::fmt::Display) -> String {
        self.reset();
        format!("SESSION_INVALIDATED: {reason} 所有来源文档会话已失效，请重新打开 PDF。")
    }

    pub fn request<T: DeserializeOwned>(
        &mut self,
        command: &str,
        args: Value,
    ) -> Result<T, String> {
        self.start()?;
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        let request = WorkerRequest {
            id,
            command: command.into(),
            args,
        };
        let mut encoded = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
        if encoded.len() as u64 >= MAX_REQUEST_BYTES {
            return Err("请求超出大小限制。".into());
        }
        encoded.push(b'\n');
        let worker = self.worker.as_mut().unwrap();
        if let Err(error) = worker
            .input
            .write_all(&encoded)
            .and_then(|_| worker.input.flush())
        {
            return Err(self.invalidate(format!("PDF 工作进程通信失败：{error}")));
        }
        let timeout = if matches!(
            command,
            "save_document" | "search_document" | "search_pages" | "open_document"
        ) {
            Duration::from_secs(120)
        } else {
            Duration::from_secs(45)
        };
        let raw = match worker.responses.recv_timeout(timeout) {
            Ok(Ok(raw)) => raw,
            Ok(Err(error)) => return Err(self.invalidate(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(self.invalidate("PDF 处理超时，已停止工作进程。"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(self.invalidate("PDF 工作进程连接已断开。"))
            }
        };
        let response: WorkerResponse = match serde_json::from_str(&raw) {
            Ok(response) => response,
            Err(error) => return Err(self.invalidate(format!("PDF 响应无法解析：{error}"))),
        };
        if response.id != id {
            return Err(self.invalidate("PDF 响应序号不匹配。"));
        }
        if let Some(error) = response.error {
            return Err(error);
        }
        // JSON null is a valid result for close_all_documents.
        serde_json::from_value(response.result.unwrap_or(Value::Null))
            .map_err(|error| self.invalidate(format!("PDF 响应结构无效：{error}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_library_before_loading_native_code() {
        assert!(run_worker(Path::new("pdfium.dll"))
            .unwrap_err()
            .contains("绝对路径"));
    }

    #[test]
    fn reports_missing_engine_without_spawning() {
        let directory = tempfile::tempdir().unwrap();
        let mut client = WorkerClient::new(directory.path().join("missing.dll"));
        let result: Result<Value, _> = client.request("get_backend_status", Value::Null);
        assert!(result.unwrap_err().contains("引擎资源缺失"));
        assert!(client.worker.is_none());
    }
}
