// SPDX-License-Identifier: MIT OR Apache-2.0
use super::*;
use lopdf::{
    content::{Content, Operation},
    Dictionary, Document, Object, ObjectId, Stream,
};

const CONTENT_LIMIT: usize = 16 * 1024 * 1024;
const MAX_OPERATIONS: usize = 100_000;
const MAX_MASK_POINTS: usize = 16 * 256;
type Point = (f64, f64);
type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn apply([a, b, c, d, e, f]: Matrix, (x, y): Point) -> Point {
    (a * x + c * y + e, b * x + d * y + f)
}

fn compose(outer: Matrix, [a, b, c, d, e, f]: Matrix) -> Matrix {
    let x = apply(outer, (a, b));
    let y = apply(outer, (c, d));
    let origin = apply(outer, (e, f));
    [
        x.0 - outer[4],
        x.1 - outer[5],
        y.0 - outer[4],
        y.1 - outer[5],
        origin.0,
        origin.1,
    ]
}

fn inverse([a, b, c, d, e, f]: Matrix) -> Result<Matrix, String> {
    let det = a * d - b * c;
    if !det.is_finite() || det.abs() < 1e-12 {
        return Err("选区包含无法映射坐标的对象。".into());
    }
    Ok([
        d / det,
        -b / det,
        -c / det,
        a / det,
        (c * f - d * e) / det,
        (b * e - a * f) / det,
    ])
}

fn numbers<const N: usize>(values: &[Object]) -> Result<[f64; N], String> {
    if values.len() != N {
        return Err("页面绘制坐标无效。".into());
    }
    let mut result = [0.0; N];
    for (dst, source) in result.iter_mut().zip(values) {
        *dst = f64::from(source.as_float().map_err(pdf_error)?);
        if !dst.is_finite() {
            return Err("页面绘制坐标无效。".into());
        }
    }
    Ok(result)
}

fn corners([x0, y0, x1, y1]: [f64; 4]) -> [Point; 4] {
    [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
}

fn bounds(points: &[Point]) -> [f64; 4] {
    points.iter().fold(
        [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        |[l, b, r, t], &(x, y)| [l.min(x), b.min(y), r.max(x), t.max(y)],
    )
}

fn intersects([l, b, r, t]: [f64; 4], [ol, ob, or, ot]: [f64; 4]) -> bool {
    l < or && ol < r && b < ot && ob < t
}

fn page_xobjects(document: &Document, mut page: ObjectId) -> Result<Option<&Dictionary>, String> {
    for _ in 0..32 {
        let node = document.get_dictionary(page).map_err(pdf_error)?;
        if let Ok(resources) = node.get(b"Resources") {
            let (_, resources) = document.dereference(resources).map_err(pdf_error)?;
            let resources = resources.as_dict().map_err(pdf_error)?;
            return resources
                .get(b"XObject")
                .ok()
                .map(|object| {
                    document
                        .dereference(object)
                        .and_then(|(_, value)| value.as_dict())
                        .map_err(pdf_error)
                })
                .transpose();
        }
        match node.get(b"Parent") {
            Ok(parent) => page = parent.as_reference().map_err(pdf_error)?,
            Err(_) => return Ok(None),
        }
    }
    Err("页面资源继承过深，无法局部擦除。".into())
}

// The paint operators use the current graphics matrix. A form adds its own
// matrix and bounding box; an image occupies the unit square by definition.
fn target_bounds(
    document: &Document,
    xobjects: Option<&Dictionary>,
    operation: &Operation,
    ctm: Matrix,
    page_box: [f64; 4],
) -> Result<Option<[f64; 4]>, String> {
    let unit = [0.0, 0.0, 1.0, 1.0];
    let (matrix, bbox) = match operation.operator.as_str() {
        "sh" => return Ok(Some(page_box)),
        "BI" if matches!(operation.operands.as_slice(), [Object::Stream(_)]) => (ctm, unit),
        "BI" => return Err("该页包含无法可靠保留的内联图片，请取消本次局部擦除。".into()),
        "Do" => {
            let [Object::Name(name)] = operation.operands.as_slice() else {
                return Err("页面的 XObject 调用无效。".into());
            };
            let xobject = xobjects
                .and_then(|dict| dict.get(name).ok())
                .ok_or("页面引用的 XObject 无法定位。")?;
            let (_, object) = document.dereference(xobject).map_err(pdf_error)?;
            let dict = &object.as_stream().map_err(pdf_error)?.dict;
            match dict
                .get(b"Subtype")
                .and_then(Object::as_name)
                .map_err(pdf_error)?
            {
                b"Image" => (ctm, unit),
                b"Form" => {
                    let matrix = dict
                        .get(b"Matrix")
                        .ok()
                        .map(|v| numbers(v.as_array().map_err(pdf_error)?))
                        .transpose()?
                        .unwrap_or(IDENTITY);
                    let bbox = numbers(
                        dict.get(b"BBox")
                            .and_then(Object::as_array)
                            .map_err(pdf_error)?,
                    )?;
                    (compose(ctm, matrix), bbox)
                }
                _ => return Ok(None),
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(bounds(
        &corners(bbox).map(|point| apply(matrix, point)),
    )))
}

fn add_path(
    output: &mut Vec<Operation>,
    points: &[Point],
    transform: Matrix,
) -> Result<(), String> {
    for (index, &point) in points.iter().enumerate() {
        let (x, y) = apply(transform, point);
        if [x, y]
            .iter()
            .any(|value| !value.is_finite() || value.abs() > 1e10)
        {
            return Err("局部擦除坐标超出允许范围。".into());
        }
        output.push(Operation::new(
            if index == 0 { "m" } else { "l" },
            vec![Object::Real(x as f32), Object::Real(y as f32)],
        ));
    }
    output.push(Operation::new("h", vec![]));
    Ok(())
}

fn erase_content(
    document: &mut Document,
    page: ObjectId,
    page_space: Matrix,
    regions: &[Vec<ImagePoint>],
) -> Result<usize, String> {
    let mut bytes = Vec::new();
    for id in document.get_page_contents(page) {
        let stream = document
            .get_object(id)
            .and_then(Object::as_stream)
            .map_err(pdf_error)?;
        let remaining = CONTENT_LIMIT.saturating_sub(bytes.len());
        let stream_bytes = stream
            .decompressed_content_with_limit(remaining)
            .map_err(pdf_error)?;
        bytes.extend(stream_bytes);
        bytes.push(b'\n');
    }
    let content = Content::decode(&bytes).map_err(pdf_error)?;
    if content.operations.len() > MAX_OPERATIONS {
        return Err("页面绘制指令过多，无法局部擦除。".into());
    }
    let xobjects = page_xobjects(document, page)?;
    let clip_outer = corners([-0.01, -0.01, 1.01, 1.01]).map(|point| apply(page_space, point));
    let page_box = bounds(&clip_outer);
    let masks = regions
        .iter()
        .map(|region| {
            let path = region
                .iter()
                .map(|p| apply(page_space, (p.x.into(), p.y.into())))
                .collect::<Vec<_>>();
            (bounds(&path), path)
        })
        .collect::<Vec<_>>();
    let mut output = Vec::with_capacity(content.operations.len());
    let mut ctm = IDENTITY;
    let mut stack = Vec::new();
    let mut path_open = false;
    let mut text_open = false;
    let mut changed = 0;
    for operation in content.operations {
        match operation.operator.as_str() {
            "q" => stack.push(ctm),
            "Q" => ctm = stack.pop().ok_or("页面图形状态不配对，无法局部擦除。")?,
            "cm" => ctm = compose(ctm, numbers(&operation.operands)?),
            "BT" => text_open = true,
            "ET" => text_open = false,
            "m" | "l" | "c" | "v" | "y" | "h" | "re" | "W" | "W*" => path_open = true,
            "n" | "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => path_open = false,
            _ => {}
        }
        if let Some(target) = target_bounds(document, xobjects, &operation, ctm, page_box)? {
            let active = masks
                .iter()
                .filter(|(region, _)| intersects(target, *region))
                .collect::<Vec<_>>();
            if !active.is_empty() {
                let added = active.iter().map(|(_, mask)| mask.len() + 8).sum::<usize>() + 3;
                if path_open || text_open || output.len() + added >= MAX_OPERATIONS {
                    return Err("页面绘制结构过于复杂，无法局部擦除。".into());
                }
                let transform = inverse(ctm)?;
                output.push(Operation::new("q", vec![]));
                for (_, mask) in active {
                    // Intersect consecutive even-odd clips so overlapping
                    // erase regions still form a union, never an XOR.
                    add_path(&mut output, &clip_outer, transform)?;
                    add_path(&mut output, mask, transform)?;
                    output.push(Operation::new("W*", vec![]));
                    output.push(Operation::new("n", vec![]));
                }
                output.push(operation);
                output.push(Operation::new("Q", vec![]));
                changed += 1;
                continue;
            }
        }
        output.push(operation);
    }
    if !stack.is_empty() || text_open {
        return Err("页面图形状态不配对，无法局部擦除。".into());
    }
    if changed == 0 {
        return Err("选区内没有可以局部擦除的图片或嵌套内容。文字和线条可用对象编辑。".into());
    }
    let encoded = Content { operations: output }.encode().map_err(pdf_error)?;
    if encoded.len() > CONTENT_LIMIT {
        return Err("局部擦除后的绘制指令超过大小限制。".into());
    }
    let mut stream = Stream::new(Dictionary::new(), encoded);
    stream.compress().map_err(pdf_error)?;
    let stream = document.add_object(stream);
    document
        .get_dictionary_mut(page)
        .map_err(pdf_error)?
        .set("Contents", stream);
    Ok(changed)
}

impl<'a> PdfEngine<'a> {
    pub(super) fn erase_regions(
        &mut self,
        reference: &PageRef,
        regions: &[Vec<ImagePoint>],
    ) -> Result<DocumentInfo, String> {
        if regions.is_empty()
            || regions.len() > 16
            || regions.iter().map(Vec::len).sum::<usize>() > MAX_MASK_POINTS
            || regions.iter().any(|region| {
                region.len() < 3
                    || region.iter().any(|p| {
                        ![p.x, p.y]
                            .iter()
                            .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
                    })
            })
        {
            return Err("请提供页内有效选区，最多 16 个区域和 4096 个轮廓点。".into());
        }
        let copy_allowed = self.source(reference)?.copy_allowed;
        let mut base = reference.clone();
        base.overlays.clear();
        base.decorations.clear();
        let source = self.prepare_document(&[base])?;
        let space = {
            let page = source.pages().get(0).map_err(pdf_error)?;
            let config = PdfRenderConfig::new().set_target_size(10_000, 10_000);
            let point = |x, y| {
                page.pixels_to_points(x, y, &config)
                    .map(|(x, y)| (f64::from(x.value), f64::from(y.value)))
                    .map_err(pdf_error)
            };
            let (ox, oy) = point(0, 0)?;
            let (rx, ry) = point(10_000, 0)?;
            let (bx, by) = point(0, 10_000)?;
            [rx - ox, ry - oy, bx - ox, by - oy, ox, oy]
        };
        let bytes = self.document_bytes(&source, MAX_FILE_BYTES as usize)?;
        drop(source);
        let mut document = Document::load_mem(&bytes).map_err(pdf_error)?;
        let page = document
            .get_pages()
            .get(&1)
            .copied()
            .ok_or("无法定位待擦除页面。")?;
        erase_content(&mut document, page, space, regions)?;
        document.prune_objects();
        let mut buffer = export::LimitedBuffer {
            bytes: Vec::new(),
            limit: MAX_FILE_BYTES as usize,
        };
        document.save_to(&mut buffer).map_err(pdf_error)?;
        let mut info = self.add_generated_source(buffer.bytes, "局部擦除.pdf")?;
        if let Some(source) = self.sources.get_mut(&info.id) {
            source.copy_allowed = copy_allowed;
        }
        info.warnings = vec![
            "局部擦除保留图片原分辨率并裁掉选区内的显示内容。裁掉的数据可能仍在文件内。".into(),
        ];
        Ok(info)
    }
}
