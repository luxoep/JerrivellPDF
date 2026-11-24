// SPDX-License-Identifier: MIT OR Apache-2.0
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
pub(super) struct PageSpace {
    forward: PdfMatrix,
    inverse: PdfMatrix,
}

impl PageSpace {
    pub(super) fn new(page: &PdfPage<'_>) -> Result<Self, String> {
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

    pub(super) fn text_bounds(&self, bounds: PdfRect) -> Option<ContentBounds> {
        let points = [
            (bounds.left(), bounds.bottom()),
            (bounds.left(), bounds.top()),
            (bounds.right(), bounds.bottom()),
            (bounds.right(), bounds.top()),
        ]
        .map(|(x, y)| self.inverse.apply_to_points(x, y));
        let left = points
            .iter()
            .map(|p| p.0.value)
            .fold(f32::INFINITY, f32::min)
            .max(0.0);
        let right = points
            .iter()
            .map(|p| p.0.value)
            .fold(f32::NEG_INFINITY, f32::max)
            .min(1.0);
        let top = points
            .iter()
            .map(|p| p.1.value)
            .fold(f32::INFINITY, f32::min)
            .max(0.0);
        let bottom = points
            .iter()
            .map(|p| p.1.value)
            .fold(f32::NEG_INFINITY, f32::max)
            .min(1.0);
        ([left, right, top, bottom].iter().all(|n| n.is_finite()) && right > left && bottom > top)
            .then_some(ContentBounds {
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
            })
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

fn text_bold(font: &PdfFont<'_>) -> bool {
    matches!(
        font.weight(),
        Ok(PdfFontWeight::Weight600
            | PdfFontWeight::Weight700Bold
            | PdfFontWeight::Weight800
            | PdfFontWeight::Weight900)
    )
}

fn text_alpha(opacity: f32) -> Result<u8, String> {
    if !opacity.is_finite() || !(0.05..=1.0).contains(&opacity) {
        return Err(invalid("文字不透明度须在 5%～100% 之间。"));
    }
    Ok((opacity * 255.0).round() as u8)
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
    } else if object.as_path_object().is_some() {
        "path"
    } else {
        reason = Some(
            if object.as_x_object_form_object().is_some() {
                "嵌套 Form 内容暂不支持直接编辑；它可能包含文字或图像。"
            } else {
                "此对象类型暂不支持直接编辑。"
            }
            .into(),
        );
        "unsupported"
    };
    if reason.is_none() && object.get_clip_path().is_some_and(|path| !path.is_empty()) {
        reason = Some("带裁剪路径的对象暂不支持精确修改。".into());
    }
    if reason.is_none() && kind != "path" && !object.matrix().map(simple_matrix).unwrap_or(false) {
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
        bold: object.as_text_object().map(|text| text_bold(&text.font())),
        italic: object.as_text_object().map(|text| text.font().is_italic()),
        opacity: object
            .as_text_object()
            .and_then(|text| text.fill_color().ok())
            .map(|color| color.alpha() as f32 / 255.0),
        editable: reason.is_none(),
        reason,
        deleted: false,
        text_angle: object
            .as_text_object()
            .and_then(|_| object.matrix().ok())
            .map(|matrix| {
                let dx = space.inverse.a() * matrix.a() + space.inverse.c() * matrix.b();
                let dy = space.inverse.b() * matrix.a() + space.inverse.d() * matrix.b();
                (dy * page.height().value)
                    .atan2(dx * page.width().value)
                    .to_degrees()
            }),
        rendered_font_size: object
            .as_text_object()
            .map(|text| text.scaled_font_size().value),
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

fn visible_text_rect(page: &PdfPage<'_>) -> Result<PdfRect, String> {
    let space = PageSpace::new(page)?;
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    for u in [0.0, 1.0] {
        for v in [0.0, 1.0] {
            let (x, y) = space
                .forward
                .apply_to_points(PdfPoints::new(u), PdfPoints::new(v));
            xs.push(x.value);
            ys.push(y.value);
        }
    }
    let left = xs.iter().copied().fold(f32::INFINITY, f32::min);
    let right = xs.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let bottom = ys.iter().copied().fold(f32::INFINITY, f32::min);
    let top = ys.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let visible = PdfRect::new(
        PdfPoints::new(bottom),
        PdfPoints::new(left),
        PdfPoints::new(top),
        PdfPoints::new(right),
    );
    Ok(visible)
}

pub(super) fn visible_text(page: &PdfPage<'_>, text: &PdfPageText<'_>) -> Result<String, String> {
    Ok(text.inside_rect(visible_text_rect(page)?))
}

/// Prefer PDFium's normal extraction, including actual/inferred word spaces.
/// If a word is absent, tolerate inferred intra-run letter-spacing only. This
/// does not rewrite stored PDF text or change explicit whitespace queries.
pub(super) fn searchable_text(
    page: &PdfPage<'_>,
    text: &PdfPageText<'_>,
    query: &str,
) -> Result<String, String> {
    let bounded = visible_text(page, text)?;
    if query.chars().any(char::is_whitespace) || bounded.to_lowercase().contains(query) {
        return Ok(bounded);
    }
    let visible = visible_text_rect(page)?;
    // PDFium may infer spaces between individually spaced letters. Keep its
    // fast bounded extraction for ordinary prose; only inspect the character
    // stream when it contains adjacent one-character tokens (e.g. H E L L O).
    let mut isolated = false;
    let needs_spacing_check = bounded.split_whitespace().any(|part| {
        let single = part.chars().count() == 1 && !part.chars().next().unwrap().is_whitespace();
        let adjacent = single && isolated;
        isolated = single;
        adjacent
    });
    if !needs_spacing_check {
        return Ok(bounded);
    }
    let chars = text.chars();
    let mut skipped = HashSet::new();
    let mut previous = None;
    let mut pending = Vec::new();
    for character in chars.iter() {
        let value = character.unicode_char();
        if value == Some(' ') && character.is_generated().map_err(pdf_error)? {
            pending.push(character.index());
            continue;
        }
        if !pending.is_empty() {
            if let Some(index) = previous {
                let preceding = chars.get(index).map_err(pdf_error)?;
                if same_text_run(&preceding, &character) {
                    skipped.extend(pending.iter().copied());
                }
            }
            pending.clear();
        }
        previous = if value.is_some_and(|ch| !ch.is_whitespace()) {
            Some(character.index())
        } else {
            None
        };
    }
    if skipped.is_empty() {
        return Ok(bounded);
    }
    let mut result = String::new();
    let mut separator = String::new();
    let mut last_visible = false;
    for character in chars.iter() {
        if skipped.contains(&character.index()) {
            continue;
        }
        let Some(value) = character.unicode_char() else {
            continue;
        };
        if character.is_generated().map_err(pdf_error)? {
            if value.is_whitespace() {
                separator.push(value);
            }
            continue;
        }
        let bounds = character.loose_bounds().map_err(pdf_error)?;
        let origin = character.origin().map_err(pdf_error)?;
        let is_visible = bounds.does_overlap(&visible) || visible.contains(origin.0, origin.1);
        if is_visible {
            if last_visible {
                result.push_str(&separator);
            } else if !result.is_empty() && !result.ends_with('\n') {
                result.push('\n');
            }
            result.push(value);
        }
        separator.clear();
        last_visible = is_visible;
    }
    if result.to_lowercase().contains(query) {
        Ok(result)
    } else {
        Ok(bounded)
    }
}

/// Only spacing reported by PDFium as generated is considered, and only within
/// a consistent text run. Preserve separators between positioned objects.
/// Geometry/font comparisons keep this linear; chars_for_object() scans the
/// whole page for every call and would make large-page search quadratic.
fn same_text_run(left: &PdfPageTextChar<'_>, right: &PdfPageTextChar<'_>) -> bool {
    let signature = |character: &PdfPageTextChar<'_>| -> Option<([u32; 11], String)> {
        let object = character.text_object().ok()?;
        let matrix = object.matrix().ok()?;
        let bounds = object.bounds().ok()?;
        let family = object.font().name();
        Some((
            [
                matrix.a().to_bits(),
                matrix.b().to_bits(),
                matrix.c().to_bits(),
                matrix.d().to_bits(),
                matrix.e().to_bits(),
                matrix.f().to_bits(),
                bounds.left().value.to_bits(),
                bounds.bottom().value.to_bits(),
                bounds.right().value.to_bits(),
                bounds.top().value.to_bits(),
                object.unscaled_font_size().value.to_bits(),
            ],
            family,
        ))
    };
    match (signature(left), signature(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// Only parse our own PDFium-generated one-page PDF. Change the final, newly
/// appended text run through real PDF Tc operators; no glyph rasterization.
fn with_last_text_spacing(
    bytes: &[u8],
    spacing: f32,
    size: f32,
    characters: usize,
) -> Result<Vec<u8>, String> {
    use lopdf::content::{Content, Operation};
    let mut document = lopdf::Document::load_mem(bytes).map_err(pdf_error)?;
    let page = *document
        .get_pages()
        .get(&1)
        .ok_or_else(|| invalid("预览 PDF 缺少页面。"))?;
    let mut content = Vec::new();
    for id in document.get_page_contents(page) {
        let stream = document
            .get_object(id)
            .and_then(lopdf::Object::as_stream)
            .map_err(pdf_error)?;
        let filter = stream.dict.get(b"Filter").ok();
        let mut chunk = Vec::new();
        match filter {
            None => chunk.extend_from_slice(&stream.content),
            Some(lopdf::Object::Name(name)) if name == b"FlateDecode" => {
                flate2::read::ZlibDecoder::new(Cursor::new(&stream.content))
                    .take(16 * 1024 * 1024 + 1)
                    .read_to_end(&mut chunk)
                    .map_err(pdf_error)?;
            }
            _ => return Err(invalid("生成的文字流压缩方式不支持字距调整。")),
        }
        if content.len().saturating_add(chunk.len()) > 16 * 1024 * 1024 {
            return Err(invalid("文字行内容流超过 16 MiB。"));
        }
        content.extend(chunk);
        content.push(b'\n');
    }
    let mut content = Content::decode(&content).map_err(pdf_error)?;
    let start = content
        .operations
        .iter()
        .rposition(|op| op.operator == "BT")
        .ok_or_else(|| invalid("无法定位新文字行。"))?;
    let end = start
        + content.operations[start..]
            .iter()
            .position(|op| op.operator == "ET")
            .ok_or_else(|| invalid("新文字行内容不完整。"))?;
    let shows: Vec<_> = content.operations[start..end]
        .iter()
        .enumerate()
        .filter(|(_, op)| matches!(op.operator.as_str(), "Tj" | "TJ"))
        .map(|(i, _)| start + i)
        .collect();
    if shows.len() != 1 {
        return Err(invalid("新文字行不是单一文字运行，无法安全调整字距。"));
    }
    let show = &content.operations[shows[0]];
    let encoded = match show.operands.as_slice() {
        [lopdf::Object::String(bytes, format)] => (bytes.clone(), format.clone()),
        [lopdf::Object::Array(values)] => match values.as_slice() {
            [lopdf::Object::String(bytes, format)] => (bytes.clone(), format.clone()),
            _ => return Err(invalid("新文字行包含复杂字形位移，请更换字体或分段处理。")),
        },
        _ => return Err(invalid("新文字行的编码方式不受支持。")),
    };
    if characters == 0
        || encoded.0.len() % characters != 0
        || !matches!(encoded.0.len() / characters, 1 | 2)
    {
        return Err(invalid("新文字行不是可靠的单字节或双字节编码。"));
    }
    // Explicit TJ advances retain the requested spacing through subsequent
    // PDFium page-content regeneration while keeping one native text run.
    let mut values = Vec::new();
    for (index, chunk) in encoded.0.chunks(encoded.0.len() / characters).enumerate() {
        if index > 0 {
            values.push(lopdf::Object::Real(-spacing * 1000.0 / size));
        }
        values.push(lopdf::Object::String(chunk.to_vec(), encoded.1.clone()));
    }
    content.operations[shows[0]] = Operation::new("TJ", vec![lopdf::Object::Array(values)]);
    // PDFium can store Contents as an indirect reference to an array. Replace
    // the page entry explicitly; changing that reference as if it were a Stream
    // is a silent no-op in the generic helper.
    let stream = lopdf::Stream::new(
        lopdf::Dictionary::new(),
        content.encode().map_err(pdf_error)?,
    );
    let stream_id = document.add_object(stream);
    document
        .get_dictionary_mut(page)
        .map_err(pdf_error)?
        .set("Contents", stream_id);
    document.prune_objects();
    let mut output = super::export::LimitedBuffer {
        bytes: Vec::new(),
        limit: MAX_FILE_BYTES as usize,
    };
    document.save_to(&mut output).map_err(pdf_error)?;
    Ok(output.bytes)
}

impl<'a> PdfEngine<'a> {
    fn editable_font_token(
        &self,
        output: &mut PdfDocument<'a>,
        fonts: &mut ContentFontCache,
        family: &str,
        text: &str,
    ) -> Result<PdfFontToken, String> {
        self.editable_font_token_style(output, fonts, family, text, false, false)
    }

    fn editable_font_token_style(
        &self,
        output: &mut PdfDocument<'a>,
        fonts: &mut ContentFontCache,
        family: &str,
        text: &str,
        bold: bool,
        italic: bool,
    ) -> Result<PdfFontToken, String> {
        let font = self.content_font_style(family, text, bold, italic)?;
        // Localized aliases can resolve to the same real face. Tokens are
        // document-local and deduplicate by the verified selected face/style.
        let key = format!("{}|{bold}|{italic}", font.family.to_lowercase());
        if let Some(token) = fonts.tokens.get(&key) {
            return Ok(*token);
        }
        if fonts.total_bytes.saturating_add(font.bytes.len()) > MAX_FONT_BYTES {
            return Err(font_error("输出文档字体超过 64 MiB。"));
        }
        let token = output
            .fonts_mut()
            .load_true_type_from_bytes(&font.bytes, true)
            .map_err(pdf_error)?;
        fonts.total_bytes += font.bytes.len();
        fonts.tokens.insert(key, token);
        Ok(token)
    }

    pub(super) fn append_decorations(
        &self,
        output: &mut PdfDocument<'a>,
        page: &mut PdfPage<'a>,
        reference: &PageRef,
        fonts: &mut ContentFontCache,
    ) -> Result<(), String> {
        if reference.decorations.is_empty() {
            return Ok(());
        }
        if reference.decorations.len() > 32 {
            return Err(invalid("每页最多 32 个页码或水印。"));
        }
        let mut ids = HashSet::new();
        let space = PageSpace::new(page)?;
        let width = page.width().value;
        let height = page.height().value;
        for item in &reference.decorations {
            if item.id.is_empty()
                || item.id.len() > 128
                || !ids.insert(&item.id)
                || !matches!(item.kind.as_str(), "number" | "watermark")
                || !matches!(item.alignment.as_str(), "left" | "center" | "right")
                || ![item.x, item.y, item.font_size, item.opacity, item.angle]
                    .iter()
                    .all(|value| value.is_finite())
                || !(0.0..=1.0).contains(&item.x)
                || !(0.0..=1.0).contains(&item.y)
                || !(1.0..=512.0).contains(&item.font_size)
                || !(0.0..=1.0).contains(&item.opacity)
                || !(-180.0..=180.0).contains(&item.angle)
                || item.text.chars().count() > 200
            {
                return Err(invalid("页码或水印参数无效。"));
            }
            validate_text(&item.text)?;
            let font = if let Some(family) = &item.font_family {
                self.editable_font_token(output, fonts, family, &item.text)?
            } else {
                if !item.text.is_ascii() {
                    return Err(font_error("中文页码或水印需要指定可嵌入的本机字体。"));
                }
                output.fonts_mut().helvetica()
            };
            let mut object =
                PdfPageTextObject::new(output, &item.text, font, PdfPoints::new(item.font_size))
                    .map_err(pdf_error)?;
            object
                .set_fill_color(parse_color(
                    &item.color,
                    (item.opacity * 255.0).round() as u8,
                )?)
                .map_err(pdf_error)?;
            let bounds = object.bounds().map_err(pdf_error)?.to_rect();
            let cx = match item.alignment.as_str() {
                "left" => bounds.left().value,
                "right" => bounds.right().value,
                _ => (bounds.left().value + bounds.right().value) / 2.0,
            };
            let cy = (bounds.bottom().value + bounds.top().value) / 2.0;
            let angle = item.angle.to_radians();
            let cos = angle.cos();
            let sin = angle.sin();
            let ux = (space.forward.a() / width, space.forward.b() / width);
            let uy = (space.forward.c() / height, space.forward.d() / height);
            let a = ux.0 * cos + uy.0 * sin;
            let b = ux.1 * cos + uy.1 * sin;
            let c = ux.0 * sin - uy.0 * cos;
            let d = ux.1 * sin - uy.1 * cos;
            object
                .reset_matrix(PdfMatrix::new(
                    a,
                    b,
                    c,
                    d,
                    space.forward.e() + space.forward.a() * item.x + space.forward.c() * item.y
                        - a * cx
                        - c * cy,
                    space.forward.f() + space.forward.b() * item.x + space.forward.d() * item.y
                        - b * cx
                        - d * cy,
                ))
                .map_err(pdf_error)?;
            let added = page
                .objects_mut()
                .add_text_object(object)
                .map_err(pdf_error)?;
            if !is_in_page(&space.bounds(&added)?) {
                return Err(invalid("页码或水印超出页面，请减小字号或调整位置。"));
            }
        }
        if !reference.decorations.is_empty() {
            page.regenerate_content().map_err(pdf_error)?;
        }
        Ok(())
    }

    pub fn preview_line_edit(&mut self, request: &LineEditRequest) -> Result<Value, String> {
        self.prepared_line = None;
        validate_text(&request.text)?;
        validate_bounds(&request.bounds)?;
        let target = request.target_bounds.as_ref().unwrap_or(&request.bounds);
        validate_bounds(target)?;
        if request.text.chars().count() > 500
            || request.objects.is_empty()
            || request.objects.len() > 64
            || !request.font_size.is_finite()
            || !(1.0..=512.0).contains(&request.font_size)
            || !request.char_spacing.is_finite()
            || !(-5.0..=30.0).contains(&request.char_spacing)
            || !matches!(request.alignment.as_str(), "left" | "center" | "right")
        {
            return Err(invalid("文字行最多 500 字、64 个片段；字距为 -5～30 pt。"));
        }
        if request.font_family.is_none() && (request.bold.is_some() || request.italic.is_some()) {
            return Err(font_error(
                "粗体/斜体样式须明确选择本机字体；保留来源字体时保留原字形。",
            ));
        }
        let color = parse_color(&request.color, text_alpha(request.opacity)?)?;
        let inspection = self.inspect_page_content(&request.page)?;
        let mut selected = Vec::new();
        let mut seen = HashSet::new();
        for identity in &request.objects {
            let object = inspection
                .objects
                .iter()
                .find(|object| {
                    object.object_index == identity.object_index
                        && object.fingerprint == identity.fingerprint
                })
                .ok_or_else(|| invalid("文字行来源已变化，请重新读取。"))?;
            if !seen.insert(identity.object_index)
                || !object.editable
                || object.deleted
                || object.kind != "text"
                || object.text_angle.is_none_or(|angle| angle.abs() > 1.0)
            {
                return Err(invalid("文字行编辑只支持可编辑的横向顶层文字片段。"));
            }
            selected.push(object);
        }
        selected.sort_by(|left, right| left.bounds.x.total_cmp(&right.bounds.x));
        let common_y = selected[0].bounds.y + selected[0].bounds.height / 2.0;
        if selected.iter().any(|object| {
            (object.bounds.y + object.bounds.height / 2.0 - common_y).abs()
                > request.bounds.height.max(object.bounds.height) * 0.7
        }) {
            return Err(invalid("所选片段不属于同一横向文字行。"));
        }
        let old_text = selected
            .iter()
            .filter_map(|object| object.text.as_deref())
            .collect::<Vec<_>>()
            .join("");
        let mut output = self.prepare_document(std::slice::from_ref(&request.page))?;
        let mut page = output.pages().get(0).map_err(pdf_error)?;
        let space = PageSpace::new(&page)?;
        let width = page.width().value;
        let height = page.height().value;
        let removed: HashSet<_> = request
            .page
            .content_edits
            .iter()
            .filter(|edit| edit.deleted == Some(true))
            .map(|edit| edit.object_index)
            .collect();
        let current_index =
            |index: u32| index as usize - removed.iter().filter(|old| **old < index).count();
        let first = page
            .objects()
            .get(current_index(selected[0].object_index))
            .map_err(pdf_error)?;
        let template = first
            .as_text_object()
            .ok_or_else(|| invalid("文字片段已失效。"))?;
        let family = template.font().name();
        let baseline = {
            let text = page.text().map_err(pdf_error)?;
            let chars = text.chars_for_object(template).map_err(pdf_error)?;
            let origin = chars
                .iter()
                .find(|ch| !ch.is_generated().unwrap_or(true))
                .ok_or_else(|| invalid("无法定位文字基线。"))?
                .origin()
                .map_err(pdf_error)?;
            space.inverse.apply_to_points(origin.0, origin.1).1.value
        };
        let font = if let Some(family) = &request.font_family {
            self.editable_font_token_style(
                &mut output,
                &mut ContentFontCache::default(),
                family,
                &request.text,
                request.bold.unwrap_or(false),
                request.italic.unwrap_or(false),
            )?
        } else {
            if selected
                .iter()
                .any(|object| object.font_family.as_deref() != Some(family.as_str()))
                || !original_font_covers(&old_text, &request.text, &family)
            {
                return Err(font_error(
                    "原行混合字体或原字体缺少新字符，请选择可嵌入的本机字体。",
                ));
            }
            template.font().token()
        };
        let mut replacement = PdfPageTextObject::new(
            &output,
            &request.text,
            font,
            PdfPoints::new(request.font_size),
        )
        .map_err(pdf_error)?;
        replacement.set_fill_color(color).map_err(pdf_error)?;
        let ux = (space.forward.a() / width, space.forward.b() / width);
        let uy = (space.forward.c() / height, space.forward.d() / height);
        replacement
            .reset_matrix(PdfMatrix::new(
                ux.0,
                ux.1,
                -uy.0,
                -uy.1,
                space.forward.e()
                    + space.forward.a() * target.x
                    + space.forward.c() * (baseline + target.y - request.bounds.y),
                space.forward.f()
                    + space.forward.b() * target.x
                    + space.forward.d() * (baseline + target.y - request.bounds.y),
            ))
            .map_err(pdf_error)?;
        drop(first);
        let mut indices: Vec<_> = selected
            .iter()
            .map(|object| current_index(object.object_index))
            .collect();
        indices.sort_unstable_by(|a, b| b.cmp(a));
        for index in indices {
            drop(
                page.objects_mut()
                    .remove_object_at_index(index)
                    .map_err(pdf_error)?,
            );
        }
        page.objects_mut()
            .add_text_object(replacement)
            .map_err(pdf_error)?;
        page.regenerate_content().map_err(pdf_error)?;
        drop(page);
        let bytes = self.document_bytes(&output, MAX_FILE_BYTES as usize)?;
        drop(output);
        let spaced = with_last_text_spacing(
            &bytes,
            request.char_spacing,
            request.font_size,
            request.text.chars().count(),
        )?;
        let document = self
            .pdfium
            .load_pdf_from_byte_vec(spaced, None)
            .map_err(pdf_error)?;
        let mut page = document.pages().get(0).map_err(pdf_error)?;
        let last = page.objects().len() as usize - 1;
        let mut object = page.objects().get(last).map_err(pdf_error)?;
        let space = PageSpace::new(&page)?;
        if object_text(
            &page,
            object
                .as_text_object()
                .ok_or_else(|| invalid("预览文字对象无效。"))?,
        )? != request.text
        {
            return Err(font_error(
                "无法核对文字及空格的映射，请减小字距或选择其他字体。",
            ));
        }
        let bounds = space.bounds(&object)?;
        let x = match request.alignment.as_str() {
            "center" => target.x + (target.width - bounds.width) / 2.0,
            "right" => target.x + target.width - bounds.width,
            _ => target.x,
        };
        let delta = PdfMatrix::new(1.0, 0.0, 0.0, 1.0, x - bounds.x, 0.0);
        let transform = space.inverse.multiply(delta).multiply(space.forward);
        let matrix = object.matrix().map_err(pdf_error)?;
        object
            .reset_matrix(matrix.multiply(transform))
            .map_err(pdf_error)?;
        let actual = space.bounds(&object)?;
        drop(object);
        // Decoration strokes are real PDF paths, added after text spacing has
        // been finalized. The Unicode text itself remains searchable.
        let line_baseline = baseline + target.y - request.bounds.y;
        let visual_height = space.forward.c().hypot(space.forward.d());
        let mut decoration_overflow = false;
        for offset in [
            request.underline.then_some(0.10),
            request.strikeout.then_some(-0.30),
        ]
        .into_iter()
        .flatten()
        {
            let y = line_baseline + request.font_size * offset / visual_height;
            let stroke = (request.font_size / 18.0).clamp(0.5, 6.0);
            decoration_overflow |=
                y - stroke / visual_height / 2.0 < 0.0 || y + stroke / visual_height / 2.0 > 1.0;
            let (x1, y1) = space
                .forward
                .apply_to_points(PdfPoints::new(actual.x), PdfPoints::new(y));
            let (x2, y2) = space
                .forward
                .apply_to_points(PdfPoints::new(actual.x + actual.width), PdfPoints::new(y));
            let mut path = PdfPagePathObject::new(
                &document,
                x1,
                y1,
                Some(color),
                Some(PdfPoints::new(stroke)),
                None,
            )
            .map_err(pdf_error)?;
            path.line_to(x2, y2).map_err(pdf_error)?;
            page.objects_mut()
                .add_path_object(path)
                .map_err(pdf_error)?;
        }
        page.regenerate_content().map_err(pdf_error)?;
        let overflow_page = !is_in_page(&actual) || decoration_overflow;
        let overflow_line = actual.width > target.width + 0.0005
            || (request.target_bounds.is_some() && actual.height > target.height + 0.0005);
        let (rw, rh) = render_dimensions(page.width().value, page.height().value, 760, false)?;
        let after = page
            .render_with_config(
                &PdfRenderConfig::new()
                    .set_target_size(rw as i32, rh as i32)
                    .render_form_data(false)
                    .render_annotations(true),
            )
            .map_err(pdf_error)?
            .as_image()
            .map_err(pdf_error)?;
        let (after_width, after_height) = (after.width(), after.height());
        let mut png = Cursor::new(Vec::new());
        after
            .write_to(&mut png, ImageFormat::Png)
            .map_err(pdf_error)?;
        drop(page);
        let bytes = self.document_bytes(&document, MAX_FILE_BYTES as usize)?;
        drop(document);
        let token = format!("line-{}-{}", std::process::id(), self.next_job);
        self.next_job += 1;
        let can_apply = !overflow_page && (!request.constrain_width || !overflow_line);
        self.prepared_line = Some(super::operations::PreparedLine {
            token: token.clone(),
            bytes,
            can_apply,
        });
        Ok(
            json!({"token":token,"after":{"dataUrl":format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(png.into_inner())),"width":after_width,"height":after_height},
            "bounds":actual,"textWidth":actual.width*width,"availableWidth":target.width*width,"overflowLine":overflow_line,"overflowPage":overflow_page,"canApply":can_apply,"oldText":old_text,"text":request.text}),
        )
    }

    pub(super) fn copied_content_page(
        &self,
        reference: &PageRef,
    ) -> Result<PdfDocument<'a>, String> {
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

    fn content_font_style(
        &self,
        family: &str,
        text: &str,
        bold: bool,
        italic: bool,
    ) -> Result<Arc<crate::font_source::EditableFont>, String> {
        let key = format!("{}|{bold}|{italic}", family.trim().to_lowercase());
        if let Some(font) = self.content_fonts.borrow().get(&key).cloned() {
            crate::font_source::validate_font_text(&font, text)?;
            return Ok(font);
        }
        let font = Arc::new(if bold || italic {
            crate::font_source::load_editable_font_style(family, text, bold, italic)?
        } else {
            crate::font_source::load_editable_font(family, text)?
        });
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
            original.bold = current.bold;
            original.italic = current.italic;
            original.opacity = current.opacity;
            original.text_angle = current.text_angle;
            original.rendered_font_size = current.rendered_font_size;
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

    /// Extract filtered/masked pixels in intrinsic image coordinates. Reset the
    /// matrix on a copied page only; replacement later keeps the original matrix.
    pub fn extract_content_image(
        &mut self,
        reference: &PageRef,
        object_index: u32,
        fingerprint: &str,
    ) -> Result<ImageAssetInfo, String> {
        if object_index as usize >= MAX_CONTENT_OBJECTS
            || reference.content_edits.iter().any(|edit| {
                edit.object_index == object_index && edit.deleted == Some(true)
            })
        {
            return Err(invalid("请选择当前页面中可见的图片对象。"));
        }
        let mut output = self.copied_content_page(reference)?;
        let mut page = output.pages().get(0).map_err(pdf_error)?;
        {
            let object = page.objects().get(object_index as usize).map_err(pdf_error)?;
            if object.as_image_object().is_none() {
                return Err(invalid("只有图片对象可使用像素橡皮擦。"));
            }
            let info = inspect_object(object_index, &object, PageSpace::new(&page)?, &page)?;
            if !info.editable || info.fingerprint != fingerprint {
                return Err(invalid("所选图片已变化或不支持像素编辑，请重新选择。"));
            }
            // Object-level compositing would be baked into the extracted pixels,
            // then reapplied when writing those pixels back. A bitmap's own alpha
            // mask is separate from this graphics state and remains supported.
            if object.has_transparency() {
                return Err(invalid("此图片使用特殊混合、对象蒙版或透明度，暂不支持像素修改。"));
            }
        }
        self.apply_content_edits(
            &mut output,
            &mut page,
            reference,
            &mut ContentFontCache::default(),
        )?;
        if let Some(asset_id) = reference.content_edits.iter()
            .find(|edit| edit.object_index == object_index)
            .and_then(|edit| edit.replacement_asset_id.as_deref())
        {
            // A subsequent erase uses the exact pixels already stored in the edit.
            return self.get_image_asset(asset_id);
        }
        let index = object_index as usize
            - reference
                .content_edits
                .iter()
                .filter(|edit| edit.object_index < object_index && edit.deleted == Some(true))
                .count();
        let mut object = page.objects().get(index).map_err(pdf_error)?;
        let image = object
            .as_image_object_mut()
            .ok_or_else(|| invalid("所选对象不是图片。"))?;
        let (w, h) = (image.width().map_err(pdf_error)?, image.height().map_err(pdf_error)?);
        assets::check_image_dimensions(w.max(0) as u32, h.max(0) as u32)?;
        image
            .reset_matrix(PdfMatrix::new(w as f32, 0.0, 0.0, h as f32, 0.0, 0.0))
            .map_err(pdf_error)?;
        let pixels = image
            .get_processed_image_with_size(&output, w, h)
            .map_err(pdf_error)?;
        if (pixels.width(), pixels.height()) != (w as u32, h as u32) {
            return Err(invalid("引擎无法取得原始尺寸的图片，已取消修改以保留清晰度。"));
        }
        drop(object);
        drop(page);
        drop(output);
        self.store_image(pixels, None)
    }

    #[cfg(test)]
    pub fn page_content_text(&self, reference: &PageRef) -> Result<String, String> {
        self.page_text(reference, None)
    }

    pub(super) fn page_search_text(
        &self,
        reference: &PageRef,
        query: &str,
    ) -> Result<String, String> {
        self.page_text(reference, Some(query))
    }

    fn page_text(&self, reference: &PageRef, query: Option<&str>) -> Result<String, String> {
        let mut output = self.copied_content_page(reference)?;
        let mut page = output.pages().get(0).map_err(pdf_error)?;
        let mut fonts = ContentFontCache::default();
        self.apply_content_edits(&mut output, &mut page, reference, &mut fonts)?;
        self.append_decorations(&mut output, &mut page, reference, &mut fonts)?;
        let text = page.text().map_err(pdf_error)?;
        if text.len() as usize > MAX_SEARCH_CHARS {
            return Err(invalid("页面文字超过查找预算。"));
        }
        match query {
            Some(query) => searchable_text(&page, &text, query),
            None => visible_text(&page, &text),
        }
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
            if let Some(opacity) = edit.opacity {
                text_alpha(opacity)?;
            }
            if edit.font_family.is_none() && (edit.bold.is_some() || edit.italic.is_some()) {
                return Err(font_error("粗体/斜体须明确选择本机字体。"));
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
                    || edit.fill_color.is_some()
                    || edit.bold.is_some()
                    || edit.italic.is_some()
                    || edit.opacity.is_some())
            {
                return Err(invalid("此对象不支持文字属性。"));
            }
            if original.kind == "path" && edit.bounds.is_some() {
                return Err(invalid("矢量路径当前仅支持删除和恢复。"));
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
            if object.as_path_object().is_some() {
                continue;
            }
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
                    let token = self.editable_font_token_style(
                        output,
                        fonts,
                        family,
                        new_text,
                        edit.bold.unwrap_or(false),
                        edit.italic.unwrap_or(false),
                    )?;
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
                if edit.fill_color.is_some() || edit.opacity.is_some() {
                    object
                        .set_fill_color(parse_color(
                            edit.fill_color.as_deref().unwrap_or(&color_string(color)),
                            edit.opacity
                                .map(text_alpha)
                                .transpose()?
                                .unwrap_or(color.alpha()),
                        )?)
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
                if object.has_transparency() {
                    // Existing image replacements can carry an object's blend
                    // state. The pixel eraser refuses those objects at extraction.
                    object.as_image_object_mut().unwrap().set_image(&image).map_err(pdf_error)?;
                    object.reset_matrix(matrix).map_err(pdf_error)?;
                } else {
                    // A PDF image resource may be drawn in several places. A
                    // fresh image isolates this instance at the same paint index.
                    let active = object.is_active().map_err(pdf_error)?;
                    let mut replacement = PdfPageImageObject::new(output, &image).map_err(pdf_error)?;
                    replacement.reset_matrix(matrix).map_err(pdf_error)?;
                    drop(object);
                    drop(page.objects_mut().remove_object_at_index(index).map_err(pdf_error)?);
                    object = page.objects_mut().insert_object_at_index(index, PdfPageObject::Image(replacement)).map_err(pdf_error)?;
                    if !active {
                        object.set_inactive().map_err(pdf_error)?;
                    }
                }
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
