use super::*;
use image::{ImageDecoder, ImageReader, Limits};

const MAX_ASSET_INPUT_BYTES: u64 = 24 * 1024 * 1024;
const MAX_ASSET_PIXELS: u64 = 16 * 1024 * 1024;
const MAX_ASSET_SIDE: u32 = 2400;
const MAX_ASSET_COUNT: usize = 64;
const MAX_ASSET_MEMORY: usize = 64 * 1024 * 1024;
const MAX_REGISTER_DATA_URL: usize = 1_500_000;
const MAX_OVERLAYS_PER_PAGE: usize = 64;
const PDF_STAMP_RENDER_SIDE: u32 = 1600;

pub(super) struct ImageAsset {
    pub(super) png: Vec<u8>,
    pub(super) width: u32,
    pub(super) height: u32,
    source_paths: Vec<PathBuf>,
}

fn invalid(message: impl std::fmt::Display) -> String {
    format!("ASSET_INVALID: {message}")
}

fn normalized_image(bytes: &[u8], expected_png: bool) -> Result<DynamicImage, String> {
    let format =
        image::guess_format(bytes).map_err(|_| invalid("图片格式无效，请选择 PNG 或 JPEG。"))?;
    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg)
        || (expected_png && format != ImageFormat::Png)
    {
        return Err(invalid("只支持 PNG 或 JPEG；登记的绘制图层必须为 PNG。"));
    }
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|e| invalid(format!("无法读取图片尺寸：{e}")))?;
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || width as u64 * height as u64 > MAX_ASSET_PIXELS
    {
        return Err(invalid(
            "图片尺寸超过限制；最多 1600 万像素，单边最多 8192 像素。",
        ));
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| invalid(format!("无法解码图片：{e}")))?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image =
        DynamicImage::from_decoder(decoder).map_err(|e| invalid(format!("无法解码图片：{e}")))?;
    image.apply_orientation(orientation);
    let image = if width > MAX_ASSET_SIDE || height > MAX_ASSET_SIDE {
        image.resize(
            MAX_ASSET_SIDE,
            MAX_ASSET_SIDE,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        image
    };
    Ok(DynamicImage::ImageRgba8(image.to_rgba8()))
}

fn encode_png(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut encoded = Cursor::new(Vec::new());
    image
        .write_to(&mut encoded, ImageFormat::Png)
        .map_err(|e| invalid(format!("无法生成 PNG：{e}")))?;
    Ok(encoded.into_inner())
}

impl ImageAsset {
    fn memory_size(&self) -> usize {
        self.png.len()
    }
    pub(super) fn decoded_size(&self) -> u64 {
        self.width as u64 * self.height as u64 * 4
    }
    fn info(&self, id: &str) -> ImageAssetInfo {
        ImageAssetInfo {
            id: id.into(),
            data_url: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&self.png)
            ),
            width: self.width,
            height: self.height,
        }
    }
}

impl<'a> PdfEngine<'a> {
    fn store_image(
        &mut self,
        image: DynamicImage,
        source_path: Option<PathBuf>,
    ) -> Result<ImageAssetInfo, String> {
        let png = encode_png(&image)?;
        if let Some((id, asset)) = self.assets.iter_mut().find(|(_, asset)| asset.png == png) {
            // Remember an imported source even when a generated identical image was registered first.
            if let Some(path) = source_path {
                if !asset.source_paths.contains(&path) {
                    asset.source_paths.push(path);
                }
            }
            return Ok(asset.info(id));
        }
        if self.assets.len() >= MAX_ASSET_COUNT {
            return Err(invalid(
                "当前最多登记 64 个不同图片，请先保存并重新打开工作区。",
            ));
        }
        let asset = ImageAsset {
            width: image.width(),
            height: image.height(),
            png,
            source_paths: source_path.into_iter().collect(),
        };
        let used: usize = self.assets.values().map(ImageAsset::memory_size).sum();
        if used.saturating_add(asset.memory_size()) > MAX_ASSET_MEMORY {
            return Err(invalid(
                "图片工作区超过 64 MiB，请缩小图片或先保存并重新打开工作区。",
            ));
        }
        let id = format!("asset-{}-{}", std::process::id(), self.next_asset_id);
        self.next_asset_id += 1;
        let info = asset.info(&id);
        self.assets.insert(id, asset);
        Ok(info)
    }

    pub fn register_image(&mut self, data_url: &str) -> Result<ImageAssetInfo, String> {
        if data_url.len() > MAX_REGISTER_DATA_URL {
            return Err(invalid(
                "绘制图层过大，请缩小图像；PNG 数据地址最多 150 万字节。",
            ));
        }
        let encoded = data_url
            .strip_prefix("data:image/png;base64,")
            .ok_or_else(|| invalid("只接受本地 PNG 数据地址，不接受远程地址或 SVG。"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| invalid("PNG 数据编码无效。"))?;
        let image = normalized_image(&bytes, true)?;
        self.store_image(image, None)
    }

    pub fn import_image(&mut self, path: &str) -> Result<ImageAssetInfo, String> {
        let path = Path::new(path)
            .canonicalize()
            .map_err(|e| invalid(format!("无法打开图片：{e}")))?;
        let file = File::open(&path).map_err(|e| invalid(format!("无法读取图片：{e}")))?;
        let metadata = file.metadata().map_err(|e| invalid(e))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_ASSET_INPUT_BYTES {
            return Err(invalid("请选择非空 PNG/JPEG 文件，单个文件最多 24 MiB。"));
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_ASSET_INPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| invalid(e))?;
        if bytes.len() as u64 > MAX_ASSET_INPUT_BYTES {
            return Err(invalid("图片读取期间超过 24 MiB 限制。"));
        }
        let image = normalized_image(&bytes, false)?;
        self.store_image(image, Some(path))
    }

    /// Rasterize only the requested page into a reusable, local image asset.
    /// The temporary document is not added to the workspace source registry.
    pub fn import_pdf_stamp(
        &mut self,
        path: &str,
        page_index: u32,
        remove_white_background: bool,
        trim_transparent_margins: bool,
        crop: Option<&PdfStampCrop>,
    ) -> Result<PdfStampInfo, String> {
        if let Some(rect) = crop {
            if [rect.x, rect.y, rect.width, rect.height]
                .iter()
                .any(|v| !v.is_finite())
                || rect.x < 0.0
                || rect.y < 0.0
                || rect.width <= 0.0
                || rect.height <= 0.0
                || rect.x + rect.width > 1.000001
                || rect.y + rect.height > 1.000001
            {
                return Err(invalid("PDF 片段选区无效，选区必须位于页面范围内。"));
            }
        }
        let path = Path::new(path)
            .canonicalize()
            .map_err(|e| invalid(format!("无法打开 PDF 图章：{e}")))?;
        let file = File::open(&path).map_err(|e| invalid(format!("无法读取 PDF 图章：{e}")))?;
        let metadata = file.metadata().map_err(|e| invalid(e))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FILE_BYTES {
            return Err(invalid("请选择非空 PDF 图章文件，单个文件最多 256 MiB。"));
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| invalid(e))?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(invalid("PDF 图章读取期间超过 256 MiB 限制。"));
        }
        let document = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|e| match e {
                PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
                    invalid(
                        "PASSWORD_REQUIRED: 此 PDF 图章需要密码；请先提供可直接打开的授权副本。",
                    )
                }
                other => invalid(format!(
                    "无法打开 PDF 图章，文件可能损坏或格式不受支持：{other}"
                )),
            })?;
        let page_count = document.pages().len() as u32;
        if page_count == 0 || page_count as usize > MAX_PAGES {
            return Err(invalid("PDF 图章文件必须包含 1～5000 页。"));
        }
        if page_index >= page_count {
            return Err(invalid(format!(
                "PDF 图章页码超出范围，该文件共有 {page_count} 页。"
            )));
        }
        let image = {
            let page = document.pages().get(page_index as i32).map_err(pdf_error)?;
            let (width, height) = (page.width().value, page.height().value);
            valid_page_size(width, height)?;
            let scale = PDF_STAMP_RENDER_SIDE as f64 / (width as f64).max(height as f64);
            let width = (width as f64 * scale).round().max(1.0) as u32;
            let height = (height as f64 * scale).round().max(1.0) as u32;
            if width > MAX_RENDER_SIDE
                || height > MAX_RENDER_SIDE
                || u64::from(width) * u64::from(height) > MAX_RENDER_PIXELS
            {
                return Err(invalid("PDF 图章渲染超过像素限制。"));
            }
            let config = PdfRenderConfig::new()
                .set_target_size(width as i32, height as i32)
                .set_clear_color(PdfColor::new(0, 0, 0, 0))
                .render_form_data(false)
                .render_annotations(true);
            let mut pixels = page
                .render_with_config(&config)
                .map_err(pdf_error)?
                .as_image()
                .map_err(pdf_error)?
                .into_rgba8();
            if let Some(rect) = crop {
                // The full-page bitmap is already in the page's final displayed
                // orientation, so normalized top-left selection needs no PDF-axis guess.
                let left = ((rect.x * width as f32).floor() as u32).min(width - 1);
                let top = ((rect.y * height as f32).floor() as u32).min(height - 1);
                let right = (((rect.x + rect.width) * width as f32).ceil() as u32)
                    .min(width)
                    .max(left + 1);
                let bottom = (((rect.y + rect.height) * height as f32).ceil() as u32)
                    .min(height)
                    .max(top + 1);
                pixels = image::imageops::crop_imm(&pixels, left, top, right - left, bottom - top)
                    .to_image();
            }
            if remove_white_background {
                // Opt-in chroma key. Keep every other color and alpha untouched;
                // this also removes intentional near-white artwork, so preview it.
                for pixel in pixels.pixels_mut() {
                    if pixel.0[0] >= 245 && pixel.0[1] >= 245 && pixel.0[2] >= 245 {
                        pixel.0 = [0, 0, 0, 0];
                    }
                }
            }
            if trim_transparent_margins {
                let mut bounds: Option<(u32, u32, u32, u32)> = None;
                for (x, y, pixel) in pixels.enumerate_pixels() {
                    if pixel.0[3] != 0 {
                        bounds = Some(match bounds {
                            Some((left, top, right, bottom)) => {
                                (left.min(x), top.min(y), right.max(x), bottom.max(y))
                            }
                            None => (x, y, x, y),
                        });
                    }
                }
                pixels = match bounds {
                    Some((left, top, right, bottom)) => image::imageops::crop_imm(
                        &pixels,
                        left,
                        top,
                        right - left + 1,
                        bottom - top + 1,
                    )
                    .to_image(),
                    // Retain a successful pageCount response so a user can pick
                    // another page even when the first page has no visible ink.
                    None => image::RgbaImage::new(1, 1),
                };
            }
            DynamicImage::ImageRgba8(pixels)
        };
        drop(document);
        let image = self.store_image(image, Some(path))?;
        Ok(PdfStampInfo { image, page_count })
    }

    pub fn export_image(&self, asset_id: &str, output_path: &str) -> Result<ExportedPage, String> {
        let asset = self
            .assets
            .get(asset_id)
            .ok_or_else(|| invalid("图片资源已失效，请重新导入或制作。"))?;
        let destination = self.destination(output_path, "png")?;
        let mut temporary =
            NamedTempFile::new_in(destination.parent().unwrap()).map_err(pdf_error)?;
        temporary.write_all(&asset.png).map_err(pdf_error)?;
        temporary.as_file_mut().sync_all().map_err(pdf_error)?;
        self.destination(output_path, "png")?;
        temporary
            .persist(&destination)
            .map_err(|e| format!("无法提交图片导出结果：{}", e.error))?;
        Ok(ExportedPage {
            path: destination.to_string_lossy().into_owned(),
        })
    }

    pub(super) fn protect_asset_source(&self, output: &Path) -> Result<(), String> {
        for asset in self.assets.values() {
            for source in &asset.source_paths {
                if source
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&output.to_string_lossy())
                    || (output.exists() && same_file::is_same_file(source, output).unwrap_or(true))
                {
                    return Err(invalid(
                        "为保护来源文件，不能覆盖已导入的图片或 PDF 图章，请使用其他文件名。",
                    ));
                }
            }
        }
        Ok(())
    }

    pub(super) fn validate_overlays(&self, overlays: &[PageOverlay]) -> Result<(), String> {
        if overlays.len() > MAX_OVERLAYS_PER_PAGE {
            return Err(invalid("每页最多放置 64 个图层。"));
        }
        let mut ids = std::collections::HashSet::new();
        let mut decoded_bytes = 0_u64;
        for item in overlays {
            if item.id.is_empty() || item.id.len() > 128 || !ids.insert(&item.id) {
                return Err(invalid("图层标识为空、重复或过长。"));
            }
            if !self.assets.contains_key(&item.asset_id) {
                return Err(invalid("图片资源已失效，请重新导入或制作。"));
            }
            decoded_bytes += self.assets[&item.asset_id].decoded_size();
            if decoded_bytes > 64 * 1024 * 1024 {
                return Err(invalid(
                    "本页图片图层的总解码量超过 64 MiB，请缩小图片或减少图层。",
                ));
            }
            if !matches!(item.rotation, 0 | 90 | 180 | 270) {
                return Err(invalid("图层方向必须为 0、90、180 或 270 度。"));
            }
            let values = [item.x, item.y, item.width, item.height, item.opacity];
            if values.iter().any(|v| !v.is_finite())
                || item.x < 0.0
                || item.y < 0.0
                || item.width <= 0.0
                || item.height <= 0.0
                || item.x + item.width > 1.000001
                || item.y + item.height > 1.000001
                || !(0.0..=1.0).contains(&item.opacity)
            {
                return Err(invalid(
                    "图层位置、尺寸或透明度无效，图层必须位于页面范围内。",
                ));
            }
        }
        Ok(())
    }

    pub(super) fn copy_prepared_page(
        &self,
        output: &mut PdfDocument<'a>,
        reference: &PageRef,
        index: i32,
    ) -> Result<(), String> {
        let mut fonts = super::content::ContentFontCache::default();
        self.copy_prepared_page_with_fonts(output, reference, index, &mut fonts)
    }

    pub(super) fn copy_prepared_page_with_fonts(
        &self,
        output: &mut PdfDocument<'a>,
        reference: &PageRef,
        index: i32,
        fonts: &mut super::content::ContentFontCache,
    ) -> Result<(), String> {
        let source = self.source(reference)?;
        output
            .pages_mut()
            .copy_page_from_document(&source.document, reference.page_index as i32, index)
            .map_err(pdf_error)?;
        let mut page = output.pages().get(index).map_err(pdf_error)?;
        let intrinsic = page.rotation().map_err(pdf_error)?.as_degrees() as u16;
        page.set_rotation(rotation(intrinsic + reference.rotation));
        if !reference.content_edits.is_empty() {
            self.apply_content_edits(output, &mut page, reference, fonts)?;
        }
        if reference.overlays.is_empty() {
            return Ok(());
        }

        // DeviceToPage includes the page's native rotation and CropBox/MediaBox origin.
        // A virtual square viewport is sufficient: only its three corners are converted,
        // then normalized coordinates are interpolated continuously without pixel rounding.
        let config = PdfRenderConfig::new().set_target_size(1000, 1000);
        let (ox, oy) = page.pixels_to_points(0, 0, &config).map_err(pdf_error)?;
        let (rx, ry) = page.pixels_to_points(1000, 0, &config).map_err(pdf_error)?;
        let (bx, by) = page.pixels_to_points(0, 1000, &config).map_err(pdf_error)?;
        let axis_x = (rx.value - ox.value, ry.value - oy.value);
        let axis_y = (bx.value - ox.value, by.value - oy.value);
        for item in &reference.overlays {
            let asset = &self.assets[&item.asset_id];
            let decoded = image::load_from_memory_with_format(&asset.png, ImageFormat::Png)
                .map_err(|e| invalid(e))?;
            let mut pixels = match item.rotation {
                90 => decoded.rotate90(),
                180 => decoded.rotate180(),
                270 => decoded.rotate270(),
                _ => decoded,
            }
            .into_rgba8();
            if item.opacity < 1.0 {
                for pixel in pixels.pixels_mut() {
                    pixel.0[3] = (pixel.0[3] as f32 * item.opacity).round() as u8;
                }
            }
            let image = DynamicImage::ImageRgba8(pixels);
            let matrix = PdfMatrix::new(
                axis_x.0 * item.width,
                axis_x.1 * item.width,
                -axis_y.0 * item.height,
                -axis_y.1 * item.height,
                ox.value + axis_x.0 * item.x + axis_y.0 * (item.y + item.height),
                oy.value + axis_x.1 * item.x + axis_y.1 * (item.y + item.height),
            );
            let mut object = page
                .objects_mut()
                .create_image_object(PdfPoints::ZERO, PdfPoints::ZERO, &image, None, None)
                .map_err(pdf_error)?;
            object.reset_matrix(matrix).map_err(pdf_error)?;
            object
                .set_blend_mode(match item.blend_mode {
                    OverlayBlendMode::Normal => PdfPageObjectBlendMode::Normal,
                    OverlayBlendMode::Multiply => PdfPageObjectBlendMode::Multiply,
                })
                .map_err(pdf_error)?;
        }
        page.regenerate_content().map_err(pdf_error)?;
        Ok(())
    }

    pub(super) fn validate_output_overlay_budget(&self, pages: &[PageRef]) -> Result<(), String> {
        let mut total = 0_u64;
        for page in pages {
            self.validate_overlays(&page.overlays)?;
            let mut page_total = 0_u64;
            for overlay in &page.overlays {
                page_total += self.assets[&overlay.asset_id].decoded_size();
            }
            for edit in &page.content_edits {
                if let Some(id) = &edit.replacement_asset_id {
                    let asset = self
                        .assets
                        .get(id)
                        .ok_or_else(|| invalid("原文替换图片已失效，请重新导入。"))?;
                    page_total += asset.decoded_size();
                }
            }
            if page_total > 64 * 1024 * 1024 {
                return Err(invalid(
                    "本页新增与替换图片总解码量超过 64 MiB，请缩小图片或减少对象。",
                ));
            }
            total += page_total;
            if total > 256 * 1024 * 1024 {
                return Err(invalid(
                    "输出中的新增与替换图片总解码量超过 256 MiB，请缩小图片或分批保存。",
                ));
            }
        }
        Ok(())
    }
}
