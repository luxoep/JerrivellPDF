// SPDX-License-Identifier: MIT OR Apache-2.0
use super::types::*;
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
type Pending = Arc<Mutex<HashMap<u64, mpsc::SyncSender<Result<Value, String>>>>>;

#[cfg(windows)]
struct MemoryJob(usize);
#[cfg(windows)]
impl Drop for MemoryJob {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                self.0 as *mut _,
            ));
        }
    }
}
#[cfg(windows)]
fn limit(child: &Child) -> Result<MemoryJob, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::*,
    };
    unsafe {
        let job = CreateJobObjectW(None, None).map_err(|_| "无法建立对比进程资源限制。")?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.ProcessMemoryLimit = 1024 * 1024 * 1024;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        )
        .is_err()
            || AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())).is_err()
        {
            let _ = CloseHandle(job);
            return Err("无法限制对比进程内存，已停止启动；主工作区不受影响。".into());
        }
        Ok(MemoryJob(job.0 as usize))
    }
}
pub struct Client {
    pub library: PathBuf,
    child: Option<Child>,
    input: Option<ChildStdin>,
    next: u64,
    pending: Pending,
    pub progress: Arc<Mutex<Progress>>,
    #[cfg(windows)]
    job: Option<MemoryJob>,
}
impl Drop for Client {
    fn drop(&mut self) {
        self.reset();
    }
}
impl Client {
    pub fn new(library: PathBuf) -> Self {
        Self {
            library,
            child: None,
            input: None,
            next: 0,
            pending: Arc::new(Mutex::new(HashMap::new())),
            progress: Arc::new(Mutex::new(Progress::default())),
            #[cfg(windows)]
            job: None,
        }
    }
    pub fn reset(&mut self) {
        self.input.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        #[cfg(windows)]
        {
            self.job.take();
        }
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err("COMPARE_RESET: 对比进程已停止，请重新选择输入。".into()));
        }
        *self.progress.lock().unwrap() = Progress::default();
    }
    fn start(&mut self) -> Result<(), String> {
        if let Some(child) = self.child.as_mut() {
            if child
                .try_wait()
                .map_err(|_| "无法检查对比进程。")?
                .is_none()
            {
                return Ok(());
            }
            self.reset();
            return Err("COMPARE_RESET: 对比进程已结束，请重新选择图纸。".into());
        }
        let library = self
            .library
            .canonicalize()
            .map_err(|_| "对比引擎资源缺失，请重新安装完整程序。")?;
        let mut command = Command::new(std::env::current_exe().map_err(|_| "无法定位程序。")?);
        command
            .arg("--compare-worker")
            .arg("--pdfium-path")
            .arg(library)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // BELOW_NORMAL_PRIORITY_CLASS keeps the editor responsive during analysis.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08004000);
        }
        let mut child = command.spawn().map_err(|_| "无法启动独立对比进程。")?;
        #[cfg(windows)]
        {
            match limit(&child) {
                Ok(job) => self.job = Some(job),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            }
        }
        let output = child.stdout.take().ok_or("无法建立对比响应通道。")?;
        self.input = child.stdin.take();
        // Every worker owns its own pending map and progress. A dying old reader
        // must never invalidate a replacement worker or the main PDF backend.
        self.pending = Arc::new(Mutex::new(HashMap::new()));
        self.progress = Arc::new(Mutex::new(Progress::default()));
        let (pending, progress) = (self.pending.clone(), self.progress.clone());
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = String::new();
                match (&mut reader)
                    .take(48 * 1024 * 1024 + 1)
                    .read_line(&mut line)
                {
                    Ok(n) if n > 0 && n <= 48 * 1024 * 1024 && line.ends_with('\n') => {}
                    _ => break,
                };
                let Ok(reply) = serde_json::from_str::<Reply>(&line) else {
                    break;
                };
                if let Some(state) = reply.progress {
                    *progress.lock().unwrap() = state;
                }
                if let Some(id) = reply.id {
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(match reply.error {
                            Some(e) => Err(e),
                            None => Ok(reply.result.unwrap_or(Value::Null)),
                        });
                    }
                }
            }
            let mut state = progress.lock().unwrap();
            state.status = "failed".into();
            state.report = None;
            state.error = Some(
                "COMPARE_RESET: 对比进程已结束或达到资源限制，请重新选择输入；主工作区仍可使用。"
                    .into(),
            );
            drop(state);
            for (_, tx) in pending.lock().unwrap().drain() {
                let _ = tx.send(Err("COMPARE_RESET: 对比进程已结束，请重新选择输入。".into()));
            }
        });
        self.child = Some(child);
        Ok(())
    }
    /// Enqueue only. Waiting occurs outside the client mutex so cancel/poll are responsive.
    pub fn send(
        &mut self,
        command: String,
        args: Value,
    ) -> Result<mpsc::Receiver<Result<Value, String>>, String> {
        self.start()?;
        self.next += 1;
        let id = self.next;
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending.lock().unwrap().insert(id, tx);
        if command == "start" {
            *self.progress.lock().unwrap() = Progress {
                job_id: args
                    .get("jobId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                status: "running".into(),
                ..Progress::default()
            };
        }
        let bytes =
            serde_json::to_vec(&Request { id, command, args }).map_err(|_| "请求编码失败。")?;
        if bytes.len() >= 1024 * 1024 {
            self.pending.lock().unwrap().remove(&id);
            return Err("对比请求超过大小限制。".into());
        }
        let written = self
            .input
            .as_mut()
            .ok_or("对比通道不可用。")?
            .write_all(&bytes)
            .and_then(|_| self.input.as_mut().unwrap().write_all(b"\n"))
            .and_then(|_| self.input.as_mut().unwrap().flush());
        if written.is_err() {
            self.reset();
            return Err("COMPARE_RESET: 对比通道已关闭。".into());
        }
        Ok(rx)
    }
    pub fn wait(rx: mpsc::Receiver<Result<Value, String>>) -> Result<Value, String> {
        rx.recv_timeout(Duration::from_secs(90))
            .map_err(|_| "对比请求超时，请停止并重新选择文件。".to_owned())?
    }
}
