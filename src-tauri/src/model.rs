use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub engine_ready: bool,
    pub engine_version: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageRef {
    pub document_id: String,
    pub page_index: u32,
    /// Additional clockwise rotation; the source's intrinsic rotation is retained.
    pub rotation: u16,
    #[serde(default)]
    pub overlays: Vec<PageOverlay>,
    #[serde(default)]
    pub content_edits: Vec<ContentEdit>,
    #[serde(default)]
    pub decorations: Vec<PageDecoration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageDecoration {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub font_family: Option<String>,
    pub font_size: f32,
    pub color: String,
    pub opacity: f32,
    pub angle: f32,
    pub x: f32,
    pub y: f32,
    pub alignment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportPart {
    pub name: String,
    pub pages: Vec<PageRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GeneratePages {
    Blank {
        width: f32,
        height: f32,
        count: u32,
    },
    Images {
        paths: Vec<String>,
        paper: String,
        margin: f32,
    },
    Crop {
        pages: Vec<PageRef>,
        bounds: ContentBounds,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineObjectRef {
    pub object_index: u32,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineEditRequest {
    pub page: PageRef,
    pub objects: Vec<LineObjectRef>,
    pub bounds: ContentBounds,
    pub text: String,
    pub font_family: Option<String>,
    pub font_size: f32,
    pub color: String,
    pub char_spacing: f32,
    pub alignment: String,
    pub constrain_width: bool,
    #[serde(default)]
    pub target_bounds: Option<ContentBounds>,
    #[serde(default)]
    pub bold: Option<bool>,
    #[serde(default)]
    pub italic: Option<bool>,
    #[serde(default = "opaque_text")]
    pub opacity: f32,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub strikeout: bool,
}

fn opaque_text() -> f32 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentBounds {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentEdit {
    pub object_index: u32,
    pub fingerprint: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default)]
    pub font_size: Option<f32>,
    #[serde(default)]
    pub fill_color: Option<String>,
    #[serde(default)]
    pub bold: Option<bool>,
    #[serde(default)]
    pub italic: Option<bool>,
    #[serde(default)]
    pub opacity: Option<f32>,
    #[serde(default)]
    pub bounds: Option<ContentBounds>,
    #[serde(default)]
    pub deleted: Option<bool>,
    #[serde(default)]
    pub replacement_asset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentObject {
    pub object_index: u32,
    pub fingerprint: String,
    pub kind: String,
    pub bounds: ContentBounds,
    pub original_bounds: ContentBounds,
    pub text: Option<String>,
    pub original_text: Option<String>,
    pub font_family: Option<String>,
    pub font_size: Option<f32>,
    pub fill_color: Option<String>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub opacity: Option<f32>,
    pub editable: bool,
    pub reason: Option<String>,
    pub deleted: bool,
    pub text_angle: Option<f32>,
    pub rendered_font_size: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageContent {
    pub objects: Vec<ContentObject>,
    pub total_objects: u32,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageOverlay {
    pub id: String,
    pub asset_id: String,
    /// Coordinates refer to the final displayed page, normalized from its top-left.
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub opacity: f32,
    #[serde(default)]
    pub rotation: u16,
    #[serde(default)]
    pub blend_mode: OverlayBlendMode,
}

#[derive(Debug, Default, Copy, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OverlayBlendMode {
    #[default]
    Normal,
    Multiply,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfStampCrop {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<ImagePoint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub regions: Vec<PdfStampCrop>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImagePoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EraseStroke {
    pub points: Vec<ImagePoint>,
    pub width: f32,
    #[serde(default)]
    pub mode: EraseMode,
}

#[derive(Debug, Default, Copy, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EraseMode {
    #[default]
    Transparent,
    Repair,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAssetInfo {
    pub id: String,
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfStampInfo {
    #[serde(flatten)]
    pub image: ImageAssetInfo,
    pub page_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub index: u32,
    pub width: f32,
    pub height: f32,
    pub rotation: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub page_count: u32,
    pub file_size: u64,
    pub pages: Vec<PageInfo>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPage {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectPreviewLayers {
    pub lower: RenderedPage,
    pub moving: RenderedPage,
    pub upper: RenderedPage,
    pub foreground: Vec<RenderedPreviewLayer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPageLayers {
    pub background: RenderedPage,
    pub foreground: Vec<RenderedPreviewLayer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPreviewLayer {
    pub image: RenderedPage,
    pub blend_mode: OverlayBlendMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub page_index: u32,
    pub match_count: usize,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDocument {
    pub path: String,
    pub page_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedPage {
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerRequest {
    pub id: u64,
    pub command: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WorkerResponse {
    pub id: u64,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}
