// SPDX-License-Identifier: MIT OR Apache-2.0
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.x >= 0.0
            && self.y >= 0.0
            && self.width > 0.0
            && self.height > 0.0
            && self.x + self.width <= 1.000001
            && self.y + self.height <= 1.000001
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub page_a: u32,
    pub page_b: u32,
    pub dpi: u32,
    pub threshold: u8,
    #[serde(rename = "offsetXmm")]
    pub offset_x_mm: f64,
    #[serde(rename = "offsetYmm")]
    pub offset_y_mm: f64,
    #[serde(default)]
    pub ignored: Vec<Rect>,
}
impl Options {
    pub fn validate(&self) -> Result<(), String> {
        if self.page_a > 4999
            || self.page_b > 4999
            || ![150, 300, 600].contains(&self.dpi)
            || !self.offset_x_mm.is_finite()
            || !self.offset_y_mm.is_finite()
            || self.offset_x_mm.abs() > 100.0
            || self.offset_y_mm.abs() > 100.0
            || self.ignored.len() > 16
            || self.ignored.iter().any(|r| !r.valid())
        {
            return Err(
                "对比参数无效：DPI 150/300/600，平移限 ±100 mm，最多 16 个有效忽略区。".into(),
            );
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub file_name: String,
    pub pages: Vec<PageInfo>,
    pub file_size: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub width: f64,
    pub height: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Picture {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub a: Picture,
    pub b: Picture,
    pub width_pt: f64,
    pub height_pt: f64,
    pub origin_x_pt: f64,
    pub origin_y_pt: f64,
    pub uncovered: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub id: u32,
    pub bounds: Rect,
    pub pixels: u64,
    pub added: u64,
    pub removed: u64,
    pub changed: u64,
    pub point: [f64; 2],
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub job_id: String,
    pub options: Options,
    pub width_pt: f64,
    pub height_pt: f64,
    pub origin_x_pt: f64,
    pub origin_y_pt: f64,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub changed_pixels: u64,
    pub ignored_pixels: u64,
    pub uncovered: bool,
    pub regions: Vec<Region>,
    pub mask: Picture,
    pub tile_count: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub job_id: String,
    pub status: String,
    pub completed: u32,
    pub total: u32,
    pub report: Option<Report>,
    pub error: Option<String>,
}
impl Default for Progress {
    fn default() -> Self {
        Self {
            job_id: String::new(),
            status: "idle".into(),
            completed: 0,
            total: 0,
            report: None,
            error: None,
        }
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u64,
    pub command: String,
    #[serde(default)]
    pub args: Value,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Reply {
    pub id: Option<u64>,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub progress: Option<Progress>,
}
impl Reply {
    pub fn response(id: u64, result: Result<Value, String>) -> Self {
        match result {
            Ok(value) => Self {
                id: Some(id),
                result: Some(value),
                error: None,
                progress: None,
            },
            Err(error) => Self {
                id: Some(id),
                result: None,
                error: Some(error),
                progress: None,
            },
        }
    }
}
