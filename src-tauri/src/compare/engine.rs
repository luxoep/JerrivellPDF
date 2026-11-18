// SPDX-License-Identifier: MIT OR Apache-2.0
use super::{
    difference::{classify, paint_runs, Components, Run},
    types::*,
};
use base64::Engine as _;
use image::{DynamicImage, ImageFormat, RgbaImage};
use pdfium_render::prelude::*;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

const TILE: u32 = 1024;
const MAX_INPUT: u64 = 128 * 1024 * 1024;
const MAX_PIXELS: u64 = 600_000_000;
struct Source<'a> {
    document: PdfDocument<'a>,
    path: PathBuf,
    size: u64,
    copy_allowed: Option<bool>,
}
#[derive(Clone, Copy)]
struct Frame {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    uncovered: bool,
}
pub struct Engine<'a> {
    pdfium: &'a Pdfium,
    a: Option<Source<'a>>,
    b: Option<Source<'a>>,
    last: Option<(Report, Components)>,
    batch: Option<(BatchSummary, Vec<Vec<Region>>)>,
}
pub fn png(image: RgbaImage) -> Result<Picture, String> {
    let (width, height) = image.dimensions();
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|_| "无法编码对比图像。")?;
    // Two base64-encoded previews must stay inside the bounded IPC reply.
    if out.get_ref().len() > 16 * 1024 * 1024 {
        return Err("预览编码超过预算，请降低显示分辨率。".into());
    }
    Ok(Picture {
        width,
        height,
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(out.into_inner())
        ),
    })
}
fn cancelled(token: &AtomicBool) -> Result<(), String> {
    if token.load(Ordering::Acquire) {
        Err("COMPARE_CANCELLED".into())
    } else {
        Ok(())
    }
}
fn local_location(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let letter = match path.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(v) | Prefix::VerbatimDisk(v) => v,
                _ => return Err("对比仅接受本地磁盘路径。".into()),
            },
            _ => return Err("需要本地绝对路径。".into()),
        };
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetDriveTypeW(root: *const u16) -> u32;
        }
        let root = [letter as u16, ':' as u16, '\\' as u16, 0];
        if !matches!(unsafe { GetDriveTypeW(root.as_ptr()) }, 2 | 3 | 5) {
            return Err("网络或未知类型的磁盘不允许用于对比输入和报告。".into());
        }
    }
    Ok(())
}
impl<'a> Engine<'a> {
    pub fn new(pdfium: &'a Pdfium) -> Self {
        Self {
            pdfium,
            a: None,
            b: None,
            last: None,
            batch: None,
        }
    }
    pub fn open(
        &mut self,
        side: &str,
        path: &str,
        password: Option<&str>,
    ) -> Result<SourceInfo, String> {
        if !["a", "b"].contains(&side) {
            return Err("无效的对比侧。".into());
        }
        if password.is_some_and(|v| v.len() > 1024) {
            return Err("密码过长。".into());
        }
        // Reject UNC/mapped network locations before touching file metadata.
        local_location(Path::new(path))?;
        let path = fs::canonicalize(path)
            .map_err(|_| "无法读取所选 PDF；请检查文件是否存在及访问权限。")?;
        local_location(&path)?;
        let location = path.to_string_lossy();
        if location.to_ascii_lowercase().starts_with(r"\\?\unc\")
            || (location.starts_with(r"\\") && !location.starts_with(r"\\?\"))
        {
            return Err("首版对比仅接受本地磁盘 PDF，请使用单位允许的本地目录。".into());
        }
        if !path
            .extension()
            .is_some_and(|v| v.eq_ignore_ascii_case("pdf"))
        {
            return Err("请选择 PDF 文件。".into());
        }
        let file = File::open(&path).map_err(|_| "无法打开所选 PDF。")?;
        let meta = file.metadata().map_err(|_| "无法读取文件信息。")?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_INPUT {
            return Err("对比单文件上限为 128 MiB，且文件不能为空。".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_INPUT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "读取 PDF 失败。")?;
        if bytes.len() as u64 > MAX_INPUT {
            return Err("PDF 读取期间超过大小上限。".into());
        }
        let size = bytes.len() as u64;
        let copy_allowed = crate::engine::source_copy_allowed(self.pdfium, &bytes, password);
        let document = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, password)
            .map_err(|e| match e {
                PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
                    "PASSWORD_REQUIRED: 此 PDF 需要正确密码。".to_owned()
                }
                _ => "无法解析所选 PDF，文件可能损坏或格式不受支持。".to_owned(),
            })?;
        if document.pages().is_empty() || document.pages().len() > 5000 {
            return Err("对比 PDF 页数需在 1～5000 之间。".into());
        }
        if document.form().is_some_and(|v| {
            matches!(
                v.form_type(),
                PdfFormType::XfaFull | PdfFormType::XfaForeground
            )
        }) {
            return Err("首版不支持 XFA 外观，无法保证完整比较。请从原软件打印为普通 PDF。".into());
        }
        let mut pages = vec![];
        for page in document.pages().iter() {
            let (w, h) = (page.width().value as f64, page.height().value as f64);
            if ![w, h]
                .iter()
                .all(|v| v.is_finite() && *v > 0.0 && *v < 100_000.0)
            {
                return Err("页面尺寸不受支持。".into());
            }
            pages.push(PageInfo {
                width: w,
                height: h,
            });
        }
        let info = SourceInfo {
            file_name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            file_size: size,
            pages,
        };
        let source = Source {
            document,
            path,
            size,
            copy_allowed,
        };
        if side == "a" {
            self.a = Some(source)
        } else {
            self.b = Some(source)
        }
        self.last = None;
        self.batch = None;
        Ok(info)
    }
    fn pages(&self, o: &Options) -> Result<(PdfPage<'_>, PdfPage<'_>, Frame), String> {
        o.validate()?;
        let a = self
            .a
            .as_ref()
            .ok_or("请先选择旧版 A。")?
            .document
            .pages()
            .get(o.page_a as i32)
            .map_err(|_| "旧版页码超出范围。")?;
        let b = self
            .b
            .as_ref()
            .ok_or("请先选择新版 B。")?
            .document
            .pages()
            .get(o.page_b as i32)
            .map_err(|_| "新版页码超出范围。")?;
        if o.page_a > 4999 || o.page_b > 4999 {
            return Err("页码超出范围。".into());
        }
        let (aw, ah, bw, bh) = (
            a.width().value as f64,
            a.height().value as f64,
            b.width().value as f64,
            b.height().value as f64,
        );
        let (dx, dy) = (o.offset_x_mm * 72.0 / 25.4, o.offset_y_mm * 72.0 / 25.4);
        let (x, y) = (0.0_f64.min(dx), 0.0_f64.min(dy));
        let (w, h) = (aw.max(dx + bw) - x, ah.max(dy + bh) - y);
        Ok((
            a,
            b,
            Frame {
                width: w,
                height: h,
                x,
                y,
                uncovered: (aw - bw).abs() > 0.001
                    || (ah - bh).abs() > 0.001
                    || dx.abs() > 0.001
                    || dy.abs() > 0.001,
            },
        ))
    }
    /// Real strip/tile rendering: the destination bitmap is tile-sized. PDFium's
    /// page origin is shifted, with its normal form/annotation render path intact.
    pub(super) fn render(
        page: &PdfPage,
        scale: f64,
        origin: [f64; 2],
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    ) -> Result<RgbaImage, String> {
        if w == 0 || h == 0 || w as u64 * h as u64 > 32 * 1024 * 1024 {
            return Err("对比预览超过像素预算。".into());
        }
        let pw = (page.width().value as f64 * scale).round().max(1.0);
        let ph = (page.height().value as f64 * scale).round().max(1.0);
        if pw > 100_000.0 || ph > 100_000.0 {
            return Err("页面渲染边长超过预算。".into());
        }
        // A gutter keeps clipped strokes/antialiasing outside the retained tile.
        let pad = 4_u32;
        let (bw, bh) = (w + pad * 2, h + pad * 2);
        let mut bytes = vec![255_u8; bw as usize * bh as usize * 4];
        let mut bitmap =
            PdfBitmap::from_bytes(bw as i32, bh as i32, PdfBitmapFormat::BGRA, &mut bytes)
                .map_err(|_| "无法分配对比瓦片。")?;
        page.render_into_bitmap_with_config(
            &mut bitmap,
            &PdfRenderConfig::new()
                .set_target_size(pw as i32, ph as i32)
                .set_origin(
                    (origin[0] * scale).round() as i32 - x as i32 + pad as i32,
                    (origin[1] * scale).round() as i32 - y as i32 + pad as i32,
                )
                .clear_before_rendering(false)
                .render_form_data(true)
                .render_annotations(true),
        )
        .map_err(|_| "图纸瓦片渲染失败，结果不完整。")?;
        let image = bitmap
            .as_image()
            .map_err(|_| "无法读取对比瓦片。")?
            .to_rgba8();
        Ok(image::imageops::crop_imm(&image, pad, pad, w, h).to_image())
    }
    pub fn preview(&self, o: &Options, width: u32, rect: Option<Rect>) -> Result<Preview, String> {
        let (a, b, f) = self.pages(o)?;
        let rect = rect.unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        });
        if !rect.valid() || !(128..=4096).contains(&width) {
            return Err("预览范围或宽度无效。".into());
        }
        let scale = (width as f64 / (f.width * rect.width))
            .min((16_000_000.0 / (f.width * f.height * rect.width * rect.height)).sqrt())
            .min(20.0);
        let (w, h) = (
            (f.width * rect.width * scale).round().max(1.0) as u32,
            (f.height * rect.height * scale).round().max(1.0) as u32,
        );
        let (x, y) = (
            (f.width * rect.x * scale).round() as u32,
            (f.height * rect.y * scale).round() as u32,
        );
        let pa = png(Self::render(&a, scale, [-f.x, -f.y], x, y, w, h)?)?;
        let pb = png(Self::render(
            &b,
            scale,
            [
                o.offset_x_mm * 72.0 / 25.4 - f.x,
                o.offset_y_mm * 72.0 / 25.4 - f.y,
            ],
            x,
            y,
            w,
            h,
        )?)?;
        Ok(Preview {
            a: pa,
            b: pb,
            width_pt: f.width,
            height_pt: f.height,
            origin_x_pt: f.x,
            origin_y_pt: f.y,
            uncovered: f.uncovered,
        })
    }
    pub fn compare<F: FnMut(u32, u32)>(
        &mut self,
        job_id: String,
        o: Options,
        token: &AtomicBool,
        mut progress: F,
    ) -> Result<Report, String> {
        self.last = None;
        let (a, b, f) = self.pages(&o)?;
        let scale = o.dpi as f64 / 72.0;
        let (w, h) = (
            (f.width * scale).round().max(1.0) as u32,
            (f.height * scale).round().max(1.0) as u32,
        );
        if w > 60_000 || h > 60_000 || w as u64 * h as u64 > MAX_PIXELS {
            return Err(
                "分析超过 6 亿像素或单边 60000 预算。请选择较低 DPI，系统不会静默降采样。".into(),
            );
        }
        let total = w.div_ceil(TILE) * h.div_ceil(TILE);
        let mut done = 0;
        let mut components = Components::new();
        let mut pixels = 0_u64;
        let mut ignored = 0_u64;
        let exclusions: Vec<(u32, u32, u32, u32)> = o
            .ignored
            .iter()
            .map(|r| {
                (
                    (r.x * w as f64).floor() as u32,
                    (r.y * h as f64).floor() as u32,
                    ((r.x + r.width) * w as f64).ceil() as u32,
                    ((r.y + r.height) * h as f64).ceil() as u32,
                )
            })
            .collect();
        for y in (0..h).step_by(TILE as usize) {
            let th = TILE.min(h - y);
            let mut rows: Vec<Vec<Run>> = (0..th).map(|_| vec![]).collect();
            for x in (0..w).step_by(TILE as usize) {
                cancelled(token)?;
                let tw = TILE.min(w - x);
                let ia = Self::render(&a, scale, [-f.x, -f.y], x, y, tw, th)?;
                cancelled(token)?;
                let ib = Self::render(
                    &b,
                    scale,
                    [
                        o.offset_x_mm * 72.0 / 25.4 - f.x,
                        o.offset_y_mm * 72.0 / 25.4 - f.y,
                    ],
                    x,
                    y,
                    tw,
                    th,
                )?;
                for ly in 0..th {
                    let row = &mut rows[ly as usize];
                    let mut pending: Option<Run> = None;
                    for lx in 0..tw {
                        let (gx, gy) = (x + lx, y + ly);
                        let excluded = exclusions
                            .iter()
                            .any(|&(l, t, r, b)| gx >= l && gx < r && gy >= t && gy < b);
                        let kind = if excluded {
                            ignored += 1;
                            0
                        } else {
                            classify(
                                &ia.get_pixel(lx, ly).0,
                                &ib.get_pixel(lx, ly).0,
                                o.threshold,
                            )
                        };
                        if kind != 0 {
                            pixels += 1;
                            if let Some(ref mut r) = pending {
                                if r.kind == kind {
                                    r.end = gx + 1;
                                    continue;
                                }
                            }
                        }
                        if let Some(r) = pending.take() {
                            row.push(r)
                        }
                        if kind != 0 {
                            pending = Some(Run {
                                x: gx,
                                end: gx + 1,
                                y: gy,
                                kind,
                                node: 0,
                            })
                        }
                    }
                    if let Some(r) = pending {
                        row.push(r)
                    }
                }
                done += 1;
                progress(done, total);
            }
            for row in rows {
                cancelled(token)?;
                components.row(row)?
            }
        }
        cancelled(token)?;
        let regions = components.regions(w, h)?;
        let factor = (2048.0 / f.width.max(f.height)).min(2.0);
        let (mw, mh) = (
            (f.width * factor).round().max(1.0) as u32,
            (f.height * factor).round().max(1.0) as u32,
        );
        let mut mask = RgbaImage::new(mw, mh);
        paint_runs(&mut mask, &components.runs, w, h);
        let report = Report {
            job_id,
            options: o,
            width_pt: f.width,
            height_pt: f.height,
            origin_x_pt: f.x,
            origin_y_pt: f.y,
            pixel_width: w,
            pixel_height: h,
            changed_pixels: pixels,
            ignored_pixels: ignored,
            uncovered: f.uncovered,
            regions,
            mask: png(mask)?,
            tile_count: total,
        };
        drop(a);
        drop(b);
        self.last = Some((report.clone(), components));
        Ok(report)
    }
    pub fn export(
        &self,
        job_id: &str,
        path: &str,
        kind: &str,
        reviewed: &[u32],
    ) -> Result<Value, String> {
        let (report, components) = self
            .last
            .as_ref()
            .filter(|(r, _)| r.job_id == job_id)
            .ok_or("只可导出完整且仍有效的对比结果。")?;
        let requested = Path::new(path);
        local_location(requested)?;
        let expected = match kind {
            "png" => "png",
            "csv" => "csv",
            _ => return Err("不支持的导出格式。".into()),
        };
        if !requested
            .extension()
            .is_some_and(|v| v.eq_ignore_ascii_case(expected))
        {
            return Err("导出扩展名不匹配。".into());
        }
        let parent = requested
            .parent()
            .ok_or("请选择本地输出目录。")?
            .canonicalize()
            .map_err(|_| "输出目录不存在或不可访问。")?;
        local_location(&parent)?;
        let target = parent.join(requested.file_name().ok_or("输出文件名无效。")?);
        let target = target.as_path();
        for source in [&self.a, &self.b].into_iter().flatten() {
            if target == source.path
                || same_file::is_same_file(target, &source.path).unwrap_or(false)
            {
                return Err("不能覆盖来源文件。".into());
            }
        }
        if target.exists() {
            return Err("请另选新文件名，首版导出不覆盖已有文件。".into());
        }
        let data = if kind == "csv" {
            let metadata=format!("# Jerrivell drawing comparison; DPI={}; threshold={}; pageA={}; pageB={}; offsetXmm={}; offsetYmm={}; ignoredZones={}; uncovered={}",report.options.dpi,report.options.threshold,report.options.page_a+1,report.options.page_b+1,report.options.offset_x_mm,report.options.offset_y_mm,serde_json::to_string(&report.options.ignored).unwrap(),report.uncovered);
            let mut csv = format!("\u{feff}\"{}\"\r\n", metadata.replace('"', "\"\""));
            csv.push_str(
                "id,x_mm,y_mm,width_mm,height_mm,pixels,added,removed,changed,reviewed\r\n",
            );
            for r in &report.regions {
                let b = r.bounds;
                csv.push_str(&format!(
                    "{},{:.5},{:.5},{:.5},{:.5},{},{},{},{},{}\r\n",
                    r.id,
                    (report.origin_x_pt + b.x * report.width_pt) * 25.4 / 72.0,
                    (report.origin_y_pt + b.y * report.height_pt) * 25.4 / 72.0,
                    b.width * report.width_pt * 25.4 / 72.0,
                    b.height * report.height_pt * 25.4 / 72.0,
                    r.pixels,
                    r.added,
                    r.removed,
                    r.changed,
                    reviewed.contains(&r.id)
                ));
            }
            csv.into_bytes()
        } else {
            let preview = self.preview(&report.options, 2048, None)?;
            let mut image = image::load_from_memory(
                &base64::engine::general_purpose::STANDARD
                    .decode(preview.a.data_url.split_once(',').unwrap().1)
                    .map_err(|_| "导出图像失败。")?,
            )
            .map_err(|_| "导出图像失败。")?
            .to_rgba8();
            let mut overlay = RgbaImage::new(image.width(), image.height());
            paint_runs(
                &mut overlay,
                &components.runs,
                report.pixel_width,
                report.pixel_height,
            );
            image::imageops::overlay(&mut image, &overlay, 0, 0);
            // Exclusions remain visible in the PNG as well as the CSV metadata.
            for r in &report.options.ignored {
                let left = (r.x * image.width() as f64) as u32;
                let top = (r.y * image.height() as f64) as u32;
                let right = ((r.x + r.width) * image.width() as f64).ceil() as u32;
                let bottom = ((r.y + r.height) * image.height() as f64).ceil() as u32;
                for y in top..bottom.min(image.height()) {
                    for x in left..right.min(image.width()) {
                        if (x + y) % 9 < 2 {
                            let p = image.get_pixel_mut(x, y);
                            for c in 0..3 {
                                p.0[c] = ((p.0[c] as u16 + 125) / 2) as u8;
                            }
                        }
                    }
                }
            }
            for region in &report.regions {
                let b = region.bounds;
                let (x, y, w, h) = (
                    (b.x * image.width() as f64) as u32,
                    (b.y * image.height() as f64) as u32,
                    (b.width * image.width() as f64).ceil().max(2.0) as u32,
                    (b.height * image.height() as f64).ceil().max(2.0) as u32,
                );
                for px in x.saturating_sub(2)..(x + w + 2).min(image.width()) {
                    for py in [y.saturating_sub(2), (y + h + 1).min(image.height() - 1)] {
                        image.put_pixel(px, py, image::Rgba([231, 132, 19, 255]))
                    }
                }
                for py in y.saturating_sub(2)..(y + h + 2).min(image.height()) {
                    for px in [x.saturating_sub(2), (x + w + 1).min(image.width() - 1)] {
                        image.put_pixel(px, py, image::Rgba([231, 132, 19, 255]))
                    }
                }
            }
            let image = super::report_image::label(image, report);
            let mut bytes = Cursor::new(Vec::new());
            DynamicImage::ImageRgba8(image)
                .write_to(&mut bytes, ImageFormat::Png)
                .map_err(|_| "导出 PNG 编码失败。")?;
            bytes.into_inner()
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|_| "无法创建导出文件，请选择新的本地文件名。")?;
        if file.write_all(&data).and_then(|_| file.sync_all()).is_err() {
            drop(file);
            let _ = fs::remove_file(target);
            return Err("写入报告失败，未保留不完整文件。".into());
        }
        Ok(json!({"bytes":data.len(),"regions":report.regions.len()}))
    }
    pub fn input_bytes(&self) -> u64 {
        self.a.as_ref().map_or(0, |s| s.size) + self.b.as_ref().map_or(0, |s| s.size)
    }

    pub fn clear(&mut self, side: &str) -> Result<Value, String> {
        match side {
            "a" => self.a = None,
            "b" => self.b = None,
            _ => return Err("无效的对比侧。".into()),
        };
        self.last = None;
        self.batch = None;
        Ok(json!({"cleared":side,"inputBytes":self.input_bytes()}))
    }
    pub fn page_preview(&self, side: &str, index: u32, width: u32) -> Result<Picture, String> {
        if index > 4999 || !(128..=4096).contains(&width) {
            return Err("预览参数无效。".into());
        }
        let source = match side {
            "a" => self.a.as_ref(),
            "b" => self.b.as_ref(),
            _ => None,
        }
        .ok_or("请先选择该侧 PDF。")?;
        let page = source
            .document
            .pages()
            .get(index as i32)
            .map_err(|_| "页码超出范围。")?;
        let (w, h) = (page.width().value as f64, page.height().value as f64);
        let s = (width as f64 / w)
            .min((16_000_000. / (w * h)).sqrt())
            .min(20.);
        png(Self::render(
            &page,
            s,
            [0., 0.],
            0,
            0,
            (w * s).round().max(1.) as u32,
            (h * s).round().max(1.) as u32,
        )?)
    }
    pub fn text_assist(&self, o: &Options) -> Result<Value, String> {
        let (a, b, _) = self.pages(o)?;
        if self.a.as_ref().unwrap().copy_allowed != Some(true)
            || self.b.as_ref().unwrap().copy_allowed != Some(true)
        {
            return Ok(json!({"status":"restricted","changes":[],"limited":false}));
        }
        let (at, bt) = (
            a.text().map_err(|_| "文字层读取失败。")?,
            b.text().map_err(|_| "文字层读取失败。")?,
        );
        if at.len() > 50000 || bt.len() > 50000 {
            return Ok(json!({"status":"limited","changes":[],"limited":true}));
        }
        Ok(json!(super::quality::compare(&at.all(), &bt.all())))
    }
    pub fn auto_align<F: FnMut(u32, u32)>(
        &self,
        o: &Options,
        token: &AtomicBool,
        mut progress: F,
    ) -> Result<Alignment, String> {
        use super::registration::{pooled, search, search_sets, Features};
        let (a, b, f) = self.pages(o)?;
        cancelled(token)?;
        let s = 1536. / f.width.max(f.height);
        let (w, h) = (
            (f.width * s).round().max(1.) as u32,
            (f.height * s).round().max(1.) as u32,
        );
        let ia = Self::render(&a, s, [-f.x, -f.y], 0, 0, w, h)?;
        cancelled(token)?;
        let ib = Self::render(
            &b,
            s,
            [
                o.offset_x_mm * 72. / 25.4 - f.x,
                o.offset_y_mm * 72. / 25.4 - f.y,
            ],
            0,
            0,
            w,
            h,
        )?;
        let mut proposal = Alignment {
            options: o.clone(),
            offset_x_mm: o.offset_x_mm,
            offset_y_mm: o.offset_y_mm,
            reliable: false,
            agreement: 0.,
            ambiguity_margin: 0.,
            reason: "insufficient-features".into(),
            samples: 0,
        };
        let mut shift = [0, 0];
        let mut margin = 0.;
        let mut final_match = None;
        for (level, long) in [192_u32, 384, 768].into_iter().enumerate() {
            cancelled(token)?;
            let (aa, bb) = (pooled(&ia, long), pooled(&ib, long));
            let (af, bf) = (
                Features::new(&aa, &o.ignored),
                Features::new(&bb, &o.ignored),
            );
            if !af.informative() || !bf.informative() {
                return Ok(proposal);
            }
            let ratio = long as f64 / f.width.max(f.height);
            let radius = if level == 0 {
                ((100. * 72. / 25.4 * ratio).ceil() as i32).clamp(2, 100)
            } else {
                4
            };
            let found = search(
                &af,
                &bf,
                if level == 0 {
                    [0, 0]
                } else {
                    [shift[0] * 2, shift[1] * 2]
                },
                [radius, radius],
                if level == 0 { 2 } else { 1 },
                token,
            )?;
            if level == 0 {
                margin = found.margin
            }
            shift = [found.x, found.y];
            progress(20 + level as u32 * 20, 100);
            final_match = Some(found);
        }
        let coarse = final_match.unwrap();
        let ratio = 768. / f.width.max(f.height);
        let pixel_mm = 25.4 / o.dpi as f64;
        let x =
            ((o.offset_x_mm + coarse.x as f64 / ratio * 25.4 / 72.) / pixel_mm).round() * pixel_mm;
        let y =
            ((o.offset_y_mm + coarse.y as f64 / ratio * 25.4 / 72.) / pixel_mm).round() * pixel_mm;
        let full = o.dpi as f64 / 72.;
        let (fw, fh) = (
            (f.width * full).round() as u32,
            (f.height * full).round() as u32,
        );
        let overview = Features::new(&pooled(&ia, 768), &o.ignored);
        let mut bins = vec![(0_usize, 0_usize); 9];
        for &(px, py) in &overview.points {
            let k = (py as usize * 3 / overview.height).min(2) * 3
                + (px as usize * 3 / overview.width).min(2);
            bins[k].0 += 1;
            bins[k].1 = k
        }
        bins.sort_by_key(|v| std::cmp::Reverse(v.0));
        let (mut aa, mut bb) = (vec![], vec![]);
        for &(count, k) in bins.iter().take(3) {
            if count == 0 {
                continue;
            }
            cancelled(token)?;
            let (tw, th) = (fw.min(768), fh.min(768));
            let point = overview
                .points
                .iter()
                .filter(|&&(px, py)| {
                    (py as usize * 3 / overview.height).min(2) * 3
                        + (px as usize * 3 / overview.width).min(2)
                        == k
                })
                .nth(count / 2)
                .copied()
                .unwrap_or(overview.points[0]);
            let (tx, ty) = (
                point.0 as f64 / overview.width as f64 * fw as f64,
                point.1 as f64 / overview.height as f64 * fh as f64,
            );
            let (l, t) = (
                (tx - tw as f64 / 2.).max(0.).min((fw - tw) as f64) as u32,
                (ty - th as f64 / 2.).max(0.).min((fh - th) as f64) as u32,
            );
            let pa = Self::render(&a, full, [-f.x, -f.y], l, t, tw, th)?;
            let pb = Self::render(
                &b,
                full,
                [x * 72. / 25.4 - f.x, y * 72. / 25.4 - f.y],
                l,
                t,
                tw,
                th,
            )?;
            let exclusions = o
                .ignored
                .iter()
                .filter_map(|r| {
                    let x = (r.x * fw as f64 - l as f64).max(0.);
                    let y = (r.y * fh as f64 - t as f64).max(0.);
                    let right = ((r.x + r.width) * fw as f64 - l as f64).min(tw as f64);
                    let bottom = ((r.y + r.height) * fh as f64 - t as f64).min(th as f64);
                    if right > x && bottom > y {
                        Some(Rect {
                            x: x / tw as f64,
                            y: y / th as f64,
                            width: (right - x) / tw as f64,
                            height: (bottom - y) / th as f64,
                        })
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            aa.push(Features::new(&pa, &exclusions));
            bb.push(Features::new(&pb, &exclusions));
        }
        let radius = (full / ratio * 2.).ceil().clamp(3., 80.) as i32;
        let step = (radius / 10).max(1);
        let m = search_sets(&aa, &bb, [0, 0], [radius, radius], step, token)?;
        let m = search_sets(&aa, &bb, [m.x, m.y], [step, step], 1, token)?;
        proposal.offset_x_mm = x + m.x as f64 * pixel_mm;
        proposal.offset_y_mm = y + m.y as f64 * pixel_mm;
        proposal.agreement = m.agreement;
        proposal.ambiguity_margin = margin;
        proposal.samples = m.samples as u32;
        proposal.reliable = m.agreement >= 0.80
            && m.cost <= 2.5
            && margin >= 0.035
            && proposal.offset_x_mm.abs() <= 100.
            && proposal.offset_y_mm.abs() <= 100.;
        proposal.reason = if proposal.reliable {
            "translation-only"
        } else if margin < 0.035 {
            "ambiguous-pattern"
        } else {
            "low-agreement"
        }
        .into();
        progress(100, 100);
        Ok(proposal)
    }
    pub fn compare_batch<F: FnMut(u32, u32)>(
        &mut self,
        job_id: String,
        pairs: Vec<Options>,
        auto_align: bool,
        token: &AtomicBool,
        mut progress: F,
    ) -> Result<BatchSummary, String> {
        if pairs.is_empty() || pairs.len() > 100 {
            return Err("批量对比需要 1～100 组页面。".into());
        }
        let mut pixels = 0_u64;
        let mut seen = std::collections::HashSet::new();
        for o in &pairs {
            let (_, _, f) = self.pages(o)?;
            if !seen.insert((o.page_a, o.page_b)) {
                return Err("页面配对重复。".into());
            }
            pixels += (f.width * o.dpi as f64 / 72.).ceil() as u64
                * (f.height * o.dpi as f64 / 72.).ceil() as u64;
        }
        if pixels > 1_200_000_000 {
            return Err("本次批量超过 12 亿像素总预算，请降低 DPI 或分组对比。".into());
        }
        self.batch = None;
        self.last = None;
        let (mut items, mut regions, mut region_total) = (vec![], vec![], 0_usize);
        let n = pairs.len() as u32;
        let mut actual_pixels = 0_u64;
        for (index, mut options) in pairs.into_iter().enumerate() {
            self.last = None;
            cancelled(token)?;
            let mut alignment = None;
            let aligned = if auto_align {
                match self.auto_align(&options, token, |_, _| {}) {
                    Ok(a) => {
                        let good = a.reliable;
                        if good {
                            options.offset_x_mm = a.offset_x_mm;
                            options.offset_y_mm = a.offset_y_mm
                        }
                        alignment = Some(a);
                        good
                    }
                    Err(e) if e == "COMPARE_CANCELLED" => return Err(e),
                    Err(_) => false,
                }
            } else {
                true
            };
            let (_, _, frame) = self.pages(&options)?;
            actual_pixels += (frame.width * options.dpi as f64 / 72.).ceil() as u64
                * (frame.height * options.dpi as f64 / 72.).ceil() as u64;
            if actual_pixels > 1_200_000_000 {
                return Err("配准后的批量总像素超出预算，请降低 DPI 或分组对比。".into());
            }
            let result = if aligned {
                self.compare(
                    format!("{job_id}-{index}"),
                    options.clone(),
                    token,
                    |_, _| progress(index as u32, n),
                )
            } else {
                Err("自动平移配准不可靠；需要人工对齐。".into())
            };
            let item = match result {
                Ok(r) => {
                    region_total += r.regions.len();
                    if region_total > 50000 {
                        self.last = None;
                        return Err("批量差异超过 50000 个区域总预算。".into());
                    }
                    regions.push(r.regions.clone());
                    BatchItem {
                        index: index as u32,
                        options,
                        status: "complete".into(),
                        changed_pixels: Some(r.changed_pixels),
                        region_count: Some(r.regions.len() as u32),
                        ignored_pixels: r.ignored_pixels,
                        uncovered: r.uncovered,
                        error: None,
                        alignment,
                    }
                }
                Err(e) if e == "COMPARE_CANCELLED" => {
                    self.last = None;
                    return Err(e);
                }
                Err(e) => {
                    regions.push(vec![]);
                    BatchItem {
                        index: index as u32,
                        options,
                        status: "failed".into(),
                        changed_pixels: None,
                        region_count: None,
                        ignored_pixels: 0,
                        uncovered: false,
                        error: Some(e),
                        alignment,
                    }
                }
            };
            items.push(item);
            progress(index as u32 + 1, n);
        }
        self.last = None;
        let selected_a = items
            .iter()
            .map(|v| v.options.page_a)
            .collect::<std::collections::HashSet<_>>();
        let selected_b = items
            .iter()
            .map(|v| v.options.page_b)
            .collect::<std::collections::HashSet<_>>();
        let summary = BatchSummary {
            job_id,
            all_analyzed: items.iter().all(|v| v.status == "complete"),
            unpaired_a: (0..self.a.as_ref().unwrap().document.pages().len() as u32)
                .filter(|v| !selected_a.contains(v))
                .collect(),
            unpaired_b: (0..self.b.as_ref().unwrap().document.pages().len() as u32)
                .filter(|v| !selected_b.contains(v))
                .collect(),
            items,
        };
        self.batch = Some((summary.clone(), regions));
        Ok(summary)
    }
    pub fn export_batch(&self, job_id: &str, path: &str) -> Result<Value, String> {
        let (summary, regions) = self
            .batch
            .as_ref()
            .filter(|(s, _)| s.job_id == job_id)
            .ok_or("没有该批量任务的完整处理记录。")?;
        let mut csv=String::from("\u{feff}pair,page_a,page_b,status,dpi,tolerance,offset_x_mm,offset_y_mm,regions,changed_pixels,ignored_pixels,coverage_differs,all_analyzed,unpaired_a,unpaired_b\r\n");
        for item in &summary.items {
            csv.push_str(&format!(
                "{},{},{},{},{},{},{:.5},{:.5},{},{},{},{},{},\"{}\",\"{}\"\r\n",
                item.index + 1,
                item.options.page_a + 1,
                item.options.page_b + 1,
                item.status,
                item.options.dpi,
                item.options.threshold,
                item.options.offset_x_mm,
                item.options.offset_y_mm,
                item.region_count.map(|v| v.to_string()).unwrap_or_default(),
                item.changed_pixels
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
                item.ignored_pixels,
                item.uncovered,
                summary.all_analyzed,
                summary
                    .unpaired_a
                    .iter()
                    .map(|v| (v + 1).to_string())
                    .collect::<Vec<_>>()
                    .join(" "),
                summary
                    .unpaired_b
                    .iter()
                    .map(|v| (v + 1).to_string())
                    .collect::<Vec<_>>()
                    .join(" ")
            ));
        }
        csv.push_str("\r\npair,region,x_normalized,y_normalized,width_normalized,height_normalized,pixels,added,removed,changed\r\n");
        for (item, list) in summary.items.iter().zip(regions) {
            for r in list {
                csv.push_str(&format!(
                    "{},{},{:.7},{:.7},{:.7},{:.7},{},{},{},{}\r\n",
                    item.index + 1,
                    r.id,
                    r.bounds.x,
                    r.bounds.y,
                    r.bounds.width,
                    r.bounds.height,
                    r.pixels,
                    r.added,
                    r.removed,
                    r.changed
                ));
            }
        }
        let requested = Path::new(path);
        if !requested.is_absolute() {
            return Err("请选择绝对路径的本地文件。".into());
        }
        local_location(requested)?;
        if !requested
            .extension()
            .is_some_and(|v| v.eq_ignore_ascii_case("csv"))
        {
            return Err("请选择 CSV 输出文件。".into());
        }
        let parent = requested
            .parent()
            .ok_or("输出目录无效。")?
            .canonicalize()
            .map_err(|_| "输出目录不存在。")?;
        local_location(&parent)?;
        let target = parent.join(requested.file_name().ok_or("文件名无效。")?);
        for source in [&self.a, &self.b].into_iter().flatten() {
            if same_file::is_same_file(&target, &source.path).unwrap_or(false) {
                return Err("不能覆盖来源文件。".into());
            }
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|_| "请选择新的本地 CSV 文件名。")?;
        if file
            .write_all(csv.as_bytes())
            .and_then(|_| file.sync_all())
            .is_err()
        {
            drop(file);
            let _ = fs::remove_file(target);
            return Err("批量报告写入失败。".into());
        }
        Ok(json!({"pairs":summary.items.len(),"bytes":csv.len()}))
    }
}
