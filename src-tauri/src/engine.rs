use crate::model::*;
use base64::Engine as _;
use image::{DynamicImage, ImageFormat};
use pdfium_render::prelude::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

mod assets;
mod content;
mod export;
mod operations;
mod preview;
use assets::ImageAsset;

pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SESSION_BYTES: u64 = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SOURCES: usize = 32;
const MAX_PAGES: usize = 5000;
const MAX_RENDER_SIDE: u32 = 8192;
const MAX_RENDER_PIXELS: u64 = 16 * 1024 * 1024;
const MAX_PNG_BYTES: usize = 72 * 1024 * 1024;
const MAX_SEARCH_CHARS: usize = 2_000_000;

struct Source<'a> {
    document: PdfDocument<'a>,
    path: Option<PathBuf>,
    size: u64,
}

pub struct PdfEngine<'a> {
    pdfium: &'a Pdfium,
    sources: HashMap<String, Source<'a>>,
    next_id: u64,
    assets: HashMap<String, ImageAsset>,
    next_asset_id: u64,
    content_fonts:
        std::cell::RefCell<HashMap<String, std::sync::Arc<crate::font_source::EditableFont>>>,
    prepared_export: Option<export::PreparedExport>,
    prepared_line: Option<operations::PreparedLine>,
    next_job: u64,
    protected_inputs: Vec<PathBuf>,
}

fn pdf_error(error: impl std::fmt::Display) -> String {
    format!("PDF 处理失败：{error}")
}

fn validate_rotation(rotation: u16) -> Result<(), String> {
    if matches!(rotation, 0 | 90 | 180 | 270) {
        Ok(())
    } else {
        Err("旋转角度只能为 0、90、180 或 270 度。".into())
    }
}

fn rotation(value: u16) -> PdfPageRenderRotation {
    match value % 360 {
        90 => PdfPageRenderRotation::Degrees90,
        180 => PdfPageRenderRotation::Degrees180,
        270 => PdfPageRenderRotation::Degrees270,
        _ => PdfPageRenderRotation::None,
    }
}

fn valid_page_size(width: f32, height: f32) -> Result<(), String> {
    if width.is_finite()
        && height.is_finite()
        && width > 0.0
        && height > 0.0
        && width <= 200_000.0
        && height <= 200_000.0
    {
        Ok(())
    } else {
        Err("页面尺寸无效或超出当前版本限制。".into())
    }
}

fn render_dimensions(
    width: f32,
    height: f32,
    requested: u32,
    quarter_turn: bool,
) -> Result<(u32, u32), String> {
    valid_page_size(width, height)?;
    if requested == 0 || requested > 4096 {
        return Err("预览或导出的宽度必须在 1～4096 像素之间。".into());
    }
    let scale = requested as f64
        / if quarter_turn {
            height as f64
        } else {
            width as f64
        };
    let w = (width as f64 * scale).round().max(1.0) as u64;
    let h = (height as f64 * scale).round().max(1.0) as u64;
    if w > MAX_RENDER_SIDE as u64
        || h > MAX_RENDER_SIDE as u64
        || w.saturating_mul(h) > MAX_RENDER_PIXELS
    {
        return Err("页面渲染超过像素限制，请降低缩放或导出宽度。".into());
    }
    Ok((w as u32, h as u32))
}

impl<'a> PdfEngine<'a> {
    pub fn new(pdfium: &'a Pdfium) -> Self {
        Self {
            pdfium,
            sources: HashMap::new(),
            next_id: 1,
            assets: HashMap::new(),
            next_asset_id: 1,
            content_fonts: Default::default(),
            prepared_export: None,
            prepared_line: None,
            next_job: 1,
            protected_inputs: Vec::new(),
        }
    }

    pub fn open_document(
        &mut self,
        path: &str,
        password: Option<&str>,
    ) -> Result<DocumentInfo, String> {
        if self
            .sources
            .values()
            .filter(|source| source.path.is_some())
            .count()
            >= MAX_SOURCES
            || self.sources.len() >= 128
        {
            return Err("当前最多同时打开 32 个来源文件，请先关闭工作区。".into());
        }
        if password.is_some_and(|p| p.len() > 1024) {
            return Err("密码过长。".into());
        }
        let path = fs::canonicalize(path).map_err(|e| format!("无法打开文件：{e}"))?;
        let file = File::open(&path).map_err(|e| format!("无法读取文件：{e}"))?;
        let metadata = file.metadata().map_err(pdf_error)?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FILE_BYTES {
            return Err("请选择非空 PDF 文件；当前单个文件上限为 256 MiB。".into());
        }
        let total: u64 = self.sources.values().map(|s| s.size).sum();
        if total + metadata.len() > MAX_SESSION_BYTES {
            return Err("已打开文件总大小超过 512 MiB，请先关闭工作区。".into());
        }
        // Own a snapshot so later edits to the source on disk cannot change this session.
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(pdf_error)?;
        if bytes.len() as u64 > MAX_FILE_BYTES || total + bytes.len() as u64 > MAX_SESSION_BYTES {
            return Err("读取期间文件大小超过限制。".into());
        }
        let file_size = bytes.len() as u64;
        let document = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, password)
            .map_err(|e| match e {
                PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
                    "PASSWORD_REQUIRED: 此 PDF 需要正确密码才能打开。".to_string()
                }
                other => format!("无法打开 PDF，文件可能已损坏或格式不受支持。详情：{other}"),
            })?;
        let count = document.pages().len();
        if count <= 0 || count as usize > MAX_PAGES {
            return Err("PDF 页数无效；当前单个文件最多支持 5000 页。".into());
        }
        let mut pages = Vec::with_capacity(count as usize);
        for index in 0..count {
            let page = document.pages().get(index).map_err(pdf_error)?;
            let width = page.width().value;
            let height = page.height().value;
            valid_page_size(width, height)?;
            pages.push(PageInfo {
                index: index as u32,
                width,
                height,
                rotation: page.rotation().map_err(pdf_error)?.as_degrees() as u16,
            });
        }
        let id = format!("{}-{}", std::process::id(), self.next_id);
        self.next_id += 1;
        let file_name = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut warnings = vec![
            "页面另存为新 PDF；原文件保持不变。书签、附件、交互表单、加密和数字签名不保证保留。"
                .into(),
        ];
        if document.signatures().len() > 0 {
            warnings.push("此文件包含数字签名；页面编辑另存不能保留原签名有效性。".into());
        }
        let info = DocumentInfo {
            id: id.clone(),
            path: path.to_string_lossy().into_owned(),
            file_name,
            page_count: count as u32,
            file_size,
            pages,
            warnings,
        };
        self.sources.insert(
            id,
            Source {
                document,
                path: Some(path),
                size: file_size,
            },
        );
        Ok(info)
    }

    fn source(&self, reference: &PageRef) -> Result<&Source<'a>, String> {
        validate_rotation(reference.rotation)?;
        self.validate_output_overlay_budget(std::slice::from_ref(reference))?;
        let source = self.sources.get(&reference.document_id).ok_or_else(|| {
            "SESSION_INVALIDATED: 来源文档已关闭或工作进程已重启，请重新打开 PDF。".to_string()
        })?;
        if reference.page_index >= source.document.pages().len() as u32 {
            return Err("页面索引超出来源文件范围。".into());
        }
        Ok(source)
    }

    fn render_image(&self, reference: &PageRef, target_width: u32) -> Result<DynamicImage, String> {
        let source = self.source(reference)?;
        if !reference.overlays.is_empty()
            || !reference.content_edits.is_empty()
            || !reference.decorations.is_empty()
        {
            let mut temporary = self.pdfium.create_new_pdf().map_err(pdf_error)?;
            self.copy_prepared_page(&mut temporary, reference, 0)?;
            let page = temporary.pages().get(0).map_err(pdf_error)?;
            let (width, height) =
                render_dimensions(page.width().value, page.height().value, target_width, false)?;
            let config = PdfRenderConfig::new()
                .set_target_size(width as i32, height as i32)
                .render_form_data(false)
                .render_annotations(true);
            return page
                .render_with_config(&config)
                .map_err(pdf_error)?
                .as_image()
                .map_err(pdf_error);
        }
        let mut page = source
            .document
            .pages()
            .get(reference.page_index as i32)
            .map_err(pdf_error)?;
        let intrinsic = page.rotation().map_err(pdf_error)?;
        // Render with the same native page rotation that a saved copy will use.
        // Rotating an already-rasterized bitmap changes glyph hinting/antialiasing.
        // The serial worker restores this temporary in-memory change on every Result path.
        if reference.rotation != 0 {
            page.set_rotation(rotation(intrinsic.as_degrees() as u16 + reference.rotation));
        }
        let rendered = (|| {
            let (width, height) =
                render_dimensions(page.width().value, page.height().value, target_width, false)?;
            let config = PdfRenderConfig::new()
                .set_target_size(width as i32, height as i32)
                .render_form_data(false)
                .render_annotations(true);
            let bitmap = page.render_with_config(&config).map_err(pdf_error)?;
            bitmap.as_image().map_err(pdf_error)
        })();
        if reference.rotation != 0 {
            page.set_rotation(intrinsic);
        }
        rendered
    }

    fn png(&self, reference: &PageRef, target_width: u32) -> Result<(Vec<u8>, u32, u32), String> {
        let image = self.render_image(reference, target_width)?;
        let (width, height) = (image.width(), image.height());
        let mut bytes = Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, ImageFormat::Png)
            .map_err(pdf_error)?;
        let bytes = bytes.into_inner();
        if bytes.len() > MAX_PNG_BYTES {
            return Err("生成图片超过大小限制。".into());
        }
        Ok((bytes, width, height))
    }

    pub fn render_page(&self, page: &PageRef, target_width: u32) -> Result<RenderedPage, String> {
        let (bytes, width, height) = self.png(page, target_width)?;
        Ok(RenderedPage {
            data_url: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
            width,
            height,
        })
    }

    pub fn search_document(
        &self,
        document_id: &str,
        query: &str,
    ) -> Result<Vec<SearchMatch>, String> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        if query.chars().count() > 256 {
            return Err("搜索词最多 256 个字符。".into());
        }
        let source = self
            .sources
            .get(document_id)
            .ok_or_else(|| "SESSION_INVALIDATED: 来源文档已关闭，请重新打开。".to_string())?;
        let query = query.to_lowercase();
        let mut matches = Vec::new();
        for index in 0..source.document.pages().len() {
            let page = source.document.pages().get(index).map_err(pdf_error)?;
            let text = page.text().map_err(pdf_error)?;
            if text.len() as usize > MAX_SEARCH_CHARS {
                return Err("页面文字量超过搜索限制。".into());
            }
            let original = content::visible_text(&page, &text)?;
            let lower = original.to_lowercase();
            let match_count = lower.matches(&query).count();
            if match_count > 0 {
                // Character slicing avoids cutting UTF-8 in the middle of Chinese text.
                let offset = lower
                    .find(&query)
                    .map(|i| lower[..i].chars().count())
                    .unwrap_or(0);
                let preview: String = original
                    .chars()
                    .skip(offset.saturating_sub(35))
                    .take(150)
                    .collect();
                matches.push(SearchMatch {
                    page_index: index as u32,
                    match_count,
                    preview: preview.replace(['\r', '\n'], " "),
                });
            }
        }
        Ok(matches)
    }

    /// Search the actual workspace plans, including distinct edits to copies of
    /// the same source page. page_index in these results is the workspace index.
    pub fn search_pages(&self, pages: &[PageRef], query: &str) -> Result<Vec<SearchMatch>, String> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        if pages.is_empty() || pages.len() > MAX_PAGES {
            return Err("搜索工作区必须包含 1～5000 页。".into());
        }
        if query.chars().count() > 256 {
            return Err("搜索词最多 256 个字符。".into());
        }
        let query = query.to_lowercase();
        let mut matches = Vec::new();
        for (index, reference) in pages.iter().enumerate() {
            let original = self.page_content_text(reference)?;
            if original.chars().count() > MAX_SEARCH_CHARS {
                return Err("页面文字量超过搜索限制。".into());
            }
            let lower = original.to_lowercase();
            let count = lower.matches(&query).count();
            if count > 0 {
                let offset = lower
                    .find(&query)
                    .map(|i| lower[..i].chars().count())
                    .unwrap_or(0);
                let preview: String = original
                    .chars()
                    .skip(offset.saturating_sub(35))
                    .take(150)
                    .collect();
                matches.push(SearchMatch {
                    page_index: index as u32,
                    match_count: count,
                    preview: preview.replace(['\r', '\n'], " "),
                });
            }
        }
        Ok(matches)
    }

    fn destination(&self, output_path: &str, extension: &str) -> Result<PathBuf, String> {
        let requested = Path::new(output_path);
        if !requested.is_absolute() {
            return Err("输出文件必须使用绝对路径。".into());
        }
        if !requested
            .extension()
            .is_some_and(|x| x.to_string_lossy().eq_ignore_ascii_case(extension))
        {
            return Err(format!("输出文件扩展名必须为 .{extension}。"));
        }
        let parent = requested
            .parent()
            .ok_or("输出目录无效。")?
            .canonicalize()
            .map_err(|e| format!("输出目录不可用：{e}"))?;
        let name = requested.file_name().ok_or("输出文件名无效。")?;
        let path = parent.join(name);
        if path.is_dir() {
            return Err("输出路径不能是目录。".into());
        }
        for source in self.sources.values() {
            let Some(source_path) = &source.path else {
                continue;
            };
            let same_path = source_path
                .to_string_lossy()
                .eq_ignore_ascii_case(&path.to_string_lossy());
            let same_file =
                path.exists() && same_file::is_same_file(source_path, &path).unwrap_or(true);
            if same_path || same_file {
                return Err(
                    "为保护原文件，不能覆盖任何已打开的来源 PDF，请使用其他文件名。".into(),
                );
            }
        }
        self.protect_asset_source(&path)?;
        for source in &self.protected_inputs {
            if source
                .to_string_lossy()
                .eq_ignore_ascii_case(&path.to_string_lossy())
                || (path.exists() && same_file::is_same_file(source, &path).unwrap_or(true))
            {
                return Err("不能覆盖用于图片转 PDF 的来源文件或其硬链接。".into());
            }
        }
        Ok(path)
    }

    pub fn save_document(
        &self,
        output_path: &str,
        pages: &[PageRef],
    ) -> Result<SavedDocument, String> {
        if pages.is_empty() || pages.len() > MAX_PAGES {
            return Err("输出必须包含 1～5000 页。".into());
        }
        let destination = self.destination(output_path, "pdf")?;
        self.validate_output_overlay_budget(pages)?;
        // Resolve the complete plan before touching an existing destination.
        for page in pages {
            self.source(page)?;
        }
        let mut output = self.pdfium.create_new_pdf().map_err(pdf_error)?;
        let mut content_fonts = content::ContentFontCache::default();
        for (index, reference) in pages.iter().enumerate() {
            self.copy_prepared_page_with_fonts(
                &mut output,
                reference,
                index as i32,
                &mut content_fonts,
            )?;
        }
        let mut temporary =
            NamedTempFile::new_in(destination.parent().unwrap()).map_err(pdf_error)?;
        let mut writer = LimitedWriter {
            file: temporary.as_file().try_clone().map_err(pdf_error)?,
            written: 0,
            limit: MAX_OUTPUT_BYTES,
        };
        output.save_to_writer(&mut writer).map_err(pdf_error)?;
        writer.flush().map_err(pdf_error)?;
        drop(writer);
        temporary.as_file_mut().sync_all().map_err(pdf_error)?;
        {
            let reopened = self
                .pdfium
                .load_pdf_from_file(temporary.path(), None)
                .map_err(|e| format!("保存结果验证失败：{e}"))?;
            if reopened.pages().len() as usize != pages.len() {
                return Err("保存结果页数校验失败。".into());
            }
            for (index, reference) in pages.iter().enumerate() {
                let page = reopened.pages().get(index as i32).map_err(pdf_error)?;
                let original = self
                    .source(reference)?
                    .document
                    .pages()
                    .get(reference.page_index as i32)
                    .map_err(pdf_error)?;
                let expected = (original.rotation().map_err(pdf_error)?.as_degrees() as u16
                    + reference.rotation)
                    % 360;
                if page.rotation().map_err(pdf_error)?.as_degrees() as u16 != expected {
                    return Err("保存结果页面方向校验失败。".into());
                }
            }
        }
        // Recheck source aliases immediately before the atomic replacement.
        self.destination(output_path, "pdf")?;
        temporary
            .persist(&destination)
            .map_err(|e| format!("无法提交保存结果，已有目标文件保持不变：{}", e.error))?;
        Ok(SavedDocument {
            path: destination.to_string_lossy().into_owned(),
            page_count: pages.len() as u32,
        })
    }

    pub fn export_page(
        &self,
        page: &PageRef,
        target_width: u32,
        output_path: &str,
    ) -> Result<ExportedPage, String> {
        let destination = self.destination(output_path, "png")?;
        let (bytes, width, height) = self.png(page, target_width)?;
        let decoded =
            image::load_from_memory_with_format(&bytes, ImageFormat::Png).map_err(pdf_error)?;
        if decoded.width() != width || decoded.height() != height {
            return Err("导出图片验证失败。".into());
        }
        drop(decoded);
        let mut temporary =
            NamedTempFile::new_in(destination.parent().unwrap()).map_err(pdf_error)?;
        temporary.write_all(&bytes).map_err(pdf_error)?;
        temporary.as_file_mut().sync_all().map_err(pdf_error)?;
        self.destination(output_path, "png")?;
        temporary
            .persist(&destination)
            .map_err(|e| format!("无法提交导出结果：{}", e.error))?;
        Ok(ExportedPage {
            path: destination.to_string_lossy().into_owned(),
        })
    }

    pub fn dispatch(&mut self, request: &WorkerRequest) -> Result<Value, String> {
        fn parse<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, String> {
            serde_json::from_value(args.clone()).map_err(|e| format!("请求参数无效：{e}"))
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Open {
            path: String,
            password: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Render {
            page: PageRef,
            target_width: u32,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Search {
            document_id: String,
            query: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Inspect {
            page: PageRef,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct SearchPages {
            pages: Vec<PageRef>,
            query: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Save {
            output_path: String,
            pages: Vec<PageRef>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Export {
            page: PageRef,
            target_width: u32,
            output_path: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct RegisterImage {
            data_url: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct ImportImage {
            path: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct ImportPdfStamp {
            path: String,
            page_index: u32,
            remove_white_background: bool,
            trim_transparent_margins: bool,
            crop: Option<PdfStampCrop>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct ExportImage {
            asset_id: String,
            output_path: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Prepare {
            parts: Vec<ExportPart>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Token {
            token: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct CommitExport {
            token: String,
            paths: Vec<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Generate {
            request: GeneratePages,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct EditLine {
            request: LineEditRequest,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Validate {
            pages: Vec<PageRef>,
        }
        match request.command.as_str() {
            "prepare_export" => {
                let p: Prepare = parse(&request.args)?;
                self.prepare_export(&p.parts)
            }
            "validate_document" => {
                let p: Validate = parse(&request.args)?;
                let document = self.prepare_document(&p.pages)?;
                Ok(json!({"pageCount":document.pages().len()}))
            }
            "save_prepared_export" => {
                let p: CommitExport = parse(&request.args)?;
                self.save_prepared_export(&p.token, &p.paths)
            }
            "discard_export" => {
                let p: Token = parse(&request.args)?;
                self.discard_export(&p.token);
                Ok(Value::Null)
            }
            "generate_pages" => {
                let p: Generate = parse(&request.args)?;
                self.generate_pages(&p.request).map(|v| json!(v))
            }
            "preview_line_edit" => {
                let p: EditLine = parse(&request.args)?;
                self.preview_line_edit(&p.request)
            }
            "commit_line_preview" => {
                let p: Token = parse(&request.args)?;
                self.commit_line_preview(&p.token).map(|v| json!(v))
            }
            "discard_line_preview" => {
                let p: Token = parse(&request.args)?;
                self.discard_line_preview(&p.token);
                Ok(Value::Null)
            }
            "get_backend_status" => Ok(json!(BackendStatus {
                engine_ready: true,
                engine_version: Some("PDFium 7881 · pdfium-render 0.9.4".into()),
                message: Some("本地 PDF 工作进程就绪".into())
            })),
            "open_document" => {
                let p: Open = parse(&request.args)?;
                self.open_document(&p.path, p.password.as_deref())
                    .map(|v| json!(v))
            }
            "render_page" => {
                let p: Render = parse(&request.args)?;
                self.render_page(&p.page, p.target_width).map(|v| json!(v))
            }
            "render_page_layers" => {
                let p: Render = parse(&request.args)?;
                self.render_page_layers(&p.page, p.target_width)
                    .map(|v| json!(v))
            }
            "search_document" => {
                let p: Search = parse(&request.args)?;
                self.search_document(&p.document_id, &p.query)
                    .map(|v| json!(v))
            }
            "inspect_page_content" => {
                let p: Inspect = parse(&request.args)?;
                self.inspect_page_content(&p.page).map(|v| json!(v))
            }
            "search_pages" => {
                let p: SearchPages = parse(&request.args)?;
                self.search_pages(&p.pages, &p.query).map(|v| json!(v))
            }
            "save_document" => {
                let p: Save = parse(&request.args)?;
                self.save_document(&p.output_path, &p.pages)
                    .map(|v| json!(v))
            }
            "export_page" => {
                let p: Export = parse(&request.args)?;
                self.export_page(&p.page, p.target_width, &p.output_path)
                    .map(|v| json!(v))
            }
            "register_image" => {
                let p: RegisterImage = parse(&request.args)?;
                self.register_image(&p.data_url).map(|v| json!(v))
            }
            "import_image" => {
                let p: ImportImage = parse(&request.args)?;
                self.import_image(&p.path).map(|v| json!(v))
            }
            "import_pdf_stamp" => {
                let p: ImportPdfStamp = parse(&request.args)?;
                self.import_pdf_stamp(
                    &p.path,
                    p.page_index,
                    p.remove_white_background,
                    p.trim_transparent_margins,
                    p.crop.as_ref(),
                )
                .map(|v| json!(v))
            }
            "export_image" => {
                let p: ExportImage = parse(&request.args)?;
                self.export_image(&p.asset_id, &p.output_path)
                    .map(|v| json!(v))
            }
            "close_all_documents" => {
                self.sources.clear();
                self.assets.clear();
                self.content_fonts.borrow_mut().clear();
                self.prepared_export = None;
                self.prepared_line = None;
                self.protected_inputs.clear();
                Ok(Value::Null)
            }
            _ => Err("未知 PDF 工作进程命令。".into()),
        }
    }
}

struct LimitedWriter {
    file: File,
    written: u64,
    limit: u64,
}
impl Write for LimitedWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.written.saturating_add(bytes.len() as u64) > self.limit {
            return Err(std::io::Error::other("输出 PDF 超过 512 MiB 限制"));
        }
        let count = self.file.write(bytes)?;
        self.written += count as u64;
        Ok(count)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

#[cfg(test)]
mod tests;
