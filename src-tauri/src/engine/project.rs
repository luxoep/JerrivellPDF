// SPDX-License-Identifier: MIT OR Apache-2.0
//! Portable editing projects. PDF exports remain ordinary flattened PDFs.
//! Loading builds a separate engine and commits only after every resource and
//! reference has been checked. A malformed project never replaces the session.
use super::*;
use std::collections::{BTreeSet, HashSet};

const MAX_PROJECT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;
const MAX_ASSET_BYTES: usize = 16 * 1024 * 1024;
const MAX_PLAN_BYTES: usize = 1_400_000;

#[derive(serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectFile {
    format: String,
    version: u32,
    title: String,
    workspace: Vec<Value>,
    sources: Vec<ProjectSource>,
    assets: Vec<ProjectAsset>,
}

#[derive(serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectSource {
    id: String,
    file_name: String,
    pdf_base64: String,
}

#[derive(serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectAsset {
    id: String,
    png_base64: String,
    width: u32,
    height: u32,
}

fn invalid(message: impl std::fmt::Display) -> String {
    format!("PROJECT_INVALID: {message}")
}

fn object(value: &Value) -> Result<&serde_json::Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| invalid("项目对象格式无效。"))
}

fn keys(value: &Value, allowed: &[&str]) -> Result<(), String> {
    if object(value)?
        .keys()
        .any(|key| !allowed.contains(&key.as_str()))
    {
        return Err(invalid("项目包含未支持的字段，请使用兼容版本。"));
    }
    Ok(())
}

fn string<'v>(value: &'v Value, maximum: usize, empty: bool) -> Result<&'v str, String> {
    let text = value
        .as_str()
        .ok_or_else(|| invalid("项目文字字段无效。"))?;
    if (!empty && text.is_empty()) || text.encode_utf16().count() > maximum || text.contains('\0') {
        return Err(invalid("项目文字字段为空、过长或包含无效字符。"));
    }
    Ok(text)
}

fn number(value: &Value, low: f64, high: f64) -> Result<f64, String> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= low && *n <= high)
        .ok_or_else(|| invalid("项目数值超出允许范围。"))
}

fn choice(value: &Value, options: &[&str]) -> Result<(), String> {
    if !value.as_str().is_some_and(|v| options.contains(&v)) {
        return Err(invalid("项目选项无效。"));
    }
    Ok(())
}

fn optional_bool(value: Option<&Value>) -> Result<(), String> {
    if value.is_some_and(|v| !v.is_boolean()) {
        return Err(invalid("项目开关格式无效。"));
    }
    Ok(())
}

fn color(value: &Value) -> Result<(), String> {
    let c = string(value, 7, false)?;
    if c.len() != 7 || !c.starts_with('#') || !c.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit) {
        return Err(invalid("项目颜色无效。"));
    }
    Ok(())
}

fn bounds(value: &Value) -> Result<(), String> {
    keys(value, &["x", "y", "width", "height"])?;
    let x = number(&value["x"], 0.0, 1.0)?;
    let y = number(&value["y"], 0.0, 1.0)?;
    let width = number(&value["width"], 0.000001, 1.0)?;
    let height = number(&value["height"], 0.000001, 1.0)?;
    if x + width > 1.000001 || y + height > 1.000001 {
        return Err(invalid("项目对象超出页面。"));
    }
    Ok(())
}

fn validate_text(value: &Value) -> Result<(), String> {
    keys(
        value,
        &[
            "content",
            "color",
            "fontSize",
            "bold",
            "fontFamily",
            "italic",
            "underline",
            "strikeout",
            "alignment",
            "charSpacing",
            "lineHeight",
            "wrapWidth",
            "frame",
        ],
    )?;
    string(&value["content"], 4000, false)?;
    string(&value["fontFamily"], 256, false)?;
    color(&value["color"])?;
    number(&value["fontSize"], 6.0, 144.0)?;
    if !value["bold"].is_boolean() {
        return Err(invalid("文字粗体设置无效。"));
    }
    for field in ["italic", "underline", "strikeout"] {
        optional_bool(value.get(field))?;
    }
    if let Some(v) = value.get("alignment") {
        choice(v, &["left", "center", "right"])?;
    }
    for (field, low, high) in [
        ("charSpacing", -2.0, 20.0),
        ("lineHeight", 0.8, 3.0),
        ("wrapWidth", 24.0, 1800.0),
    ] {
        if let Some(v) = value.get(field) {
            number(v, low, high)?;
        }
    }
    if let Some(frame) = value.get("frame") {
        keys(frame, &["width", "height", "autoHeight"])?;
        number(&frame["width"], 24.0, 2048.0)?;
        number(&frame["height"], 12.0, 4096.0)?;
        if !frame["autoHeight"].is_boolean() {
            return Err(invalid("文字框高度模式无效。"));
        }
    }
    Ok(())
}

fn validate_mark(value: &Value) -> Result<(), String> {
    keys(value, &["geometry", "color"])?;
    color(&value["color"])?;
    let g = &value["geometry"];
    keys(
        g,
        &[
            "tool",
            "bounds",
            "points",
            "pageWidth",
            "pageHeight",
            "lineWidth",
            "lineStyle",
            "arrowHeads",
        ],
    )?;
    choice(
        &g["tool"],
        &[
            "highlight",
            "block",
            "rectangle",
            "ellipse",
            "line",
            "arrow",
            "pen",
            "polyline",
            "polyarrow",
            "callout",
        ],
    )?;
    bounds(&g["bounds"])?;
    number(&g["pageWidth"], 1.0, 200000.0)?;
    number(&g["pageHeight"], 1.0, 200000.0)?;
    number(&g["lineWidth"], 0.5, 12.0)?;
    if let Some(v) = g.get("lineStyle") {
        choice(v, &["solid", "dashed", "dashDot", "dashDotDot"])?;
    }
    if let Some(v) = g.get("arrowHeads") {
        choice(v, &["none", "start", "end", "both"])?;
    }
    let points = g["points"]
        .as_array()
        .ok_or_else(|| invalid("折线节点无效。"))?;
    if !(2..=2000).contains(&points.len()) {
        return Err(invalid("折线节点数量无效。"));
    }
    for point in points {
        keys(point, &["x", "y"])?;
        number(&point["x"], 0.0, 1.0)?;
        number(&point["y"], 0.0, 1.0)?;
    }
    Ok(())
}

pub(super) fn page_reference(value: &Value) -> Result<PageRef, String> {
    keys(
        value,
        &[
            "id",
            "documentId",
            "pageIndex",
            "rotation",
            "width",
            "height",
            "sourceName",
            "overlays",
            "contentEdits",
            "decorations",
        ],
    )?;
    string(&value["id"], 128, false)?;
    string(&value["documentId"], 128, false)?;
    number(&value["width"], 0.000001, 200000.0)?;
    number(&value["height"], 0.000001, 200000.0)?;
    string(&value["sourceName"], 260, true)?;
    let overlays = value.get("overlays").cloned().unwrap_or_else(|| json!([]));
    let items = overlays
        .as_array()
        .ok_or_else(|| invalid("项目图层列表无效。"))?;
    if items.len() > 64 {
        return Err(invalid("项目每页最多支持 64 个添加对象。"));
    }
    let mut clean = Vec::new();
    let mut ids = HashSet::new();
    for item in items {
        keys(
            item,
            &[
                "id",
                "assetId",
                "x",
                "y",
                "width",
                "height",
                "opacity",
                "rotation",
                "blendMode",
                "locked",
                "textSource",
                "markSource",
                "leaderFor",
            ],
        )?;
        let id = string(&item["id"], 128, false)?;
        if !ids.insert(id) {
            return Err(invalid("项目对象标识重复。"));
        }
        optional_bool(item.get("locked"))?;
        if let Some(v) = item.get("textSource") {
            validate_text(v)?;
        }
        if let Some(v) = item.get("markSource") {
            validate_mark(v)?;
        }
        if item.get("textSource").is_some() && item.get("markSource").is_some() {
            return Err(invalid("对象来源类型冲突。"));
        }
        let mut native = object(item)?.clone();
        for field in ["locked", "textSource", "markSource", "leaderFor"] {
            native.remove(field);
        }
        clean.push(Value::Object(native));
    }
    for item in items {
        if let Some(v) = item.get("leaderFor") {
            let target = string(v, 128, false)?;
            if item.get("markSource").is_none()
                || !items.iter().any(|candidate| {
                    candidate["id"].as_str() == Some(target)
                        && candidate.get("textSource").is_some()
                })
            {
                return Err(invalid("文字引线缺少关联文字框。"));
            }
        }
    }
    serde_json::from_value(json!({"documentId":value["documentId"],"pageIndex":value["pageIndex"],"rotation":value["rotation"],"overlays":clean,
        "contentEdits":value.get("contentEdits").cloned().unwrap_or_else(||json!([])),"decorations":value.get("decorations").cloned().unwrap_or_else(||json!([]))}))
        .map_err(|e| invalid(format!("项目页面结构无效：{e}")))
}

pub(super) fn references(pages: &[Value]) -> Result<Vec<PageRef>, String> {
    if pages.is_empty()
        || pages.len() > MAX_PAGES
        || serde_json::to_vec(pages).map_err(pdf_error)?.len() > MAX_PLAN_BYTES
    {
        return Err(invalid("项目须为 1～5000 页，编辑结构不得超过 1.4 MB。"));
    }
    let mut ids = HashSet::new();
    pages
        .iter()
        .map(|page| {
            let reference = page_reference(page)?;
            if !ids.insert(page["id"].as_str().unwrap()) {
                return Err(invalid("项目页面标识重复。"));
            }
            Ok(reference)
        })
        .collect()
}

fn asset_ids(refs: &[PageRef]) -> BTreeSet<String> {
    refs.iter()
        .flat_map(|page| {
            page.overlays.iter().map(|o| o.asset_id.clone()).chain(
                page.content_edits
                    .iter()
                    .filter_map(|e| e.replacement_asset_id.clone()),
            )
        })
        .collect()
}

/// PDFium may rewrite numeric spelling when taking the source snapshot.
/// Rebase only objects whose identity and visible geometry survived that
/// serialization; never apply an old fingerprint to an unrelated object.
fn rebase_source_edits(
    original: &PdfEngine<'_>,
    snapshot: &PdfEngine<'_>,
    document_id: &str,
    pages: &mut [Value],
    refs: &[PageRef],
) -> Result<(), String> {
    for (metadata, reference) in pages.iter_mut().zip(refs) {
        if reference.document_id != document_id || reference.content_edits.is_empty() {
            continue;
        }
        let mut clean = reference.clone();
        clean.overlays.clear();
        clean.content_edits.clear();
        clean.decorations.clear();
        let before = original.inspect_page_content(&clean).map_err(invalid)?;
        let after = snapshot.inspect_page_content(&clean).map_err(invalid)?;
        for (position, edit) in reference.content_edits.iter().enumerate() {
            let first = before
                .objects
                .iter()
                .find(|o| o.object_index == edit.object_index && o.fingerprint == edit.fingerprint)
                .ok_or_else(|| invalid("项目原文来源已变化。"))?;
            let next = after
                .objects
                .iter()
                .find(|o| o.object_index == edit.object_index && o.editable)
                .ok_or_else(|| invalid("该原文对象暂不支持便携保存。"))?;
            let same_bounds = [
                (first.original_bounds.x, next.original_bounds.x),
                (first.original_bounds.y, next.original_bounds.y),
                (first.original_bounds.width, next.original_bounds.width),
                (first.original_bounds.height, next.original_bounds.height),
            ]
            .iter()
            .all(|(a, b)| (*a - *b).abs() <= 0.00001);
            if first.kind != next.kind
                || first.original_text != next.original_text
                || first.font_family != next.font_family
                || first.fill_color != next.fill_color
                || first.font_size != next.font_size
                || !same_bounds
            {
                return Err(invalid("原文对象在源快照保存中发生变化，已停止项目保存。"));
            }
            metadata["contentEdits"][position]["fingerprint"] = json!(next.fingerprint);
        }
    }
    Ok(())
}

fn validate_plan(engine: &PdfEngine<'_>, pages: &[Value], refs: &[PageRef]) -> Result<(), String> {
    for (metadata, page) in pages.iter().zip(refs) {
        let source = engine.source(page).map_err(invalid)?;
        let source_page = source
            .document
            .pages()
            .get(page.page_index as i32)
            .map_err(pdf_error)?;
        if (metadata["width"].as_f64().unwrap() - source_page.width().value as f64).abs() > 0.01
            || (metadata["height"].as_f64().unwrap() - source_page.height().value as f64).abs()
                > 0.01
        {
            return Err(invalid("项目页面尺寸与嵌入来源不一致。"));
        }
        if page.content_edits.len() > 128 || page.decorations.len() > 32 {
            return Err(invalid("页面编辑数量超出限制。"));
        }
        if let Some(edits) = metadata.get("contentEdits").and_then(Value::as_array) {
            for edit in edits {
                for field in ["bold", "italic", "deleted"] {
                    optional_bool(edit.get(field))?;
                }
            }
        }
        let mut edit_ids = HashSet::new();
        for edit in &page.content_edits {
            if !edit_ids.insert(edit.object_index)
                || edit.object_index >= 2048
                || edit.fingerprint.len() > 128
                || edit.text.as_ref().is_some_and(|s| {
                    s.encode_utf16().count() > 2000 || s.chars().any(char::is_control)
                })
                || edit.font_family.as_ref().is_some_and(|s| {
                    s.is_empty() || s.encode_utf16().count() > 256 || s.contains('\0')
                })
                || edit
                    .font_size
                    .is_some_and(|n| !n.is_finite() || !(0.1..=512.0).contains(&n))
                || edit
                    .opacity
                    .is_some_and(|n| !n.is_finite() || !(0.0..=1.0).contains(&n))
            {
                return Err(invalid("原文编辑结构无效。"));
            }
            if let Some(v) = &edit.bounds {
                bounds(&serde_json::to_value(v).map_err(pdf_error)?)?;
            }
            if let Some(v) = &edit.fill_color {
                color(&json!(v))?;
            }
            if let Some(id) = &edit.replacement_asset_id {
                if !engine.assets.contains_key(id) {
                    return Err(invalid("原文替换图片缺失。"));
                }
            }
        }
        if !page.content_edits.is_empty() {
            let mut original = page.clone();
            original.content_edits.clear();
            original.overlays.clear();
            original.decorations.clear();
            let content = engine.inspect_page_content(&original).map_err(invalid)?;
            for edit in &page.content_edits {
                if !content.objects.iter().any(|o| {
                    o.object_index == edit.object_index
                        && o.fingerprint == edit.fingerprint
                        && o.editable
                }) {
                    return Err(invalid("项目原文对象与来源指纹不匹配。"));
                }
            }
        }
        let mut decoration_ids = HashSet::new();
        for item in &page.decorations {
            if item.id.is_empty()
                || item.id.len() > 128
                || !decoration_ids.insert(&item.id)
                || !matches!(item.kind.as_str(), "number" | "watermark")
                || !matches!(item.alignment.as_str(), "left" | "center" | "right")
                || item.text.encode_utf16().count() > 200
                || item
                    .font_family
                    .as_ref()
                    .is_some_and(|s| s.encode_utf16().count() > 256 || s.contains('\0'))
                || ![item.x, item.y, item.font_size, item.opacity, item.angle]
                    .iter()
                    .all(|n| n.is_finite())
                || !(0.0..=1.0).contains(&item.x)
                || !(0.0..=1.0).contains(&item.y)
                || !(0.0..=1.0).contains(&item.opacity)
                || !(1.0..=512.0).contains(&item.font_size)
                || !(-180.0..=180.0).contains(&item.angle)
            {
                return Err(invalid("项目页码或水印无效。"));
            }
            color(&json!(item.color))?;
        }
    }
    Ok(())
}

fn remap(
    value: &mut Value,
    documents: &HashMap<String, String>,
    assets: &HashMap<String, String>,
    field: &str,
) -> Result<(), String> {
    if let Value::String(id) = value {
        let mapping = if field == "documentId" {
            Some(documents)
        } else if matches!(field, "assetId" | "replacementAssetId") {
            Some(assets)
        } else {
            None
        };
        if let Some(mapping) = mapping {
            *id = mapping
                .get(id)
                .ok_or_else(|| invalid("项目引用了缺失资源。"))?
                .clone();
        }
    } else if let Value::Array(items) = value {
        for item in items {
            remap(item, documents, assets, "")?;
        }
    } else if let Value::Object(fields) = value {
        for (key, item) in fields {
            remap(item, documents, assets, key)?;
        }
    }
    Ok(())
}

struct MemoryWriter {
    data: Vec<u8>,
    limit: usize,
}
impl Write for MemoryWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.data.len()) {
            return Err(std::io::Error::other("项目大小超过限制"));
        }
        self.data.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> PdfEngine<'a> {
    pub fn save_editable_project(
        &self,
        path: &str,
        mut pages: Vec<Value>,
        title: &str,
    ) -> Result<Value, String> {
        string(&json!(title), 260, false)?;
        let refs = references(&pages)?;
        validate_plan(self, &pages, &refs)?;
        let destination = self.destination(path, "jvp")?;
        let mut sources = Vec::new();
        let mut source_bytes = 0;
        let document_ids: BTreeSet<_> = refs.iter().map(|p| p.document_id.clone()).collect();
        if document_ids.len() > 32 {
            return Err(invalid("可编辑项目最多支持 32 个来源。"));
        }
        for id in document_ids {
            let source = &self.sources[&id];
            let mut writer = MemoryWriter {
                data: Vec::new(),
                limit: MAX_SOURCE_BYTES - source_bytes,
            };
            source
                .document
                .save_to_writer(&mut writer)
                .map_err(|_| invalid("项目源 PDF 合计超过 64 MiB，或该来源暂不支持保存。"))?;
            // Project files never store passwords. Refuse encrypted snapshots
            // that cannot reopen independently rather than save a broken file.
            let reopened = self.pdfium.load_pdf_from_byte_vec(writer.data.clone(), None)
                .map_err(|_| invalid("该来源需要密码才能重新打开，暂不能保存为便携项目；可先保存 PDF 副本再导入。"))?;
            if reopened.pages().len() != source.document.pages().len() {
                return Err(invalid("嵌入来源页数校验失败。"));
            }
            let mut snapshot = PdfEngine::new(self.pdfium);
            snapshot.sources.insert(
                id.clone(),
                Source {
                    document: reopened,
                    path: None,
                    size: writer.data.len() as u64,
                },
            );
            rebase_source_edits(self, &snapshot, &id, &mut pages, &refs)?;
            source_bytes += writer.data.len();
            let name = pages
                .iter()
                .find(|p| p["documentId"].as_str() == Some(&id))
                .and_then(|p| p["sourceName"].as_str())
                .filter(|name| !name.is_empty())
                .unwrap_or("source.pdf");
            sources.push(ProjectSource {
                id,
                file_name: name
                    .rsplit(['/', '\\'])
                    .next()
                    .filter(|name| !name.is_empty())
                    .unwrap_or("source.pdf")
                    .into(),
                pdf_base64: base64::engine::general_purpose::STANDARD.encode(&writer.data),
            });
        }
        let mut assets = Vec::new();
        let mut asset_bytes = 0;
        for id in asset_ids(&refs) {
            let image = self
                .assets
                .get(&id)
                .ok_or_else(|| invalid("项目图片资源缺失。"))?;
            asset_bytes += image.png.len();
            if assets.len() >= 64 || asset_bytes > MAX_ASSET_BYTES {
                return Err(invalid("项目图片资源超过 64 个或 16 MiB。"));
            }
            assets.push(ProjectAsset {
                id,
                width: image.width,
                height: image.height,
                png_base64: base64::engine::general_purpose::STANDARD.encode(&image.png),
            });
        }
        for page in &mut pages {
            if let Some(name) = page["sourceName"].as_str() {
                page["sourceName"] = json!(name.rsplit(['/', '\\']).next().unwrap_or("source.pdf"));
            }
        }
        let file = ProjectFile {
            format: "jerrivell-project".into(),
            version: 1,
            title: title.into(),
            workspace: pages,
            sources,
            assets,
        };
        let mut temporary =
            NamedTempFile::new_in(destination.parent().unwrap()).map_err(pdf_error)?;
        let mut writer = LimitedWriter {
            file: temporary.as_file().try_clone().map_err(pdf_error)?,
            written: 0,
            limit: MAX_PROJECT_BYTES,
        };
        serde_json::to_writer(&mut writer, &file).map_err(pdf_error)?;
        writer.flush().map_err(pdf_error)?;
        drop(writer);
        temporary.as_file_mut().sync_all().map_err(pdf_error)?;
        self.destination(path, "jvp")?;
        temporary
            .persist(&destination)
            .map_err(|e| format!("无法提交项目保存，已有目标文件保持不变：{}", e.error))?;
        Ok(json!({"path":destination.to_string_lossy(),"pageCount":refs.len()}))
    }

    pub fn load_editable_project(&mut self, path: &str) -> Result<Value, String> {
        let canonical = fs::canonicalize(path).map_err(pdf_error)?;
        if !canonical
            .extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("jvp"))
        {
            return Err(invalid("请选择 .jvp 可编辑项目。"));
        }
        let file = File::open(&canonical).map_err(pdf_error)?;
        let size = file.metadata().map_err(pdf_error)?.len();
        if size == 0 || size > MAX_PROJECT_BYTES {
            return Err(invalid("项目为空或超过 128 MiB。"));
        }
        let mut bytes = Vec::new();
        file.take(MAX_PROJECT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(pdf_error)?;
        if bytes.len() as u64 > MAX_PROJECT_BYTES {
            return Err(invalid("项目读取期间超过限制。"));
        }
        let mut project: ProjectFile =
            serde_json::from_slice(&bytes).map_err(|e| invalid(format!("项目文件无效：{e}")))?;
        drop(bytes);
        if project.format != "jerrivell-project"
            || project.version != 1
            || project.sources.is_empty()
            || project.sources.len() > 32
            || project.assets.len() > 64
        {
            return Err(invalid("项目版本、来源或图片数量不受支持。"));
        }
        string(&json!(project.title), 260, false)?;
        let old_refs = references(&project.workspace)?;
        let used_documents: BTreeSet<_> = old_refs.iter().map(|p| p.document_id.clone()).collect();
        let used_assets = asset_ids(&old_refs);
        if used_documents.len() != project.sources.len()
            || used_assets.len() != project.assets.len()
        {
            return Err(invalid("项目资源列表与页面引用不一致。"));
        }
        let mut candidate = PdfEngine::new(self.pdfium);
        candidate.next_id = self.next_id;
        candidate.next_asset_id = self.next_asset_id;
        candidate.next_job = self.next_job;
        let mut document_mapping = HashMap::new();
        let mut asset_mapping = HashMap::new();
        let mut documents = Vec::new();
        let mut images = Vec::new();
        let mut source_bytes = 0;
        let mut asset_bytes = 0;
        let mut decoded_bytes = 0_u64;
        for source in project.sources {
            string(&json!(source.id), 128, false)?;
            string(&json!(source.file_name), 260, false)?;
            if !used_documents.contains(&source.id)
                || document_mapping.contains_key(&source.id)
                || source.pdf_base64.len() > (MAX_SOURCE_BYTES - source_bytes) / 3 * 4 + 4
            {
                return Err(invalid("项目来源重复、缺失或过大。"));
            }
            let pdf = base64::engine::general_purpose::STANDARD
                .decode(source.pdf_base64)
                .map_err(|_| invalid("嵌入 PDF 编码无效。"))?;
            source_bytes += pdf.len();
            if pdf.is_empty() || source_bytes > MAX_SOURCE_BYTES {
                return Err(invalid("嵌入 PDF 合计超过 64 MiB。"));
            }
            let length = pdf.len() as u64;
            let document = candidate
                .pdfium
                .load_pdf_from_byte_vec(pdf, None)
                .map_err(|e| invalid(format!("嵌入 PDF 无法打开：{e}")))?;
            let count = document.pages().len();
            if count <= 0 || count as usize > MAX_PAGES {
                return Err(invalid("嵌入 PDF 页数无效。"));
            }
            let mut info = Vec::new();
            for index in 0..count {
                let page = document.pages().get(index).map_err(pdf_error)?;
                valid_page_size(page.width().value, page.height().value)?;
                info.push(PageInfo {
                    index: index as u32,
                    width: page.width().value,
                    height: page.height().value,
                    rotation: page.rotation().map_err(pdf_error)?.as_degrees() as u16,
                });
            }
            let id = format!("project-{}-{}", std::process::id(), candidate.next_id);
            candidate.next_id += 1;
            let file_name = source
                .file_name
                .rsplit(['/', '\\'])
                .next()
                .filter(|name| !name.is_empty())
                .unwrap_or("source.pdf")
                .to_string();
            documents.push(DocumentInfo { id: id.clone(), path: format!("memory://{id}/{file_name}"), file_name, page_count: count as u32, file_size: length, pages: info,
                warnings: vec!["此来源保存在可编辑项目内；PDF 导出不保留项目编辑结构。字体不随项目分发，异机编辑可能需要选择本机字体。".into()] });
            candidate.sources.insert(
                id.clone(),
                Source {
                    document,
                    path: None,
                    size: length,
                },
            );
            document_mapping.insert(source.id, id);
        }
        for asset in project.assets {
            string(&json!(asset.id), 128, false)?;
            if !used_assets.contains(&asset.id)
                || asset_mapping.contains_key(&asset.id)
                || asset.png_base64.len() > (MAX_ASSET_BYTES - asset_bytes) / 3 * 4 + 4
            {
                return Err(invalid("项目图片重复、缺失或过大。"));
            }
            let png = base64::engine::general_purpose::STANDARD
                .decode(asset.png_base64)
                .map_err(|_| invalid("嵌入图片编码无效。"))?;
            asset_bytes += png.len();
            if png.is_empty() || asset_bytes > MAX_ASSET_BYTES {
                return Err(invalid("项目图片合计超过 16 MiB。"));
            }
            let image = assets::normalized_image(&png, true).map_err(invalid)?;
            let dimensions = image::ImageReader::with_format(Cursor::new(&png), ImageFormat::Png)
                .into_dimensions()
                .map_err(invalid)?;
            if image.width() != asset.width
                || image.height() != asset.height
                || dimensions != (asset.width, asset.height)
            {
                return Err(invalid("嵌入图片尺寸校验失败。"));
            }
            decoded_bytes += asset.width as u64 * asset.height as u64 * 4;
            if decoded_bytes > 128 * 1024 * 1024 {
                return Err(invalid("项目图片解码量超过 128 MiB。"));
            }
            let id = format!(
                "project-image-{}-{}",
                std::process::id(),
                candidate.next_asset_id
            );
            candidate.next_asset_id += 1;
            images.push(ImageAssetInfo {
                id: id.clone(),
                width: asset.width,
                height: asset.height,
                data_url: format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&png)
                ),
            });
            candidate.assets.insert(
                id.clone(),
                ImageAsset {
                    png,
                    width: asset.width,
                    height: asset.height,
                    source_paths: vec![],
                },
            );
            asset_mapping.insert(asset.id, id);
        }
        for page in &mut project.workspace {
            remap(page, &document_mapping, &asset_mapping, "")?;
        }
        let refs = references(&project.workspace)?;
        validate_plan(&candidate, &project.workspace, &refs)?;
        // Construct the entire success response before the only mutation of the
        // active engine. No fallible operation is allowed after this assignment.
        let result = json!({"title":project.title,"workspace":project.workspace,"documents":documents,"assets":images});
        *self = candidate;
        Ok(result)
    }
}
