mod engine;
#[cfg(windows)]
mod font_source;
#[cfg(windows)]
mod fonts;
mod model;
#[cfg(windows)]
mod printing;
mod startup;
#[cfg(windows)]
mod window_style;
#[cfg(windows)]
mod windows_integration;
mod worker;

use model::*;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

struct Backend(Arc<Mutex<worker::WorkerClient>>);

#[tauri::command]
fn get_startup_files() -> Vec<String> {
    startup::pdf_paths(std::env::args_os())
}

#[tauri::command]
async fn register_pdf_integration() -> Result<windows_integration::IntegrationStatus, String> {
    tauri::async_runtime::spawn_blocking(windows_integration::register_pdf_integration)
        .await
        .map_err(|e| format!("WINDOWS_INTEGRATION_ERROR: {e}"))?
}

#[tauri::command]
async fn open_default_pdf_settings() -> Result<windows_integration::IntegrationStatus, String> {
    tauri::async_runtime::spawn_blocking(windows_integration::open_default_pdf_settings)
        .await
        .map_err(|e| format!("WINDOWS_INTEGRATION_ERROR: {e}"))?
}

#[tauri::command]
async fn preview_image_edit(
    state: State<'_, Backend>,
    asset_id: String,
    crop: Option<PdfStampCrop>,
    strokes: Vec<EraseStroke>,
) -> Result<Value, String> {
    call(
        state,
        "preview_image_edit",
        json!({"assetId":asset_id,"crop":crop,"strokes":strokes}),
    )
    .await
}

#[tauri::command]
async fn list_system_fonts() -> Result<fonts::SystemFonts, String> {
    tauri::async_runtime::spawn_blocking(fonts::list_system_fonts)
        .await
        .map_err(|_| "本机字体读取任务失败，请重试。".to_string())?
}

#[tauri::command]
async fn print_document(
    window: tauri::WebviewWindow,
    state: State<'_, Backend>,
    pages: Vec<PageRef>,
    options: printing::PrintOptions,
    job_name: String,
) -> Result<printing::PrintResult, String> {
    let owner = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    let client = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut client = client
            .lock()
            .map_err(|_| "PDF 服务状态异常，请重启应用。".to_string())?;
        let library = client.library_path().to_path_buf();
        printing::print_document(&mut client, &library, pages, options, owner, job_name)
    })
    .await
    .map_err(|e| format!("打印任务失败：{e}"))?
}

async fn call<T: DeserializeOwned + Send + 'static>(
    state: State<'_, Backend>,
    command: &'static str,
    args: Value,
) -> Result<T, String> {
    let client = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        client
            .lock()
            .map_err(|_| "PDF 服务状态异常，请重启应用。".to_string())?
            .request(command, args)
    })
    .await
    .map_err(|e| format!("PDF 后台任务失败：{e}"))?
}

#[tauri::command]
async fn get_backend_status(state: State<'_, Backend>) -> Result<BackendStatus, String> {
    Ok(match call(state, "get_backend_status", Value::Null).await {
        Ok(status) => status,
        Err(error) => BackendStatus {
            engine_ready: false,
            engine_version: None,
            message: Some(error),
        },
    })
}

#[tauri::command]
async fn open_document(
    state: State<'_, Backend>,
    path: String,
    password: Option<String>,
) -> Result<DocumentInfo, String> {
    call(
        state,
        "open_document",
        json!({"path": path, "password": password}),
    )
    .await
}

#[tauri::command]
async fn render_page(
    state: State<'_, Backend>,
    page: PageRef,
    target_width: u32,
) -> Result<RenderedPage, String> {
    call(
        state,
        "render_page",
        json!({"page": page, "targetWidth": target_width}),
    )
    .await
}

#[tauri::command]
async fn render_page_layers(
    state: State<'_, Backend>,
    page: PageRef,
    target_width: u32,
) -> Result<RenderedPageLayers, String> {
    call(
        state,
        "render_page_layers",
        json!({"page": page, "targetWidth": target_width}),
    )
    .await
}

#[tauri::command]
async fn search_document(
    state: State<'_, Backend>,
    document_id: String,
    query: String,
) -> Result<Vec<SearchMatch>, String> {
    call(
        state,
        "search_document",
        json!({"documentId": document_id, "query": query}),
    )
    .await
}

#[tauri::command]
async fn inspect_page_content(
    state: State<'_, Backend>,
    page: PageRef,
) -> Result<PageContent, String> {
    call(state, "inspect_page_content", json!({"page": page})).await
}

#[tauri::command]
async fn search_pages(
    state: State<'_, Backend>,
    pages: Vec<PageRef>,
    query: String,
) -> Result<Vec<SearchMatch>, String> {
    call(
        state,
        "search_pages",
        json!({"pages": pages, "query": query}),
    )
    .await
}

#[tauri::command]
async fn save_document(
    state: State<'_, Backend>,
    output_path: String,
    pages: Vec<PageRef>,
) -> Result<SavedDocument, String> {
    call(
        state,
        "save_document",
        json!({"outputPath": output_path, "pages": pages}),
    )
    .await
}

#[tauri::command]
async fn prepare_export(
    state: State<'_, Backend>,
    parts: Vec<ExportPart>,
) -> Result<Value, String> {
    call(state, "prepare_export", json!({"parts":parts})).await
}
#[tauri::command]
async fn validate_document(
    state: State<'_, Backend>,
    pages: Vec<PageRef>,
) -> Result<Value, String> {
    call(state, "validate_document", json!({"pages":pages})).await
}
#[tauri::command]
async fn save_prepared_export(
    state: State<'_, Backend>,
    token: String,
    paths: Vec<String>,
) -> Result<Value, String> {
    call(
        state,
        "save_prepared_export",
        json!({"token":token,"paths":paths}),
    )
    .await
}
#[tauri::command]
async fn discard_export(state: State<'_, Backend>, token: String) -> Result<Value, String> {
    call(state, "discard_export", json!({"token":token})).await
}
#[tauri::command]
async fn generate_pages(
    state: State<'_, Backend>,
    request: GeneratePages,
) -> Result<DocumentInfo, String> {
    call(state, "generate_pages", json!({"request":request})).await
}
#[tauri::command]
async fn preview_line_edit(
    state: State<'_, Backend>,
    request: LineEditRequest,
) -> Result<Value, String> {
    call(state, "preview_line_edit", json!({"request":request})).await
}
#[tauri::command]
async fn commit_line_preview(
    state: State<'_, Backend>,
    token: String,
) -> Result<DocumentInfo, String> {
    call(state, "commit_line_preview", json!({"token":token})).await
}
#[tauri::command]
async fn discard_line_preview(state: State<'_, Backend>, token: String) -> Result<Value, String> {
    call(state, "discard_line_preview", json!({"token":token})).await
}

#[tauri::command]
async fn export_page(
    state: State<'_, Backend>,
    page: PageRef,
    target_width: u32,
    output_path: String,
) -> Result<ExportedPage, String> {
    call(
        state,
        "export_page",
        json!({"page": page, "targetWidth": target_width, "outputPath": output_path}),
    )
    .await
}

#[tauri::command]
async fn register_image(
    state: State<'_, Backend>,
    data_url: String,
) -> Result<ImageAssetInfo, String> {
    call(state, "register_image", json!({"dataUrl": data_url})).await
}

#[tauri::command]
async fn preview_image(state: State<'_, Backend>, path: String) -> Result<Value, String> {
    call(state, "preview_image", json!({"path":path})).await
}

#[tauri::command]
async fn import_image(state: State<'_, Backend>, path: String) -> Result<ImageAssetInfo, String> {
    call(state, "import_image", json!({"path": path})).await
}

#[tauri::command]
async fn edit_image_asset(
    state: State<'_, Backend>,
    asset_id: String,
    crop: Option<PdfStampCrop>,
    strokes: Vec<EraseStroke>,
) -> Result<ImageAssetInfo, String> {
    call(
        state,
        "edit_image_asset",
        json!({"assetId":asset_id,"crop":crop,"strokes":strokes}),
    )
    .await
}

#[tauri::command]
async fn get_image_asset(
    state: State<'_, Backend>,
    asset_id: String,
) -> Result<ImageAssetInfo, String> {
    call(state, "get_image_asset", json!({"assetId":asset_id})).await
}
#[tauri::command]
async fn rasterize_page_asset(
    state: State<'_, Backend>,
    page: PageRef,
) -> Result<ImageAssetInfo, String> {
    call(state, "rasterize_page_asset", json!({"page":page})).await
}

#[tauri::command]
async fn extract_content_image(
    state: State<'_, Backend>,
    page: PageRef,
    object_index: u32,
    fingerprint: String,
) -> Result<ImageAssetInfo, String> {
    call(
        state,
        "extract_content_image",
        json!({"page":page,"objectIndex":object_index,"fingerprint":fingerprint}),
    )
    .await
}

#[tauri::command]
async fn render_object_layers(
    state: State<'_, Backend>,
    page: PageRef,
    object_index: u32,
    fingerprint: String,
    target_width: u32,
) -> Result<ObjectPreviewLayers, String> {
    call(state,"render_object_layers",json!({"page":page,"objectIndex":object_index,"fingerprint":fingerprint,"targetWidth":target_width})).await
}

#[tauri::command]
async fn import_pdf_stamp(
    state: State<'_, Backend>,
    path: String,
    page_index: u32,
    remove_white_background: bool,
    trim_transparent_margins: bool,
    crop: Option<PdfStampCrop>,
) -> Result<PdfStampInfo, String> {
    call(
        state,
        "import_pdf_stamp",
        json!({"path": path, "pageIndex": page_index, "removeWhiteBackground": remove_white_background, "trimTransparentMargins": trim_transparent_margins, "crop": crop}),
    )
    .await
}

#[tauri::command]
async fn export_image(
    state: State<'_, Backend>,
    asset_id: String,
    output_path: String,
) -> Result<ExportedPage, String> {
    call(
        state,
        "export_image",
        json!({"assetId": asset_id, "outputPath": output_path}),
    )
    .await
}

#[tauri::command]
async fn close_all_documents(state: State<'_, Backend>) -> Result<(), String> {
    // Closing also terminates a potentially unhealthy native process and releases its memory.
    let client = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        client
            .lock()
            .map_err(|_| "PDF 服务状态异常，请重启应用。".to_string())?
            .reset();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn worker_entry(args: &[std::ffi::OsString]) -> Option<i32> {
    #[cfg(windows)]
    if let Some(result) = printing::worker_entry(args) {
        return Some(result);
    }
    if !args.get(1).is_some_and(|arg| arg == "--pdf-worker") {
        return None;
    }
    if args.len() != 4 || args[2] != "--pdfium-path" {
        eprintln!("usage: --pdf-worker --pdfium-path <absolute DLL path>");
        return Some(2);
    }
    match worker::run_worker(&PathBuf::from(&args[3])) {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("{error}");
            Some(2)
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window_style::match_app_titlebar(&window);
            }
            let resource = app
                .path()
                .resource_dir()?
                .join("pdfium")
                .join("bin")
                .join("pdfium.dll");
            #[cfg(debug_assertions)]
            let library_path = if resource.is_file() {
                resource
            } else {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/pdfium/bin/pdfium.dll")
            };
            #[cfg(not(debug_assertions))]
            let library_path = resource;
            app.manage(Backend(Arc::new(Mutex::new(worker::WorkerClient::new(
                library_path,
            )))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_startup_files,
            register_pdf_integration,
            open_default_pdf_settings,
            preview_image_edit,
            get_backend_status,
            list_system_fonts,
            print_document,
            open_document,
            render_page,
            render_page_layers,
            search_document,
            search_pages,
            inspect_page_content,
            save_document,
            prepare_export,
            validate_document,
            save_prepared_export,
            discard_export,
            generate_pages,
            preview_line_edit,
            commit_line_preview,
            discard_line_preview,
            export_page,
            register_image,
            edit_image_asset,
            get_image_asset,
            rasterize_page_asset,
            extract_content_image,
            render_object_layers,
            import_image,
            preview_image,
            import_pdf_stamp,
            export_image,
            close_all_documents
        ])
        .build(tauri::generate_context!())
        .expect("无法启动 Jerrivell PDF 桌面应用");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app.try_state::<Backend>() {
                if let Ok(mut client) = state.0.lock() {
                    client.reset();
                }
            }
        }
    });
}
