// SPDX-License-Identifier: GPL-3.0-or-later
//! Limited, real PDF page-object edits. Source documents are immutable; this
//! module only changes copied pages used by preview, save and printing.
//! Public API references: PDFium public/fpdf_edit.h and public/fpdf_text.h.

use super::*;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

const MAX_CONTENT_OBJECTS: usize = 2048;
const MAX_CONTENT_EDITS: usize = 128;
const MAX_OBJECT_TEXT: usize = 2000;
const MAX_PAGE_TEXT: i32 = 256_000;
const MAX_FONT_BYTES: usize = 64 * 1024 * 1024;
const MIN_SIDE: f32 = 0.00001;
const EPSILON: f32 = 0.00002;

/// Tokens belong to exactly one output document. Save reuses this across pages;
/// previews and inspections each create a fresh, short-lived instance.
#[derive(Default)]
pub(super) struct ContentFontCache {
    tokens: HashMap<String, PdfFontToken>,
    total_bytes: usize,
}

fn invalid(message: impl std::fmt::Display) -> String {
    format!("CONTENT_INVALID: {message}")
}

fn font_error(message: impl std::fmt::Display) -> String {
    format!("CONTENT_FONT: {message}")
}

#[derive(Clone, Copy)]
struct PageSpace {
    forward: PdfMatrix,
    inverse: PdfMatrix,
}

impl PageSpace {
    fn new(page: &PdfPage<'_>) -> Result<Self, String> {
        let config = PdfRenderConfig::new().set_target_size(10_000, 10_000);
        let (ox, oy) = page.pixels_to_points(0, 0, &config).map_err(pdf_error)?;
        let (rx, ry) = page
            .pixels_to_points(10_000, 0, &config)
            .map_err(pdf_error)?;
        let (bx, by) = page
            .pixels_to_points(0, 10_000, &config)
            .map_err(pdf_error)?;
        let forward = PdfMatrix::new(
            rx.value - ox.value,
            ry.value - oy.value,
            bx.value - ox.value,
            by.value - oy.value,
            ox.value,
            oy.value,
        );
        let determinant = forward.a() * forward.d() - forward.b() * forward.c();
        if !determinant.is_finite() || determinant.abs() < 0.0001 {
            return Err(invalid("页面坐标无法用于精确对象编辑。"));
        }
        Ok(Self {
            forward,
            inverse: forward.invert(),
        })
    }

    fn bounds(&self, object: &PdfPageObject<'_>) -> Result<ContentBounds, String> {
        let bounds = object
            .bounds()
            .map_err(pdf_error)?
            .transform(self.inverse)
            .to_rect();
        let result = ContentBounds {
            x: bounds.left().value,
            y: bounds.bottom().value,
            width: bounds.width().value,
            height: bounds.height().value,
        };
        if [result.x, result.y, result.width, result.height]
            .iter()
            .any(|v| !v.is_finite())
        {
            return Err(invalid("对象边界不是有效数值。"));
        }
        Ok(result)
    }

    fn place(&self, object: &mut PdfPageObject<'_>, target: &ContentBounds) -> Result<(), String> {
        validate_bounds(target)?;
        let current = self.bounds(object)?;
        if current.width < MIN_SIDE || current.height < MIN_SIDE {
            return Err(invalid("无法缩放零尺寸内容对象。"));
        }
        let sx = target.width / current.width;
        let sy = target.height / current.height;
        let normalized = PdfMatrix::new(
            sx,
            0.0,
            0.0,
            sy,
            target.x - current.x * sx,
            target.y - current.y * sy,
        );
        let pdf_transform = self.inverse.multiply(normalized).multiply(self.forward);
        let original = object.matrix().map_err(pdf_error)?;
        object
            .reset_matrix(original.multiply(pdf_transform))
            .map_err(pdf_error)?;
        Ok(())
    }
}

fn is_in_page(bounds: &ContentBounds) -> bool {
    [bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|v| v.is_finite())
        && bounds.x >= -EPSILON
        && bounds.y >= -EPSILON
        && bounds.width >= MIN_SIDE
        && bounds.height >= MIN_SIDE
        && bounds.x + bounds.width <= 1.0 + EPSILON
        && bounds.y + bounds.height <= 1.0 + EPSILON
}

fn validate_bounds(bounds: &ContentBounds) -> Result<(), String> {
    if is_in_page(bounds) {
        Ok(())
    } else {
        Err(invalid("对象位置或尺寸无效；内容必须完整位于当前页面内。"))
    }
}

fn simple_matrix(matrix: PdfMatrix) -> bool {
    let values = [
        matrix.a(),
        matrix.b(),
        matrix.c(),
        matrix.d(),
        matrix.e(),
        matrix.f(),
    ];
    values
        .iter()
        .all(|v| v.is_finite() && v.abs() < 1_000_000.0)
        && ((matrix.b().abs() < 0.0001
            && matrix.c().abs() < 0.0001
            && matrix.a().abs() > 0.00001
            && matrix.d().abs() > 0.00001)
            || (matrix.a().abs() < 0.0001
                && matrix.d().abs() < 0.0001
                && matrix.b().abs() > 0.00001
                && matrix.c().abs() > 0.00001))
}

fn color_string(color: PdfColor) -> String {
    format!(
        "#{:02X}{:02X}{:02X}",
        color.red(),
        color.green(),
        color.blue()
    )
}

fn parse_color(color: &str, alpha: u8) -> Result<PdfColor, String> {
    if color.len() != 7
        || !color.starts_with('#')
        || !color[1..].bytes().all(|x| x.is_ascii_hexdigit())
    {
        return Err(invalid("文字颜色必须为 #RRGGBB。"));
    }
    Ok(PdfColor::new(
        u8::from_str_radix(&color[1..3], 16).unwrap(),
        u8::from_str_radix(&color[3..5], 16).unwrap(),
        u8::from_str_radix(&color[5..7], 16).unwrap(),
        alpha,
    ))
}

fn validate_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err(invalid("文字不能为空；移除内容请使用对象移除操作。"));
    }
    if text.chars().count() > MAX_OBJECT_TEXT || text.chars().any(|c| c.is_control()) {
        return Err(invalid(
            "单个文字对象最多 2000 字，暂不支持换行、Tab 或控制字符。",
        ));
    }
    if text.chars().any(|c| c as u32 > 0xffff) {
        return Err(font_error(
            "当前文字对象编辑暂不支持非 BMP 字符，请使用常用中英文字符。",
        ));
    }
    Ok(())
}

fn original_font_covers(original: &str, replacement: &str, family: &str) -> bool {
    let known_standard = [
        "Helvetica",
        "Helvetica-Bold",
        "Helvetica-Oblique",
        "Helvetica-BoldOblique",
        "Times-Roman",
        "Times-Bold",
        "Times-Italic",
        "Times-BoldItalic",
        "Courier",
        "Courier-Bold",
        "Courier-Oblique",
        "Courier-BoldOblique",
    ]
    .contains(&family);
    let original_chars: HashSet<_> = original.chars().collect();
    replacement
        .chars()
        .all(|c| original_chars.contains(&c) || (known_standard && (' '..='~').contains(&c)))
}

// A source-session identity check, not a cryptographic authenticity claim. It
// deliberately excludes page rotation and normalized bounds, so rotating a page
// never invalidates its edits. The source snapshot and raw object stay immutable.
fn fingerprint(index: u32, object: &PdfPageObject<'_>, text: &str) -> Result<String, String> {
    let matrix = object.matrix().unwrap_or(PdfMatrix::ZERO);
    let mut hash = 0xcbf29ce484222325_u64;
    let mut feed = |bytes: &[u8]| {
        for value in bytes {
            hash ^= *value as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    };
    feed(&index.to_le_bytes());
    feed(format!("{:?}", object.object_type()).as_bytes());
    for value in [
        matrix.a(),
        matrix.b(),
        matrix.c(),
        matrix.d(),
        matrix.e(),
        matrix.f(),
    ] {
        feed(&value.to_bits().to_le_bytes());
    }
    feed(text.as_bytes());
    if let Some(object) = object.as_text_object() {
        feed(object.font().name().as_bytes());
        feed(&object.unscaled_font_size().value.to_bits().to_le_bytes());
    }
    if let Ok(color) = object.fill_color() {
        feed(&[color.red(), color.green(), color.blue(), color.alpha()]);
    }
    Ok(format!("{hash:016x}"))
}

// Page-level text extraction can synthesize a trailing space or line break
// when another object is nearby. Only characters owned by this object and
// actually present in the PDF belong in its editable source text.
fn object_text(page: &PdfPage<'_>, object: &PdfPageTextObject<'_>) -> Result<String, String> {
    let page_text = page.text().map_err(pdf_error)?;
    let chars = page_text.chars_for_object(object).map_err(pdf_error)?;
    let mut result = String::new();
    for character in chars.iter() {
        if !character.is_generated().map_err(pdf_error)? {
            result.push(
                character
                    .unicode_char()
                    .ok_or_else(|| invalid("原文字的 Unicode 映射无效。"))?,
            );
        }
    }
    Ok(result)
}

fn inspect_object(
    index: u32,
    object: &PdfPageObject<'_>,
    space: PageSpace,
    page: &PdfPage<'_>,
) -> Result<ContentObject, String> {
    let bounds = space.bounds(object).unwrap_or(ContentBounds {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    });
    let mut text = None;
    let mut family = None;
    let mut font_size = None;
    let mut fill_color = None;
    let mut reason = None;
    let kind = if let Some(text_object) = object.as_text_object() {
        let value = object_text(page, text_object)?;
        family = Some(text_object.font().name());
        font_size = Some(text_object.unscaled_font_size().value);
        fill_color = text_object.fill_color().ok().map(color_string);
        if value.trim().is_empty() {
            reason = Some("此对象没有可可靠提取的原文字。".into());
        } else if value.chars().count() > MAX_OBJECT_TEXT {
            reason = Some("文字对象过长，请使用其他编辑方式。".into());
        } else if text_object.render_mode() != PdfPageTextRenderMode::FilledUnstroked {
            reason = Some("描边、隐藏或文字裁剪对象暂不支持编辑。".into());
        } else if !font_size.is_some_and(|size| size.is_finite() && (1.0..=512.0).contains(&size)) {
            reason = Some("此对象字号超出当前编辑范围。".into());
        } else if text_object
            .fill_color()
            .map(|color| color.alpha() == 0)
            .unwrap_or(true)
        {
            reason = Some("透明文字或特殊颜色空间暂不支持修改。".into());
        } else if object.has_transparency() {
            reason = Some("带透明度、蒙版或特殊混合模式的文字暂不支持原文修改。".into());
        }
        text = Some(value);
        "text"
    } else if object.as_image_object().is_some() {
        "image"
    } else {
        reason = Some(
            if object.as_x_object_form_object().is_some() {
                "嵌套 Form 内容暂不支持直接编辑；它可能包含文字或图像。"
            } else {
                "矢量路径、轮廓字或其他对象暂不支持原文编辑。"
            }
            .into(),
        );
        "unsupported"
    };
    if reason.is_none() && object.get_clip_path().is_some_and(|path| !path.is_empty()) {
        reason = Some("带裁剪路径的对象暂不支持精确修改。".into());
    }
    if reason.is_none() && !object.matrix().map(simple_matrix).unwrap_or(false) {
        reason = Some("斜切或任意角度对象暂不支持精确修改。".into());
    }
    if reason.is_none() && !is_in_page(&bounds) {
        reason = Some("对象超出页面或没有有效尺寸，暂不支持编辑。".into());
    }
    let identity = fingerprint(index, object, text.as_deref().unwrap_or_default())?;
    // Keep response sizes bounded even for uneditable long text objects.
    let display_text = text.map(|s| s.chars().take(MAX_OBJECT_TEXT).collect::<String>());
    Ok(ContentObject {
        object_index: index,
        fingerprint: identity,
        kind: kind.into(),
        bounds: bounds.clone(),
        original_bounds: bounds,
        text: display_text.clone(),
        original_text: display_text,
        font_family: family,
        font_size,
        fill_color,
        editable: reason.is_none(),
        reason,
        deleted: false,
    })
}

fn validate_page_text_budget(page: &PdfPage<'_>) -> Result<(), String> {
    if page.text().map_err(pdf_error)?.len() > MAX_PAGE_TEXT {
        Err(invalid(
            "此页文字量超过原文检查预算，请先拆分文档或使用其他编辑方式。",
        ))
    } else {
        Ok(())
    }
}

impl<'a> PdfEngine<'a> {
    fn copied_content_page(&self, reference: &PageRef) -> Result<PdfDocument<'a>, String> {
        let source = self.source(reference)?;
        let mut output = self.pdfium.create_new_pdf().map_err(pdf_error)?;
        output
            .pages_mut()
            .copy_page_from_document(&source.document, reference.page_index as i32, 0)
            .map_err(pdf_error)?;
        let mut page = output.pages().get(0).map_err(pdf_error)?;
        let intrinsic = page.rotation().map_err(pdf_error)?.as_degrees() as u16;
        page.set_rotation(rotation(intrinsic + reference.rotation));
        drop(page);
        Ok(output)
    }

    fn content_font(
        &self,
        family: &str,
        text: &str,
    ) -> Result<Arc<crate::font_source::EditableFont>, String> {
        let key = family.trim().to_lowercase();
        if let Some(font) = self.content_fonts.borrow().get(&key).cloned() {
            crate::font_source::validate_font_text(&font, text)?;
            return Ok(font);
        }
        let font = Arc::new(crate::font_source::load_editable_font(family, text)?);
        let mut fonts = self.content_fonts.borrow_mut();
        let total: usize = fonts.values().map(|font| font.bytes.len()).sum();
        if total.saturating_add(font.bytes.len()) > MAX_FONT_BYTES {
            return Err(font_error(
                "当前工作区字体快照超过 64 MiB，请减少替代字体种类。",
            ));
        }
        fonts.insert(key, font.clone());
        Ok(font)
    }

    pub fn inspect_page_content(&self, reference: &PageRef) -> Result<PageContent, String> {
        let mut output = self.copied_content_page(reference)?;
        let mut page = output.pages().get(0).map_err(pdf_error)?;
        validate_page_text_budget(&page)?;
        let space = PageSpace::new(&page)?;
        let total = page.objects().len() as usize;
        let mut objects = Vec::with_capacity(total.min(MAX_CONTENT_OBJECTS));
        for index in 0..total.min(MAX_CONTENT_OBJECTS) {
            let object = page.objects().get(index as usize).map_err(pdf_error)?;
            objects.push(inspect_object(index as u32, &object, space, &page)?);
        }
        let mut fonts = ContentFontCache::default();
        self.apply_content_edits(&mut output, &mut page, reference, &mut fonts)?;
        // Removals shift native indices. Exposed identities always retain their
        // original source index; deleted objects stay listed for restoration.
        let removed: HashSet<_> = reference
            .content_edits
            .iter()
            .filter(|edit| edit.deleted == Some(true))
            .map(|edit| edit.object_index)
            .collect();
        let mut current_index = 0_usize;
        for original in &mut objects {
            if removed.contains(&original.object_index) {
                original.deleted = true;
                continue;
            }
            let object = page.objects().get(current_index).map_err(pdf_error)?;
            let current = inspect_object(original.object_index, &object, space, &page)?;
            original.bounds = current.bounds;
            original.text = current.text;
            original.font_family = current.font_family;
            original.font_size = current.font_size;
            original.fill_color = current.fill_color;
            current_index += 1;
        }
        let mut warnings = Vec::new();
        if total > MAX_CONTENT_OBJECTS {
            warnings.push("仅检查前 2048 个顶层对象，未展开嵌套 Form。".into());
        }
        if !objects
            .iter()
            .any(|object| object.kind == "text" && object.editable)
        {
            warnings.push("未找到可直接编辑的顶层文字。扫描图片需要 OCR；轮廓字和嵌套 Form 不等于可编辑正文。".into());
        }
        Ok(PageContent {
            objects,
            total_objects: total as u32,
            truncated: total > MAX_CONTENT_OBJECTS,
            warnings,
        })
    }

    pub fn page_content_text(&self, reference: &PageRef) -> Result<String, String> {
        let mut output = self.copied_content_page(reference)?;
        let mut page = output.pages().get(0).map_err(pdf_error)?;
        let mut fonts = ContentFontCache::default();
        self.apply_content_edits(&mut output, &mut page, reference, &mut fonts)?;
        let text = page.text().map_err(pdf_error)?;
        if text.len() as usize > MAX_SEARCH_CHARS {
            return Err(invalid("页面文字超过查找预算。"));
        }
        Ok(text.all())
    }

    pub(super) fn apply_content_edits(
        &self,
        output: &mut PdfDocument<'a>,
        page: &mut PdfPage<'a>,
        reference: &PageRef,
        fonts: &mut ContentFontCache,
    ) -> Result<(), String> {
        if reference.content_edits.is_empty() {
            return Ok(());
        }
        if reference.content_edits.len() > MAX_CONTENT_EDITS {
            return Err(invalid("每页最多修改 128 个原内容对象。"));
        }
        validate_page_text_budget(page)?;
        let count = page.objects().len() as usize;
        let space = PageSpace::new(page)?;
        let mut seen = HashSet::new();
        let mut budget = 0_u64;
        // Validate all identities and inputs before changing the copied page.
        for edit in &reference.content_edits {
            if edit.object_index as usize >= count
                || edit.object_index as usize >= MAX_CONTENT_OBJECTS
                || !seen.insert(edit.object_index)
            {
                return Err(invalid("对象索引越界或重复。"));
            }
            let object = page
                .objects()
                .get(edit.object_index as usize)
                .map_err(pdf_error)?;
            let original = inspect_object(edit.object_index, &object, space, page)?;
            if original.fingerprint != edit.fingerprint || !original.editable {
                return Err(invalid("来源对象已变化或不支持编辑，请重新选择对象。"));
            }
            if let Some(bounds) = &edit.bounds {
                validate_bounds(bounds)?;
            }
            if let Some(size) = edit.font_size {
                if !size.is_finite() || !(1.0..=512.0).contains(&size) {
                    return Err(invalid("原文字号必须在 1～512 pt 之间。"));
                }
            }
            if let Some(text) = &edit.text {
                validate_text(text)?;
            }
            if let Some(color) = &edit.fill_color {
                parse_color(color, 255)?;
            }
            if let Some(family) = &edit.font_family {
                if family.trim().is_empty()
                    || family.chars().count() > 64
                    || family.chars().any(char::is_control)
                {
                    return Err(font_error("请选择有效的本机字体。"));
                }
            }
            if original.kind != "text"
                && (edit.text.is_some()
                    || edit.font_family.is_some()
                    || edit.font_size.is_some()
                    || edit.fill_color.is_some())
            {
                return Err(invalid("此图片对象不支持文字属性。"));
            }
            if original.kind != "image" && edit.replacement_asset_id.is_some() {
                return Err(invalid("仅图片对象支持替换图像。"));
            }
            if let Some(id) = &edit.replacement_asset_id {
                let asset = self
                    .assets
                    .get(id)
                    .ok_or_else(|| invalid("替换图片资源已失效，请重新导入。"))?;
                budget += asset.decoded_size();
                if budget > 64 * 1024 * 1024 {
                    return Err(invalid("单页替换图片总解码量超过 64 MiB。"));
                }
            }
        }
        let mut edits: Vec<_> = reference.content_edits.iter().collect();
        edits.sort_by_key(|edit| std::cmp::Reverse(edit.object_index));
        for edit in edits {
            let index = edit.object_index as usize;
            if edit.deleted == Some(true) {
                drop(
                    page.objects_mut()
                        .remove_object_at_index(index)
                        .map_err(pdf_error)?,
                );
                continue;
            }
            let mut object = page.objects().get(index).map_err(pdf_error)?;
            if object.as_text_object().is_some() {
                let text_object = object.as_text_object().unwrap();
                let old_text = object_text(page, text_object)?;
                let new_text = edit.text.as_deref().unwrap_or(&old_text);
                let old_family = text_object.font().name();
                let size = edit
                    .font_size
                    .unwrap_or(text_object.unscaled_font_size().value);
                let color = text_object.fill_color().map_err(pdf_error)?;
                if let Some(family) = &edit.font_family {
                    let font = self.content_font(family, new_text)?;
                    let key = font.family.to_lowercase();
                    let token = if let Some(token) = fonts.tokens.get(&key) {
                        *token
                    } else {
                        if fonts.total_bytes.saturating_add(font.bytes.len()) > MAX_FONT_BYTES {
                            return Err(font_error(
                                "输出文档的替代字体超过 64 MiB，请减少字体种类。",
                            ));
                        }
                        let token = output
                            .fonts_mut()
                            .load_true_type_from_bytes(&font.bytes, true)
                            .map_err(pdf_error)?;
                        fonts.total_bytes += font.bytes.len();
                        fonts.tokens.insert(key, token);
                        token
                    };
                    let matrix = object.matrix().map_err(pdf_error)?;
                    let mut replacement =
                        PdfPageTextObject::new(output, new_text, token, PdfPoints::new(size))
                            .map_err(pdf_error)?;
                    replacement.reset_matrix(matrix).map_err(pdf_error)?;
                    replacement.set_fill_color(color).map_err(pdf_error)?;
                    drop(object);
                    drop(
                        page.objects_mut()
                            .remove_object_at_index(index)
                            .map_err(pdf_error)?,
                    );
                    object = page
                        .objects_mut()
                        .insert_object_at_index(index, PdfPageObject::Text(replacement))
                        .map_err(pdf_error)?;
                } else {
                    if edit.text.is_some()
                        && !original_font_covers(&old_text, new_text, &old_family)
                    {
                        return Err(font_error(
                            "原字体可能是子集，不能可靠显示新增字符。请明确选择可嵌入的本机字体。",
                        ));
                    }
                    let text_object = object.as_text_object_mut().unwrap();
                    if edit.text.is_some() {
                        text_object.set_text(new_text).map_err(pdf_error)?;
                    }
                    if edit.font_size.is_some() {
                        text_object
                            .set_unscaled_font_size(PdfPoints::new(size))
                            .map_err(pdf_error)?;
                    }
                }
                if let Some(color_value) = &edit.fill_color {
                    object
                        .set_fill_color(parse_color(color_value, color.alpha())?)
                        .map_err(pdf_error)?;
                }
                // Refresh PDFium's cached text bounds after changing font size
                // before deriving a transform from the object's visible bounds.
                let matrix = object.matrix().map_err(pdf_error)?;
                object.reset_matrix(matrix).map_err(pdf_error)?;
                // Native text extraction must reflect exactly what the user
                // requested. Never silently accept failed Unicode mapping.
                let actual = object_text(page, object.as_text_object().unwrap())?;
                if actual != new_text {
                    return Err(font_error("文字映射不完整，请选择其他本机字体后重试。"));
                }
            }
            if let Some(asset_id) = &edit.replacement_asset_id {
                let asset = &self.assets[asset_id];
                let image = image::load_from_memory_with_format(&asset.png, ImageFormat::Png)
                    .map_err(pdf_error)?;
                let matrix = object.matrix().map_err(pdf_error)?;
                object
                    .as_image_object_mut()
                    .unwrap()
                    .set_image(&image)
                    .map_err(pdf_error)?;
                object.reset_matrix(matrix).map_err(pdf_error)?;
            }
            if let Some(target) = &edit.bounds {
                space.place(&mut object, target)?;
            }
            if !is_in_page(&space.bounds(&object)?) {
                return Err(invalid(
                    "修改后的文字或图片超出页面；请缩小字号或显式调整对象尺寸/位置。",
                ));
            }
        }
        page.regenerate_content().map_err(pdf_error)?;
        Ok(())
    }
}
