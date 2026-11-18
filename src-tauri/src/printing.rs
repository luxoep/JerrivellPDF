// SPDX-License-Identifier: MIT OR Apache-2.0
//! Windows printing uses a separate process and a prepared PDF snapshot.
//!
//! Native driver dialogs and GDI may block for an arbitrary amount of time. They
//! must not occupy the ordinary PDF worker's request/response timeout channel.

use crate::model::{PageRef, SavedDocument};
use crate::worker::WorkerClient;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const MAX_SNAPSHOT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_WORKER_MESSAGE: u64 = 64 * 1024;
const MAX_PRINTED_SHEETS: usize = 10_000;
const MAX_BITMAP_PIXELS: f64 = 16.0 * 1024.0 * 1024.0;
const MAX_BITMAP_SIDE: f64 = 8192.0;

#[derive(Debug, Copy, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PrintScale {
    Fit,
    Actual,
}

#[derive(Debug, Copy, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PrintOrientation {
    Auto,
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrintOptions {
    pub scale: PrintScale,
    pub orientation: PrintOrientation,
    pub copies: u16,
}

impl PrintOptions {
    fn validate(&self, page_count: usize) -> Result<(), String> {
        if !(1..=99).contains(&self.copies) {
            return Err("PRINT_ERROR: 打印份数必须在 1～99 之间。".into());
        }
        if page_count == 0 || page_count > 5000 {
            return Err("PRINT_ERROR: 请选择 1～5000 页进行打印。".into());
        }
        if page_count.saturating_mul(self.copies as usize) > MAX_PRINTED_SHEETS {
            return Err("PRINT_ERROR: 单次打印总页数（包含份数）不能超过 10000 页。".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintResult {
    /// "printed" means Windows accepted EndDoc, not that paper was delivered.
    pub status: String,
    pub page_count: u32,
    pub copies: u16,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrintWorkerJob {
    pdf_path: PathBuf,
    options: PrintOptions,
    owner: usize,
    job_name: String,
    /// CLI verification only. The application command never sets this field.
    /// Its presence hard-codes Microsoft Print to PDF and never uses a default
    /// or user-selected physical printer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    test_output_path: Option<PathBuf>,
    /// CLI-only raster verification; never opens a printer or submits a job.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    test_raster_directory: Option<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PrintWorkerReply {
    result: Option<PrintResult>,
    error: Option<String>,
}

/// Prepare the same page plan used by Save/Preview, then run the native dialog
/// and spooler work in an isolated child. Call this from a blocking task.
pub fn print_document(
    client: &mut WorkerClient,
    library_path: &Path,
    pages: Vec<PageRef>,
    options: PrintOptions,
    owner: usize,
    job_name: String,
) -> Result<PrintResult, String> {
    options.validate(pages.len())?;
    let directory = tempfile::Builder::new()
        .prefix("rivuleaf-print-")
        .tempdir()
        .map_err(|e| format!("PRINT_ERROR: 无法准备打印临时目录：{e}"))?;
    let snapshot = directory.path().join("document.pdf");
    let _: SavedDocument = client.request(
        "save_document",
        json!({"pages": pages, "outputPath": snapshot}),
    )?;
    let job = PrintWorkerJob {
        pdf_path: snapshot,
        options,
        owner,
        job_name: clean_job_name(&job_name),
        test_output_path: None,
        test_raster_directory: None,
    };
    let result = launch_print_worker(library_path, &job);
    // directory lives through child completion, including native save dialogs.
    drop(directory);
    result
}

fn clean_job_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(160).collect();
    if name.trim().is_empty() {
        "Jerrivell PDF".into()
    } else {
        name
    }
}

fn launch_print_worker(library_path: &Path, job: &PrintWorkerJob) -> Result<PrintResult, String> {
    if !library_path.is_absolute() {
        return Err("PRINT_ERROR: PDFium 动态库必须使用受控绝对路径。".into());
    }
    let library_path = library_path
        .canonicalize()
        .map_err(|e| format!("PRINT_ERROR: PDFium 引擎资源缺失：{e}"))?;
    let mut message = serde_json::to_vec(job).map_err(|e| e.to_string())?;
    if message.len() as u64 >= MAX_WORKER_MESSAGE {
        return Err("PRINT_ERROR: 打印请求过大。".into());
    }
    message.push(b'\n');
    let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    command
        .arg("--print-worker")
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
        .map_err(|e| format!("PRINT_ERROR: 无法启动打印进程：{e}"))?;
    let sent = child
        .stdin
        .take()
        .ok_or_else(|| "无法建立打印请求通道。".to_string())
        .and_then(|mut input| input.write_all(&message).map_err(|e| e.to_string()));
    if let Err(error) = sent {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("PRINT_ERROR: {error}"));
    }
    let mut bytes = Vec::new();
    if let Some(output) = child.stdout.take() {
        if let Err(error) = output.take(MAX_WORKER_MESSAGE + 1).read_to_end(&mut bytes) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("PRINT_ERROR: 无法读取打印结果：{error}"));
        }
    }
    if bytes.len() as u64 > MAX_WORKER_MESSAGE {
        let _ = child.kill();
        let _ = child.wait();
        return Err("PRINT_ERROR: 打印进程响应超过限制。".into());
    }
    let status = child.wait().map_err(|e| format!("PRINT_ERROR: {e}"))?;
    if !status.success() {
        return Err("PRINT_ERROR: 打印进程异常结束；请检查 Windows 打印队列。".into());
    }
    let reply: PrintWorkerReply = serde_json::from_slice(&bytes)
        .map_err(|_| "PRINT_ERROR: 打印进程未返回有效结果。".to_string())?;
    if let Some(error) = reply.error {
        Err(error)
    } else {
        reply
            .result
            .ok_or_else(|| "PRINT_ERROR: 打印结果缺失。".into())
    }
}

/// Must run before Tauri initializes any GUI/runtime threads.
pub fn worker_entry(args: &[OsString]) -> Option<i32> {
    if !args.get(1).is_some_and(|arg| arg == "--print-worker") {
        return None;
    }
    if args.len() != 4 || args[2] != "--pdfium-path" {
        eprintln!("usage: --print-worker --pdfium-path <absolute DLL path>; JSON job on stdin");
        return Some(2);
    }
    let result = (|| {
        let mut input = Vec::new();
        std::io::stdin()
            .take(MAX_WORKER_MESSAGE + 1)
            .read_to_end(&mut input)
            .map_err(|e| format!("PRINT_ERROR: {e}"))?;
        if input.len() as u64 > MAX_WORKER_MESSAGE {
            return Err("PRINT_ERROR: 打印请求超过限制。".into());
        }
        let job: PrintWorkerJob = serde_json::from_slice(&input)
            .map_err(|e| format!("PRINT_ERROR: 打印请求无效：{e}"))?;
        native::run(&PathBuf::from(&args[3]), job)
    })();
    let reply = match result {
        Ok(result) => PrintWorkerReply {
            result: Some(result),
            error: None,
        },
        Err(error) => PrintWorkerReply {
            result: None,
            error: Some(error),
        },
    };
    let output = std::io::stdout();
    let mut output = output.lock();
    if serde_json::to_writer(&mut output, &reply).is_err()
        || output.write_all(b"\n").is_err()
        || output.flush().is_err()
    {
        return Some(2);
    }
    Some(0)
}

#[derive(Debug, Copy, Clone)]
struct PrinterMetrics {
    printable_width: i32,
    printable_height: i32,
    physical_width: i32,
    physical_height: i32,
    offset_x: i32,
    offset_y: i32,
    dpi_x: i32,
    dpi_y: i32,
}

#[derive(Debug, Copy, Clone)]
struct PageLayout {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    clipped: bool,
    scale: f64,
}

fn page_layout(
    width: f64,
    height: f64,
    metrics: PrinterMetrics,
    mode: PrintScale,
) -> Result<PageLayout, String> {
    if !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
        || width > 200_000.0
        || height > 200_000.0
    {
        return Err("PRINT_ERROR: 页面尺寸无效或超过限制。".into());
    }
    if [
        metrics.printable_width,
        metrics.printable_height,
        metrics.physical_width,
        metrics.physical_height,
        metrics.dpi_x,
        metrics.dpi_y,
    ]
    .iter()
    .any(|v| *v <= 0 || *v > 1_000_000)
        || metrics.offset_x < 0
        || metrics.offset_y < 0
        || metrics.printable_width + metrics.offset_x > metrics.physical_width + 2
        || metrics.printable_height + metrics.offset_y > metrics.physical_height + 2
    {
        return Err("PRINT_ERROR: 打印机返回了无效纸张尺寸或分辨率。".into());
    }
    let natural_width = width * metrics.dpi_x as f64 / 72.0;
    let natural_height = height * metrics.dpi_y as f64 / 72.0;
    let scale = if mode == PrintScale::Fit {
        (metrics.printable_width as f64 / natural_width)
            .min(metrics.printable_height as f64 / natural_height)
    } else {
        1.0
    };
    let width = (natural_width * scale).round().max(1.0) as i32;
    let height = (natural_height * scale).round().max(1.0) as i32;
    let (x, y) = if mode == PrintScale::Actual {
        (
            (metrics.physical_width - width) / 2 - metrics.offset_x,
            (metrics.physical_height - height) / 2 - metrics.offset_y,
        )
    } else {
        (
            (metrics.printable_width - width) / 2,
            (metrics.printable_height - height) / 2,
        )
    };
    Ok(PageLayout {
        x,
        y,
        width,
        height,
        clipped: x < 0
            || y < 0
            || x as i64 + width as i64 > metrics.printable_width as i64
            || y as i64 + height as i64 > metrics.printable_height as i64,
        scale,
    })
}

fn bitmap_size(width: f64, height: f64, print_scale: f64) -> Result<(i32, i32, bool), String> {
    if !width.is_finite()
        || !height.is_finite()
        || !print_scale.is_finite()
        || width <= 0.0
        || height <= 0.0
        || print_scale <= 0.0
    {
        return Err("PRINT_ERROR: 打印渲染尺寸无效。".into());
    }
    let wanted_width = width / 72.0 * 300.0 * print_scale;
    let wanted_height = height / 72.0 * 300.0 * print_scale;
    if !wanted_width.is_finite() || !wanted_height.is_finite() {
        return Err("PRINT_ERROR: 打印渲染尺寸无效。".into());
    }
    let reduction = 1.0_f64
        .min(MAX_BITMAP_SIDE / wanted_width)
        .min(MAX_BITMAP_SIDE / wanted_height)
        .min((MAX_BITMAP_PIXELS / (wanted_width * wanted_height)).sqrt());
    let output_width = (wanted_width * reduction).floor().max(1.0) as i32;
    let output_height = (wanted_height * reduction).floor().max(1.0) as i32;
    if output_width as f64 * output_height as f64 > MAX_BITMAP_PIXELS {
        return Err("PRINT_ERROR: 打印渲染超过像素限制。".into());
    }
    Ok((output_width, output_height, reduction < 0.999_999))
}

#[cfg(not(windows))]
mod native {
    use super::*;
    pub fn run(_: &Path, _: PrintWorkerJob) -> Result<PrintResult, String> {
        Err("PRINT_ERROR: 当前打印功能仅支持 Windows。".into())
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use pdfium_render::prelude::*;
    use std::ffi::c_void;
    use std::fs::File;
    use std::mem::{size_of, zeroed};
    use std::ptr::{null, null_mut};

    type Handle = *mut c_void;
    const PD_RETURNDC: u32 = 0x100;
    const PD_RETURNDEFAULT: u32 = 0x400;
    const PD_NOSELECTION: u32 = 4;
    const PD_NOPAGENUMS: u32 = 8;
    const PD_COLLATE: u32 = 0x10;
    const PD_HIDEPRINTTOFILE: u32 = 0x100000;
    const DM_ORIENTATION: u32 = 1;
    const DM_COPIES: u32 = 0x100;
    const DM_COLLATE: u32 = 0x8000;

    #[repr(C)]
    struct DevMode {
        device_name: [u16; 32],
        spec_version: u16,
        driver_version: u16,
        size: u16,
        driver_extra: u16,
        fields: u32,
        orientation: i16,
        paper_size: i16,
        paper_length: i16,
        paper_width: i16,
        scale: i16,
        copies: i16,
        default_source: i16,
        print_quality: i16,
        color: i16,
        duplex: i16,
        y_resolution: i16,
        tt_option: i16,
        collate: i16,
        form_name: [u16; 32],
        log_pixels: u16,
        remainder: [u32; 13],
    }

    #[repr(C)]
    struct PrintDlg {
        size: u32,
        owner: Handle,
        devmode: Handle,
        devnames: Handle,
        dc: Handle,
        flags: u32,
        from_page: u16,
        to_page: u16,
        min_page: u16,
        max_page: u16,
        copies: u16,
        instance: Handle,
        custom_data: isize,
        print_hook: Handle,
        setup_hook: Handle,
        print_template_name: *const u16,
        setup_template_name: *const u16,
        print_template: Handle,
        setup_template: Handle,
    }

    #[repr(C)]
    struct DocInfo {
        size: i32,
        name: *const u16,
        output: *const u16,
        data_type: *const u16,
        flags: u32,
    }

    #[repr(C)]
    struct BitmapInfoHeader {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_ppm: i32,
        y_ppm: i32,
        colors_used: u32,
        colors_important: u32,
    }

    #[repr(C)]
    struct BitmapInfo {
        header: BitmapInfoHeader,
        colors: [u32; 1],
    }

    #[link(name = "comdlg32")]
    unsafe extern "system" {
        fn PrintDlgW(dialog: *mut PrintDlg) -> i32;
        fn CommDlgExtendedError() -> u32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> Handle;
        fn GlobalLock(memory: Handle) -> *mut c_void;
        fn GlobalUnlock(memory: Handle) -> i32;
        fn GlobalFree(memory: Handle) -> Handle;
        fn GlobalSize(memory: Handle) -> usize;
        fn GetLastError() -> u32;
    }
    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn DeleteDC(dc: Handle) -> i32;
        fn CreateDCW(
            driver: *const u16,
            device: *const u16,
            output: *const u16,
            mode: *const DevMode,
        ) -> Handle;
        fn ResetDCW(dc: Handle, mode: *const DevMode) -> Handle;
        fn GetDeviceCaps(dc: Handle, index: i32) -> i32;
        fn StartDocW(dc: Handle, info: *const DocInfo) -> i32;
        fn EndDoc(dc: Handle) -> i32;
        fn AbortDoc(dc: Handle) -> i32;
        fn StartPage(dc: Handle) -> i32;
        fn EndPage(dc: Handle) -> i32;
        fn SetStretchBltMode(dc: Handle, mode: i32) -> i32;
        fn SetBrushOrgEx(dc: Handle, x: i32, y: i32, previous: *mut c_void) -> i32;
        fn StretchDIBits(
            dc: Handle,
            dx: i32,
            dy: i32,
            dw: i32,
            dh: i32,
            sx: i32,
            sy: i32,
            sw: i32,
            sh: i32,
            bits: *const c_void,
            info: *const BitmapInfo,
            usage: u32,
            operation: u32,
        ) -> i32;
    }
    #[link(name = "winspool")]
    unsafe extern "system" {
        fn OpenPrinterW(name: *mut u16, printer: *mut Handle, defaults: *const c_void) -> i32;
        fn ClosePrinter(printer: Handle) -> i32;
        fn DocumentPropertiesW(
            owner: Handle,
            printer: Handle,
            device: *mut u16,
            output: *mut DevMode,
            input: *const DevMode,
            mode: u32,
        ) -> i32;
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    fn failure(action: &str) -> String {
        // SAFETY: GetLastError has no pointer parameters.
        format!("PRINT_ERROR: {action}（Windows 错误 {}）。", unsafe {
            GetLastError()
        })
    }

    struct PrinterDevice {
        dc: Handle,
        devmode: Handle,
        devnames: Handle,
        copies: u16,
        collate: bool,
        started: bool,
    }

    impl Drop for PrinterDevice {
        fn drop(&mut self) {
            // SAFETY: All non-null handles are owned by this value. An incomplete
            // StartDoc is aborted before releasing its DC; EndDoc clears started.
            unsafe {
                if !self.dc.is_null() {
                    if self.started {
                        AbortDoc(self.dc);
                    }
                    DeleteDC(self.dc);
                }
                if !self.devmode.is_null() {
                    GlobalFree(self.devmode);
                }
                if !self.devnames.is_null() {
                    GlobalFree(self.devnames);
                }
            }
        }
    }

    /// Lock and validate the public DEVMODE prefix without discarding any
    /// printer-driver-private bytes following it.
    fn with_mode<T>(
        memory: Handle,
        operation: impl FnOnce(&mut DevMode) -> Result<T, String>,
    ) -> Result<T, String> {
        if memory.is_null() {
            return Err("PRINT_ERROR: 打印机没有提供可用的纸张设置。".into());
        }
        // SAFETY: GlobalSize/GlobalLock receive the handle returned by PrintDlg
        // or GlobalAlloc. The lock is released on every Result path.
        unsafe {
            let length = GlobalSize(memory);
            if length < size_of::<DevMode>() {
                return Err("PRINT_ERROR: 打印机纸张设置长度无效。".into());
            }
            let pointer = GlobalLock(memory) as *mut DevMode;
            if pointer.is_null() {
                return Err(failure("无法读取打印机设置"));
            }
            let result = if (*pointer).size as usize >= size_of::<DevMode>()
                && (*pointer).size as usize + (*pointer).driver_extra as usize <= length
            {
                operation(&mut *pointer)
            } else {
                Err("PRINT_ERROR: 打印机返回的 DEVMODE 结构无效。".into())
            };
            GlobalUnlock(memory);
            result
        }
    }

    fn configure_mode(mode: &mut DevMode, orientation: i16) {
        mode.fields |= DM_ORIENTATION | DM_COPIES | DM_COLLATE;
        mode.orientation = orientation;
        // Application-side copies and collation, never driver-side duplication.
        mode.copies = 1;
        mode.collate = 0;
    }

    fn choose_device(
        job: &PrintWorkerJob,
        first_orientation: i16,
    ) -> Result<Option<PrinterDevice>, String> {
        if let Some(output) = &job.test_output_path {
            validate_test_output(output, &job.pdf_path)?;
            return test_pdf_device(job, first_orientation).map(Some);
        }
        // SAFETY: PRINTDLGW is plain C data. Its pointer fields start null.
        let mut dialog: PrintDlg = unsafe { zeroed() };
        dialog.size = size_of::<PrintDlg>() as u32;
        dialog.owner = job.owner as Handle;
        dialog.flags = PD_RETURNDEFAULT;
        // Best effort default DEVMODE, so our initial orientation can be shown
        // in Properties. Even if no default exists, the actual dialog may let
        // the user select a different available printer.
        unsafe {
            PrintDlgW(&mut dialog);
        }
        if !dialog.devmode.is_null() {
            let _ = with_mode(dialog.devmode, |mode| {
                configure_mode(mode, first_orientation);
                Ok(())
            });
        }
        dialog.flags =
            PD_RETURNDC | PD_NOSELECTION | PD_NOPAGENUMS | PD_COLLATE | PD_HIDEPRINTTOFILE;
        dialog.from_page = 1;
        dialog.to_page = 1;
        dialog.min_page = 1;
        dialog.max_page = 1;
        dialog.copies = job.options.copies;
        // SAFETY: All handles in dialog either null or owned global blocks from
        // the preceding PrintDlgW. No hook callbacks or custom templates used.
        let accepted = unsafe { PrintDlgW(&mut dialog) };
        let device = PrinterDevice {
            dc: dialog.dc,
            devmode: dialog.devmode,
            devnames: dialog.devnames,
            copies: dialog.copies,
            collate: dialog.flags & PD_COLLATE != 0,
            started: false,
        };
        if accepted == 0 {
            let code = unsafe { CommDlgExtendedError() };
            return if code == 0 {
                Ok(None)
            } else {
                Err(format!(
                    "PRINT_ERROR: 无法打开系统打印对话框（错误 {code}）。"
                ))
            };
        }
        if device.dc.is_null() {
            return Err("PRINT_ERROR: 未获得打印机设备上下文。".into());
        }
        Ok(Some(device))
    }

    fn validate_test_output(output: &Path, input: &Path) -> Result<(), String> {
        if !output.is_absolute()
            || !output
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("pdf"))
        {
            return Err("PRINT_ERROR: 虚拟打印验收输出必须是绝对 .pdf 路径。".into());
        }
        if output.exists() || output == input {
            return Err("PRINT_ERROR: 虚拟打印验收拒绝覆盖任何已有文件。".into());
        }
        if !output.parent().is_some_and(|p| p.is_dir()) {
            return Err("PRINT_ERROR: 虚拟打印验收输出目录不存在。".into());
        }
        Ok(())
    }

    fn test_pdf_device(job: &PrintWorkerJob, orientation: i16) -> Result<PrinterDevice, String> {
        // This verification-only path intentionally has no configurable printer
        // name. It can never submit to the user's default physical printer.
        let mut name = wide("Microsoft Print to PDF");
        let mut printer: Handle = null_mut();
        // SAFETY: Output handle and UTF-16 name buffers live through the calls.
        if unsafe { OpenPrinterW(name.as_mut_ptr(), &mut printer, null()) } == 0 {
            return Err(failure("Microsoft Print to PDF 虚拟打印机不可用"));
        }
        let needed = unsafe {
            DocumentPropertiesW(
                null_mut(),
                printer,
                name.as_mut_ptr(),
                null_mut(),
                null(),
                0,
            )
        };
        if needed <= 0 {
            let code = unsafe { GetLastError() };
            unsafe {
                ClosePrinter(printer);
            }
            return Err(format!("PRINT_ERROR: Microsoft Print to PDF 驱动设置读取失败（Windows 错误 {code}）。请检查或修复该虚拟打印机；未创建打印任务。"));
        }
        if needed < size_of::<DevMode>() as i32 || needed > 1024 * 1024 {
            unsafe {
                ClosePrinter(printer);
            }
            return Err("PRINT_ERROR: 虚拟打印机返回了无效设置长度。".into());
        }
        let memory = unsafe { GlobalAlloc(0x42, needed as usize) }; // movable + zeroed
        if memory.is_null() {
            unsafe {
                ClosePrinter(printer);
            }
            return Err(failure("无法分配打印机设置"));
        }
        let mut device = PrinterDevice {
            dc: null_mut(),
            devmode: memory,
            devnames: null_mut(),
            copies: job.options.copies,
            collate: true,
            started: false,
        };
        let mode = unsafe { GlobalLock(memory) as *mut DevMode };
        if mode.is_null() {
            unsafe {
                ClosePrinter(printer);
            }
            return Err(failure("无法读取虚拟打印机设置"));
        }
        let result =
            unsafe { DocumentPropertiesW(null_mut(), printer, name.as_mut_ptr(), mode, null(), 2) }; // DM_OUT_BUFFER
        unsafe {
            GlobalUnlock(memory);
            ClosePrinter(printer);
        }
        if result != 1 {
            return Err("PRINT_ERROR: 无法取得虚拟打印机设置。".into());
        }
        device.dc = with_mode(memory, |mode| {
            configure_mode(mode, orientation);
            let driver = wide("WINSPOOL");
            let dc = unsafe { CreateDCW(driver.as_ptr(), name.as_ptr(), null(), mode) };
            if dc.is_null() {
                Err(failure("无法连接虚拟打印机"))
            } else {
                Ok(dc)
            }
        })?;
        Ok(device)
    }

    fn desired_orientation(options: &PrintOptions, width: f64, height: f64) -> i16 {
        match options.orientation {
            PrintOrientation::Portrait => 1,
            PrintOrientation::Landscape => 2,
            PrintOrientation::Auto if width > height => 2,
            PrintOrientation::Auto => 1,
        }
    }

    fn metrics(dc: Handle) -> PrinterMetrics {
        // SAFETY: Called with a live printer DC, between ResetDC and StartPage.
        unsafe {
            PrinterMetrics {
                printable_width: GetDeviceCaps(dc, 8),
                printable_height: GetDeviceCaps(dc, 10),
                physical_width: GetDeviceCaps(dc, 110),
                physical_height: GetDeviceCaps(dc, 111),
                offset_x: GetDeviceCaps(dc, 112),
                offset_y: GetDeviceCaps(dc, 113),
                dpi_x: GetDeviceCaps(dc, 88),
                dpi_y: GetDeviceCaps(dc, 90),
            }
        }
    }

    /// Shared by real GDI printing and the explicitly requested headless check.
    /// Raw PDFium buffers default to RGB byte order in this wrapper, whereas a
    /// Win32 BI_RGB DIB requires BGR: this setting must stay explicitly false.
    fn render_bgra(page: &PdfPage<'_>, width: i32, height: i32) -> Result<Vec<u8>, String> {
        let config = PdfRenderConfig::new()
            .set_target_size(width, height)
            .set_format(PdfBitmapFormat::BGRA)
            .set_reverse_byte_order(false)
            .set_clear_color(PdfColor::WHITE)
            .render_form_data(false)
            .render_annotations(true)
            .use_print_quality(true)
            .limit_render_image_cache_size(true);
        let bitmap = page
            .render_with_config(&config)
            .map_err(|e| format!("PRINT_ERROR: 页面打印渲染失败：{e}"))?;
        let pixels = bitmap.as_raw_bytes();
        if bitmap.width() != width
            || bitmap.height() != height
            || pixels.len() != width as usize * height as usize * 4
        {
            return Err("PRINT_ERROR: 打印渲染图像尺寸不一致。".into());
        }
        Ok(pixels)
    }

    fn check_rasters(
        document: &PdfDocument<'_>,
        directory: &Path,
        options: &PrintOptions,
    ) -> Result<PrintResult, String> {
        use image::{DynamicImage, ImageFormat, RgbaImage};
        use std::fs::{self, OpenOptions};
        use std::io::Cursor;
        if !directory.is_absolute() || !directory.is_dir() {
            return Err("PRINT_ERROR: 打印栅格验收必须指定已存在的绝对目录。".into());
        }
        if fs::read_dir(directory)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
        {
            return Err("PRINT_ERROR: 打印栅格验收只写入空目录，不覆盖已有文件。".into());
        }
        let count = document.pages().len() as usize;
        if count > 16 {
            return Err("PRINT_ERROR: 单次打印栅格验收最多 16 页。".into());
        }
        let mut records = Vec::new();
        let mut total = 0_u64;
        for index in 0..count {
            let page = document
                .pages()
                .get(index as i32)
                .map_err(|e| e.to_string())?;
            let width_pt = page.width().value as f64;
            let height_pt = page.height().value as f64;
            // Apply the production geometry validator before sampling. The
            // synthetic metrics do not claim any installed printer's margins.
            let synthetic = PrinterMetrics {
                printable_width: 5000,
                printable_height: 7000,
                physical_width: 5000,
                physical_height: 7000,
                offset_x: 0,
                offset_y: 0,
                dpi_x: 600,
                dpi_y: 600,
            };
            page_layout(width_pt, height_pt, synthetic, PrintScale::Actual)?;
            let (width, height, reduced) = bitmap_size(width_pt, height_pt, 1.0)?;
            let mut pixels = render_bgra(&page, width, height)?;
            // Convert the exact GDI buffer to a PNG for independent inspection.
            for pixel in pixels.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
            let image = RgbaImage::from_raw(width as u32, height as u32, pixels)
                .ok_or("PRINT_ERROR: 验收图像结构无效。")?;
            let mut encoded = Cursor::new(Vec::new());
            DynamicImage::ImageRgba8(image)
                .write_to(&mut encoded, ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            let encoded = encoded.into_inner();
            total += encoded.len() as u64;
            if total > 256 * 1024 * 1024 {
                return Err("PRINT_ERROR: 验收图像输出超过 256 MiB。".into());
            }
            let name = format!("page-{}.png", index + 1);
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory.join(&name))
                .and_then(|mut file| file.write_all(&encoded))
                .map_err(|e| e.to_string())?;
            records.push(json!({"page": index + 1, "file": name, "width": width,
                "height": height, "pageWidthPoints": width_pt, "pageHeightPoints": height_pt,
                "samplingDpi": 300, "reducedByBudget": reduced}));
        }
        let manifest = json!({"status": "rendered", "createdSpoolJob": false,
            "configuration": "Production PDFium print config; opaque BGRA; print quality; 300dpi bounded sampling",
            "pages": records});
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join("rasters.json"))
            .and_then(|mut file| file.write_all(&serde_json::to_vec_pretty(&manifest).unwrap()))
            .map_err(|e| e.to_string())?;
        Ok(PrintResult {
            status: "rendered".into(),
            page_count: count as u32,
            copies: options.copies,
            warnings: vec!["仅完成打印栅格验收，未打开打印机或创建 Windows 打印任务。".into()],
        })
    }

    pub fn run(library_path: &Path, job: PrintWorkerJob) -> Result<PrintResult, String> {
        if !library_path.is_absolute() || !job.pdf_path.is_absolute() {
            return Err("PRINT_ERROR: 打印运行库与快照必须使用绝对路径。".into());
        }
        let library_path = library_path
            .canonicalize()
            .map_err(|e| format!("PRINT_ERROR: {e}"))?;
        let file =
            File::open(&job.pdf_path).map_err(|e| format!("PRINT_ERROR: 无法读取打印快照：{e}"))?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_SNAPSHOT_BYTES {
            return Err("PRINT_ERROR: 打印快照为空或超过 512 MiB。".into());
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_SNAPSHOT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
            return Err("PRINT_ERROR: 打印快照读取超过限制。".into());
        }
        let bindings = Pdfium::bind_to_library(&library_path)
            .map_err(|e| format!("PRINT_ERROR: 无法加载 PDFium：{e}"))?;
        let pdfium = Pdfium::new(bindings);
        let document = pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|e| format!("PRINT_ERROR: 打印快照无法打开：{e}"))?;
        let count = document.pages().len() as usize;
        job.options.validate(count)?;
        if let Some(directory) = &job.test_raster_directory {
            if job.test_output_path.is_some() {
                return Err("PRINT_ERROR: 栅格验收与虚拟打印输出不能同时请求。".into());
            }
            return check_rasters(&document, directory, &job.options);
        }
        let first = document.pages().get(0).map_err(|e| e.to_string())?;
        let first_orientation = desired_orientation(
            &job.options,
            first.width().value as f64,
            first.height().value as f64,
        );
        drop(first);
        let Some(mut device) = choose_device(&job, first_orientation)? else {
            return Ok(PrintResult {
                status: "cancelled".into(),
                page_count: count as u32,
                copies: job.options.copies,
                warnings: Vec::new(),
            });
        };
        let final_options = PrintOptions {
            copies: device.copies,
            ..job.options.clone()
        };
        final_options.validate(count)?;
        // ResetDC is required even for the first page: the system dialog may
        // have changed its DEVMODE, and driver-side copies must be cleared.
        with_mode(device.devmode, |mode| {
            configure_mode(mode, first_orientation);
            let dc = unsafe { ResetDCW(device.dc, mode) };
            if dc.is_null() {
                Err(failure("无法应用打印机设置"))
            } else {
                device.dc = dc;
                Ok(())
            }
        })?;
        let name = wide(&clean_job_name(&job.job_name));
        let output = job
            .test_output_path
            .as_ref()
            .map(|p| wide(&p.to_string_lossy()));
        let info = DocInfo {
            size: size_of::<DocInfo>() as i32,
            name: name.as_ptr(),
            output: output.as_ref().map_or(null(), |x| x.as_ptr()),
            data_type: null(),
            flags: 0,
        };
        // SAFETY: All strings and the DOCINFOW structure outlive StartDocW.
        if unsafe { StartDocW(device.dc, &info) } <= 0 {
            let code = unsafe { GetLastError() };
            if matches!(code, 63 | 1223) {
                return Ok(PrintResult {
                    status: "cancelled".into(),
                    page_count: count as u32,
                    copies: device.copies,
                    warnings: Vec::new(),
                });
            }
            return Err(format!(
                "PRINT_ERROR: 无法开始打印任务（Windows 错误 {code}）。"
            ));
        }
        device.started = true;
        let mut clipped = false;
        let mut reduced = false;
        let mut previous_orientation = first_orientation;
        for sheet in 0..count * device.copies as usize {
            let index = if device.collate {
                sheet % count
            } else {
                sheet / device.copies as usize
            };
            let page = document
                .pages()
                .get(index as i32)
                .map_err(|e| format!("PRINT_ERROR: {e}"))?;
            let page_width = page.width().value as f64;
            let page_height = page.height().value as f64;
            let orientation = desired_orientation(&job.options, page_width, page_height);
            if orientation != previous_orientation {
                with_mode(device.devmode, |mode| {
                    configure_mode(mode, orientation);
                    let dc = unsafe { ResetDCW(device.dc, mode) };
                    if dc.is_null() {
                        Err(failure("无法切换打印纸张方向"))
                    } else {
                        device.dc = dc;
                        Ok(())
                    }
                })?;
                previous_orientation = orientation;
            }
            let layout = page_layout(
                page_width,
                page_height,
                metrics(device.dc),
                job.options.scale,
            )?;
            clipped |= layout.clipped;
            let (width, height, did_reduce) = bitmap_size(page_width, page_height, layout.scale)?;
            reduced |= did_reduce;
            let pixels = render_bgra(&page, width, height)?;
            let bitmap_info = BitmapInfo {
                header: BitmapInfoHeader {
                    size: size_of::<BitmapInfoHeader>() as u32,
                    width,
                    height: -height,
                    planes: 1,
                    bit_count: 32,
                    compression: 0,
                    size_image: pixels.len() as u32,
                    x_ppm: 0,
                    y_ppm: 0,
                    colors_used: 0,
                    colors_important: 0,
                },
                colors: [0],
            };
            // SAFETY: The opaque top-down BGRA bitmap has exactly width*height*4
            // bytes. Device rectangle uses printer pixels, independently from
            // raster sampling resolution, preserving actual millimetre sizes.
            unsafe {
                if StartPage(device.dc) <= 0 {
                    return Err(failure("无法开始打印页面"));
                }
                SetStretchBltMode(device.dc, 4); // HALFTONE
                SetBrushOrgEx(device.dc, 0, 0, null_mut());
                let lines = StretchDIBits(
                    device.dc,
                    layout.x,
                    layout.y,
                    layout.width,
                    layout.height,
                    0,
                    0,
                    width,
                    height,
                    pixels.as_ptr().cast(),
                    &bitmap_info,
                    0,
                    0x00CC0020,
                );
                if lines == 0 || lines == -1 {
                    return Err(failure("无法将页面发送到打印机"));
                }
                if EndPage(device.dc) <= 0 {
                    return Err(failure("打印页面被取消或失败"));
                }
            }
        }
        if unsafe { EndDoc(device.dc) } <= 0 {
            return Err(failure("打印任务未能提交或已被取消"));
        }
        device.started = false;
        let mut warnings = Vec::new();
        if clipped {
            warnings.push("实际尺寸超出打印机可打印区域，边缘内容可能被裁切。".into());
        }
        if reduced {
            warnings.push("超大页面已按单页像素预算降低打印采样分辨率，物理尺寸保持不变。".into());
        }
        Ok(PrintResult {
            status: "printed".into(),
            page_count: count as u32,
            copies: device.copies,
            warnings,
        })
    }

    #[cfg(test)]
    #[test]
    fn win32_abi_sizes_match_windows_x64() {
        assert_eq!(size_of::<DevMode>(), 220);
        assert_eq!(size_of::<PrintDlg>(), 120);
        assert_eq!(size_of::<DocInfo>(), 40);
        assert_eq!(size_of::<BitmapInfoHeader>(), 40);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn printer() -> PrinterMetrics {
        PrinterMetrics {
            printable_width: 4800,
            printable_height: 6400,
            physical_width: 5100,
            physical_height: 6600,
            offset_x: 150,
            offset_y: 100,
            dpi_x: 600,
            dpi_y: 600,
        }
    }

    #[test]
    fn actual_size_uses_physical_paper_origin_and_keeps_millimetres() {
        let layout = page_layout(72.0, 144.0, printer(), PrintScale::Actual).unwrap();
        assert_eq!((layout.width, layout.height), (600, 1200));
        assert_eq!((layout.x, layout.y), (2100, 2600));
        assert!(!layout.clipped);
        let layout = page_layout(612.0, 792.0, printer(), PrintScale::Actual).unwrap();
        assert_eq!((layout.width, layout.height), (5100, 6600));
        assert_eq!((layout.x, layout.y), (-150, -100));
        assert!(layout.clipped);
    }

    #[test]
    fn fit_handles_asymmetric_printer_dpi_and_never_clips() {
        let mut metrics = printer();
        metrics.dpi_y = 300;
        metrics.physical_height = 3300;
        metrics.printable_height = 3200;
        metrics.offset_y = 50;
        let layout = page_layout(612.0, 792.0, metrics, PrintScale::Fit).unwrap();
        assert_eq!((layout.width, layout.height), (4800, 3106));
        assert!(!layout.clipped);
        assert!((layout.scale - 4800.0 / 5100.0).abs() < 1e-9);
    }

    #[test]
    fn printing_rejects_bad_geometry_and_bounds_large_page_allocations() {
        assert!(page_layout(f64::NAN, 12.0, printer(), PrintScale::Fit).is_err());
        assert!(page_layout(0.0, 12.0, printer(), PrintScale::Actual).is_err());
        let mut invalid = printer();
        invalid.dpi_x = 0;
        assert!(page_layout(72.0, 72.0, invalid, PrintScale::Fit).is_err());
        let (width, height, reduced) = bitmap_size(200_000.0, 100_000.0, 1.0).unwrap();
        assert!(reduced);
        assert!(width <= 8192 && height <= 8192);
        assert!((width as u64) * height as u64 <= 16 * 1024 * 1024);
        assert!((width as f64 / height as f64 - 2.0).abs() < 0.002);
        assert!(bitmap_size(72.0, 72.0, f64::INFINITY).is_err());
        assert_eq!(bitmap_size(72.0, 144.0, 1.0).unwrap(), (300, 600, false));
        assert!(PrintOptions {
            scale: PrintScale::Fit,
            orientation: PrintOrientation::Auto,
            copies: 0
        }
        .validate(1)
        .is_err());
        assert!(PrintOptions {
            scale: PrintScale::Fit,
            orientation: PrintOrientation::Auto,
            copies: 99
        }
        .validate(5000)
        .is_err());
        assert!(PrintOptions {
            scale: PrintScale::Fit,
            orientation: PrintOrientation::Auto,
            copies: 1
        }
        .validate(0)
        .is_err());
    }
}
