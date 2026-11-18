// SPDX-License-Identifier: MIT OR Apache-2.0
mod client;
mod difference;
mod engine;
mod report_image;
mod registration;
mod quality;
#[cfg(test)]
mod tests;
#[cfg(test)] mod phase_two_tests;
#[cfg(test)] mod normalized_tests;
mod types;
mod worker;

use client::Client;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, State};

pub struct Backend {
    client: Arc<Mutex<Client>>,
    guard: Arc<AtomicBool>,
}
impl Backend {
    pub fn new(path: PathBuf) -> Self {
        Self {
            client: Arc::new(Mutex::new(Client::new(path))),
            guard: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn reset(&self) {
        if let Ok(mut c) = self.client.lock() {
            c.reset()
        }
    }
}
fn compare_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "compare" {
        Err("此命令仅允许图纸对比工作区。".into())
    } else {
        Ok(())
    }
}
fn local_url(url: &tauri::Url) -> bool {
    (matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("tauri.localhost" | "ipc.localhost")))
        || (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
}
fn safe_navigation(url: &tauri::Url) -> bool {
    if local_url(url) {
        return true;
    }
    #[cfg(debug_assertions)]
    if url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(1420) {
        return true;
    }
    false
}

#[tauri::command]
pub async fn compare_call(
    window: tauri::WebviewWindow,
    state: State<'_, Backend>,
    command: String,
    args: Value,
) -> Result<Value, String> {
    compare_window(&window)?;
    if !state.guard.load(Ordering::Acquire) {
        return Err("外部资源阻断尚未就绪，暂不读取图纸。请关闭对比窗口后重试。".into());
    }
    if !["open", "open_project", "save_project", "clear", "preview", "page_preview", "text_assist", "start", "cancel", "export", "export_batch", "status"].contains(&command.as_str()) {
        return Err("无效的对比命令。".into());
    }
    let client = state.client.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let rx = client
            .lock()
            .map_err(|_| "对比进程状态异常。")?
            .send(command, args)?;
        Client::wait(rx)
    })
    .await
    .map_err(|_| "对比请求未完成。".to_owned())?
}
#[tauri::command]
pub fn compare_poll(
    window: tauri::WebviewWindow,
    state: State<'_, Backend>,
) -> Result<Value, String> {
    compare_window(&window)?;
    let c = state.client.lock().map_err(|_| "对比状态不可用。")?;
    let progress = c.progress.lock().map_err(|_| "对比状态不可用。")?.clone();
    Ok(json!({"guardReady":state.guard.load(Ordering::Acquire),"progress":progress}))
}
#[tauri::command]
pub async fn compare_reset(
    window: tauri::WebviewWindow,
    state: State<'_, Backend>,
) -> Result<(), String> {
    compare_window(&window)?;
    let client = state.client.clone();
    tauri::async_runtime::spawn_blocking(move || {
        client.lock().map_err(|_| "对比状态不可用。")?.reset();
        Ok(())
    })
    .await
    .map_err(|_| "无法停止对比进程。".to_owned())?
}
#[tauri::command]
pub fn compare_close(window: tauri::WebviewWindow) -> Result<(), String> {
    compare_window(&window)?;
    window
        .destroy()
        .map_err(|_| "无法关闭对比工作区。".to_owned())
}

#[tauri::command]
// WebView2 window construction must run from an asynchronous Tauri command on
// Windows; a synchronous UI-thread command can deadlock its COM initialization.
pub async fn open_compare_workspace(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, Backend>,
    language: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅主工作区可打开图纸对比入口。".into());
    }
    if let Some(existing) = app.get_webview_window("compare") {
        let _ = existing.show();
        let _ = existing.unminimize();
        return existing
            .set_focus()
            .map_err(|_| "无法聚焦对比工作区。".into());
    }
    state.guard.store(false, Ordering::Release);
    let language = if language.as_deref() == Some("en-US") {
        "en-US"
    } else {
        "zh-CN"
    };
    let url = format!("compare.html?lang={language}");
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "无法准备对比界面目录。")?
        .join("compare-webview");
    let window=tauri::WebviewWindowBuilder::new(&app,"compare",tauri::WebviewUrl::App(url.into()))
        .title("Jerrivell PDF · 图纸对比").inner_size(1480.0,940.0).min_inner_size(1100.0,740.0).center()
        .data_directory(data_dir).incognito(true).on_navigation(safe_navigation)
        .additional_browser_args("--disable-background-networking --disable-component-update --disable-domain-reliability --disable-sync --no-pings --disable-features=MediaRouter,OptimizationHints")
        .build().map_err(|_|"无法打开独立对比窗口。")?;
    #[cfg(windows)]
    {
        crate::window_style::match_app_titlebar(&window);
        let guard = state.guard.clone();
        window.with_webview(move|view|{use webview2_com::{WebResourceRequestedEventHandler,Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL};use windows::core::{HSTRING,PWSTR};
            let result=(||->windows::core::Result<()>{unsafe{
                let webview=view.controller().CoreWebView2()?;let environment=view.environment();webview.AddWebResourceRequestedFilter(&HSTRING::from("*"),COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?;
                let mut token=0_i64;webview.add_WebResourceRequested(&WebResourceRequestedEventHandler::create(Box::new(move|_,args|{
                    if let Some(args)=args{let mut text=PWSTR::null();args.Request()?.Uri(&mut text)?;let uri=text.to_string().unwrap_or_default();windows::Win32::System::Com::CoTaskMemFree(Some(text.0.cast()));
                        let allowed=tauri::Url::parse(&uri).ok().is_some_and(|url|safe_navigation(&url));if !allowed{let response=environment.CreateWebResourceResponse(None,403,&HSTRING::from("Offline comparison"),&HSTRING::from("Content-Type: text/plain\r\nCache-Control: no-store"))?;args.SetResponse(&response)?;}}
                    Ok(())
                })),&mut token)?;Ok(())}})();guard.store(result.is_ok(),Ordering::Release);
        }).map_err(|_|"无法启用对比界面离线保护。")?;
    }
    Ok(())
}

pub fn worker_entry(args: &[std::ffi::OsString]) -> Option<i32> {
    if !args.get(1).is_some_and(|arg| arg == "--compare-worker") {
        return None;
    }
    if args.len() != 4 || args[2] != "--pdfium-path" {
        return Some(2);
    }
    Some(if worker::run(&PathBuf::from(&args[3])).is_ok() {
        0
    } else {
        2
    })
}
