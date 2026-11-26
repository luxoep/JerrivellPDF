// SPDX-License-Identifier: MIT OR Apache-2.0
use super::*;

fn encoded(image: DynamicImage) -> Result<(RenderedPage, usize), String> {
    let (width, height) = (image.width(), image.height());
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, ImageFormat::Png)
        .map_err(pdf_error)?;
    let bytes = png.into_inner();
    if bytes.len() > MAX_PNG_BYTES {
        return Err("生成预览图层超过大小限制。".into());
    }
    let length = bytes.len();
    Ok((
        RenderedPage {
            width,
            height,
            data_url: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
        },
        length,
    ))
}

fn clear_content(page: &mut PdfPage<'_>) -> Result<(), String> {
    for index in (0..page.objects().len()).rev() {
        drop(
            page.objects_mut()
                .remove_object_at_index(index as usize)
                .map_err(pdf_error)?,
        );
    }
    page.regenerate_content().map_err(pdf_error)
}

impl<'a> PdfEngine<'a> {
    /// Cache once per selected source object. Pointer moves compose these
    /// layers in the browser; they do not call PDFium or alter source objects.
    pub fn render_object_layers(
        &self,
        reference: &PageRef,
        object_index: u32,
        fingerprint: &str,
        target_width: u32,
    ) -> Result<ObjectPreviewLayers, String> {
        let inspection = self.inspect_page_content(reference)?;
        if !inspection.objects.iter().any(|o| {
            o.object_index == object_index
                && o.fingerprint == fingerprint
                && o.editable
                && !o.deleted
        }) {
            return Err("来源对象已变化或不支持实时编辑。".into());
        }
        let pivot = object_index as usize
            - reference
                .content_edits
                .iter()
                .filter(|edit| edit.object_index < object_index && edit.deleted == Some(true))
                .count();
        let mut content = reference.clone();
        content.overlays.clear();
        content.decorations.clear();
        let mut images = Vec::new();
        for group in 0..3 {
            let document = self.prepare_document(&[content.clone()])?;
            let mut page = document.pages().get(0).map_err(pdf_error)?;
            page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
            for index in (0..page.objects().len() as usize).rev() {
                let keep = match group {
                    0 => index < pivot,
                    1 => index == pivot,
                    _ => index > pivot,
                };
                if !keep {
                    page.objects()
                        .get(index)
                        .map_err(pdf_error)?
                        .set_inactive()
                        .map_err(pdf_error)?;
                }
            }
            // This page is rendered and discarded. Regenerating content here
            // can change shared graphics state between untouched streams.
            let (width, height) =
                render_dimensions(page.width().value, page.height().value, target_width, false)?;
            let bitmap = page
                .render_with_config(
                    &PdfRenderConfig::new()
                        .set_target_size(width as i32, height as i32)
                        .render_form_data(false)
                        .render_annotations(false)
                        .set_clear_color(if group == 0 {
                            PdfColor::WHITE
                        } else {
                            PdfColor::new(0, 0, 0, 0)
                        }),
                )
                .map_err(pdf_error)?
                .as_image()
                .map_err(pdf_error)?;
            images.push(encoded(bitmap)?.0);
        }
        let mut raster = reference.clone();
        raster.overlays.clear();
        let foreground = self.render_page_layers(&raster, target_width)?.foreground;
        Ok(ObjectPreviewLayers {
            lower: images.remove(0),
            moving: images.remove(0),
            upper: images.remove(0),
            foreground,
        })
    }
    /// Stable PDF background + transparent foreground. Added images are composed
    /// in the reader, between the PDF content and its decorations/annotations.
    /// The original document and the export/print renderer are never modified.
    pub fn render_page_layers(
        &self,
        reference: &PageRef,
        target_width: u32,
    ) -> Result<RenderedPageLayers, String> {
        if !reference.overlays.is_empty() {
            return Err("分层底图请求不能包含新增图像。".into());
        }
        let mut base = reference.clone();
        base.decorations.clear();
        let mut document = self.prepare_document(&[base])?;
        let mut page = document.pages().get(0).map_err(pdf_error)?;
        let (width, height) =
            render_dimensions(page.width().value, page.height().value, target_width, false)?;
        let config = || {
            PdfRenderConfig::new()
                .set_target_size(width as i32, height as i32)
                .render_form_data(false)
        };
        let background = page
            .render_with_config(&config().render_annotations(false))
            .map_err(pdf_error)?
            .as_image()
            .map_err(pdf_error)?;
        let (background, background_bytes) = encoded(background)?;
        let mut foreground = Vec::new();
        let mut total_bytes = background_bytes;
        let annotations: Vec<_> = page
            .annotations()
            .iter()
            .map(|annotation| {
                (
                    annotation.annotation_type() == PdfPageAnnotationType::Highlight,
                    annotation.is_hidden(),
                )
            })
            .collect();
        if !reference.decorations.is_empty() || !annotations.is_empty() {
            page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
            clear_content(&mut page)?;
            if !reference.decorations.is_empty() {
                self.append_decorations(
                    &mut document,
                    &mut page,
                    reference,
                    &mut content::ContentFontCache::default(),
                )?;
                let bitmap = page
                    .render_with_config(
                        &config()
                            .render_annotations(false)
                            .set_clear_color(PdfColor::new(0, 0, 0, 0)),
                    )
                    .map_err(pdf_error)?
                    .as_image()
                    .map_err(pdf_error)?;
                let (image, bytes) = encoded(bitmap)?;
                total_bytes += bytes;
                foreground.push(RenderedPreviewLayer {
                    image,
                    blend_mode: OverlayBlendMode::Normal,
                });
                clear_content(&mut page)?;
            }
            // Standard highlight appearances use Multiply. A transparent PNG
            // cannot retain that operator by itself: render highlight and normal
            // annotation groups separately, then carry their compositing modes.
            for multiply in [true, false] {
                if !annotations
                    .iter()
                    .any(|(kind, hidden)| *kind == multiply && !hidden)
                {
                    continue;
                }
                for (index, (kind, hidden)) in annotations.iter().enumerate() {
                    page.annotations()
                        .get(index)
                        .map_err(pdf_error)?
                        .set_is_hidden(*hidden || *kind != multiply)
                        .map_err(pdf_error)?;
                }
                let bitmap = page
                    .render_with_config(
                        &config()
                            .render_annotations(true)
                            .set_clear_color(PdfColor::new(0, 0, 0, 0)),
                    )
                    .map_err(pdf_error)?
                    .as_image()
                    .map_err(pdf_error)?;
                let (image, bytes) = encoded(bitmap)?;
                total_bytes += bytes;
                foreground.push(RenderedPreviewLayer {
                    image,
                    blend_mode: if multiply {
                        OverlayBlendMode::Multiply
                    } else {
                        OverlayBlendMode::Normal
                    },
                });
            }
        }
        if total_bytes > MAX_PNG_BYTES {
            return Err("合计预览图层超过大小限制，请降低缩放比例。".into());
        }

        Ok(RenderedPageLayers {
            background,
            foreground,
        })
    }
}
