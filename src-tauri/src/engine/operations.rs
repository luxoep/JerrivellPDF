// SPDX-License-Identifier: MIT OR Apache-2.0
use super::*;

pub(super) struct PreparedLine {
    pub token: String,
    pub bytes: Vec<u8>,
    pub can_apply: bool,
}

impl<'a> PdfEngine<'a> {
    pub(super) fn add_generated_source(
        &mut self,
        bytes: Vec<u8>,
        name: &str,
    ) -> Result<DocumentInfo, String> {
        if bytes.is_empty() || bytes.len() as u64 > MAX_FILE_BYTES {
            return Err("生成的文档超过 256 MiB。".into());
        }
        if self.sources.len() >= 128
            || self.sources.values().map(|source| source.size).sum::<u64>() + bytes.len() as u64
                > MAX_SESSION_BYTES
        {
            return Err("工作区生成页面达到资源上限，请保存副本后重新打开。".into());
        }
        let size = bytes.len() as u64;
        let document = self
            .pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(pdf_error)?;
        let count = document.pages().len();
        if count <= 0 || count as usize > MAX_PAGES {
            return Err("生成的页数无效。".into());
        }
        let mut pages = Vec::new();
        for index in 0..count {
            let page = document.pages().get(index).map_err(pdf_error)?;
            valid_page_size(page.width().value, page.height().value)?;
            pages.push(PageInfo {
                index: index as u32,
                width: page.width().value,
                height: page.height().value,
                rotation: page.rotation().map_err(pdf_error)?.as_degrees() as u16,
            });
        }
        let id = format!("generated-{}-{}", std::process::id(), self.next_id);
        self.next_id += 1;
        let info = DocumentInfo { id: id.clone(), path: format!("memory://{id}/{name}"), file_name: name.into(), page_count: count as u32, file_size: size, pages,
            warnings: vec!["生成页只存在当前工作区中，请保存 PDF 副本。裁剪和文字行应用会固化该页当前内容，可撤销返回原方案。".into()] };
        self.sources.insert(
            id,
            Source {
                document,
                path: None,
                size,
                copy_allowed: Some(true),
            },
        );
        Ok(info)
    }

    pub fn generate_pages(&mut self, request: &GeneratePages) -> Result<DocumentInfo, String> {
        if let GeneratePages::EraseRegions { page, regions } = request {
            return self.erase_regions(page, regions);
        }
        let mut output = self.pdfium.create_new_pdf().map_err(pdf_error)?;
        let name;
        let mut protected = Vec::new();
        match request {
            GeneratePages::EraseRegions { .. } => unreachable!(),
            GeneratePages::Blank {
                width,
                height,
                count,
            } => {
                valid_page_size(*width, *height)?;
                if *width < 10.0 || *height < 10.0 || *count == 0 || *count > 100 {
                    return Err("空白页尺寸至少 10 pt，数量为 1～100。".into());
                }
                for _ in 0..*count {
                    output
                        .pages_mut()
                        .create_page_at_end(PdfPagePaperSize::new_custom(
                            PdfPoints::new(*width),
                            PdfPoints::new(*height),
                        ))
                        .map_err(pdf_error)?;
                }
                name = "空白页面.pdf";
            }
            GeneratePages::Images {
                paths,
                paper,
                margin,
            } => {
                if paths.is_empty()
                    || paths.len() > 32
                    || !matches!(paper.as_str(), "a4" | "original")
                    || !margin.is_finite()
                    || !(0.0..=144.0).contains(margin)
                {
                    return Err("图片转 PDF 支持 1～32 张 PNG/JPEG；页边距为 0～144 pt。".into());
                }
                let mut decoded = 0_u64;
                for path in paths {
                    let canonical = fs::canonicalize(path).map_err(pdf_error)?;
                    let file = File::open(&canonical).map_err(pdf_error)?;
                    let length = file.metadata().map_err(pdf_error)?.len();
                    if length == 0 || length > 24 * 1024 * 1024 {
                        return Err("来源图片必须为非空 PNG/JPEG，单张不超过 24 MiB。".into());
                    }
                    let mut bytes = Vec::new();
                    file.take(24 * 1024 * 1024 + 1)
                        .read_to_end(&mut bytes)
                        .map_err(pdf_error)?;
                    if bytes.len() > 24 * 1024 * 1024 {
                        return Err("来源图片读取期间超过限制。".into());
                    }
                    let image = super::assets::normalized_image(&bytes, false)?;
                    decoded += image.width() as u64 * image.height() as u64 * 4;
                    if decoded > 256 * 1024 * 1024 {
                        return Err("图片转 PDF 的解码量超过 256 MiB，请分批转换。".into());
                    }
                    protected.push(canonical);
                    let (width, height) = if paper == "original" {
                        (
                            image.width() as f32 * 0.75 + margin * 2.0,
                            image.height() as f32 * 0.75 + margin * 2.0,
                        )
                    } else if image.width() > image.height() {
                        (841.8898, 595.2756)
                    } else {
                        (595.2756, 841.8898)
                    };
                    if width <= margin * 2.0 || height <= margin * 2.0 {
                        return Err("页边距超过纸张可用尺寸。".into());
                    }
                    let mut page = output
                        .pages_mut()
                        .create_page_at_end(PdfPagePaperSize::new_custom(
                            PdfPoints::new(width),
                            PdfPoints::new(height),
                        ))
                        .map_err(pdf_error)?;
                    let scale = ((width - margin * 2.0) / image.width() as f32)
                        .min((height - margin * 2.0) / image.height() as f32);
                    let w = image.width() as f32 * scale;
                    let h = image.height() as f32 * scale;
                    page.objects_mut()
                        .create_image_object(
                            PdfPoints::new((width - w) / 2.0),
                            PdfPoints::new((height - h) / 2.0),
                            &image,
                            Some(PdfPoints::new(w)),
                            Some(PdfPoints::new(h)),
                        )
                        .map_err(pdf_error)?;
                    page.regenerate_content().map_err(pdf_error)?;
                }
                name = "图片转换.pdf";
            }
            GeneratePages::Crop { pages, bounds } => {
                if pages.is_empty()
                    || pages.len() > MAX_PAGES
                    || ![bounds.x, bounds.y, bounds.width, bounds.height]
                        .iter()
                        .all(|value| value.is_finite())
                    || bounds.x < 0.0
                    || bounds.y < 0.0
                    || bounds.width < 0.01
                    || bounds.height < 0.01
                    || bounds.x + bounds.width > 1.000001
                    || bounds.y + bounds.height > 1.000001
                {
                    return Err("裁剪区域必须在页面内，宽高至少为页面的 1%。".into());
                }
                output = self.prepare_document(pages)?;
                for index in 0..output.pages().len() {
                    let mut page = output.pages().get(index).map_err(pdf_error)?;
                    let config = PdfRenderConfig::new().set_target_size(10_000, 10_000);
                    let (ox, oy) = page.pixels_to_points(0, 0, &config).map_err(pdf_error)?;
                    let (rx, ry) = page
                        .pixels_to_points(10_000, 0, &config)
                        .map_err(pdf_error)?;
                    let (bx, by) = page
                        .pixels_to_points(0, 10_000, &config)
                        .map_err(pdf_error)?;
                    let mut xs = Vec::new();
                    let mut ys = Vec::new();
                    for u in [bounds.x, bounds.x + bounds.width] {
                        for v in [bounds.y, bounds.y + bounds.height] {
                            xs.push(
                                ox.value + (rx.value - ox.value) * u + (bx.value - ox.value) * v,
                            );
                            ys.push(
                                oy.value + (ry.value - oy.value) * u + (by.value - oy.value) * v,
                            );
                        }
                    }
                    let left = xs.iter().copied().fold(f32::INFINITY, f32::min);
                    let right = xs.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                    let bottom = ys.iter().copied().fold(f32::INFINITY, f32::min);
                    let top = ys.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                    page.boundaries_mut()
                        .set_crop(PdfRect::new(
                            PdfPoints::new(bottom),
                            PdfPoints::new(left),
                            PdfPoints::new(top),
                            PdfPoints::new(right),
                        ))
                        .map_err(pdf_error)?;
                }
                name = "裁剪页面.pdf";
            }
        }
        let bytes = self.document_bytes(&output, MAX_FILE_BYTES as usize)?;
        drop(output);
        let result = self.add_generated_source(bytes, name)?;
        self.protected_inputs.extend(protected);
        Ok(result)
    }

    pub fn discard_line_preview(&mut self, token: &str) {
        if self
            .prepared_line
            .as_ref()
            .is_some_and(|job| job.token == token)
        {
            self.prepared_line = None;
        }
    }
    pub fn commit_line_preview(&mut self, token: &str) -> Result<DocumentInfo, String> {
        let job = self
            .prepared_line
            .as_ref()
            .filter(|job| job.token == token)
            .ok_or("文字行预览已失效，请重新预览。")?;
        if !job.can_apply {
            return Err("文字超出允许范围，请调整字号、字距或内容。".into());
        }
        let info = self.add_generated_source(job.bytes.clone(), "文字行修改.pdf")?;
        self.prepared_line = None;
        Ok(info)
    }
}
