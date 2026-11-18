// SPDX-License-Identifier: MIT OR Apache-2.0
use super::{local_location, Engine, Source, MAX_INPUT, MAX_PIXELS};
use crate::compare::types::{Options, Region, SourceInfo};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File, Metadata},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

const FORMAT: &str = "jerrivell-drawing-review";
const VERSION: u32 = 1;
const EXTENSION: &str = "jvcmp";
const MAX_PROJECT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PATH_UTF16: usize = 32_760;
const MAX_REVIEW: usize = 5_000;
const MAX_NOTE_UTF16: usize = 500;
const MAX_NOTES_BYTES: usize = 256 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SourceReference {
    path: String,
    pub(super) bytes: u64,
    pub(super) sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewEntry {
    region: Region,
    reviewed: bool,
    note: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewInput {
    region_id: u32,
    reviewed: bool,
    note: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Project {
    format: String,
    version: u32,
    source_a: SourceReference,
    source_b: SourceReference,
    options: Options,
    review: Vec<ReviewEntry>,
    selected_region: Option<Region>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::compare) struct SaveRequest {
    path: String,
    options: Options,
    job_id: Option<String>,
    review: Vec<ReviewInput>,
    selected_region_id: Option<u32>,
    #[serde(default)]
    overwrite: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::compare) struct OpenRequest {
    path: String,
    source_a_path: Option<String>,
    source_b_path: Option<String>,
    password_a: Option<String>,
    password_b: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::compare) struct SavedProject {
    file_name: String,
    bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::compare) struct OpenedProject {
    file_name: String,
    a: SourceInfo,
    b: SourceInfo,
    options: Options,
    review: Vec<ReviewEntry>,
    selected_region: Option<Region>,
}

fn valid_region(region: &Region) -> bool {
    region.id > 0
        && region.id <= MAX_REVIEW as u32
        && region.bounds.valid()
        && region.pixels > 0
        && region.pixels <= MAX_PIXELS
        && region
            .added
            .checked_add(region.removed)
            .and_then(|value| value.checked_add(region.changed))
            == Some(region.pixels)
        && region.point.iter().all(|point| (0.0..1.0).contains(point))
}

fn validate_review(review: &[ReviewEntry], selected: Option<&Region>) -> Result<(), String> {
    if review.len() > MAX_REVIEW
        || review.iter().map(|entry| entry.note.len()).sum::<usize>() > MAX_NOTES_BYTES
    {
        return Err("复核项目超过差异项或备注大小上限。".into());
    }
    let mut ids = HashSet::new();
    if review.iter().any(|entry| {
        !ids.insert(entry.region.id)
            || !valid_region(&entry.region)
            || entry.note.encode_utf16().count() > MAX_NOTE_UTF16
            || entry
                .note
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r')
    }) || selected.is_some_and(|region| !valid_region(region))
    {
        return Err("复核项目包含无效的差异位置或备注。".into());
    }
    Ok(())
}

// Require disk-qualified, normalized path components before any filesystem
// operation. In particular, a colon in a file name could address an NTFS stream.
fn check_path(path: &Path, extension: &str) -> Result<(), String> {
    if !path.is_absolute()
        || path.as_os_str().to_string_lossy().encode_utf16().count() > MAX_PATH_UTF16
        || !path
            .extension()
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
        || path.components().any(|component| match component {
            Component::Normal(name) => !plain_component(&name.to_string_lossy()),
            Component::CurDir | Component::ParentDir => true,
            _ => false,
        })
    {
        return Err(format!("请选择本地磁盘上的 .{extension} 文件。"));
    }
    local_location(path)
}

fn plain_component(name: &str) -> bool {
    if name.is_empty() || name.chars().any(|value| value.is_control() || value == ':') {
        return false;
    }
    #[cfg(windows)]
    {
        let stem = name
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end()
            .to_ascii_uppercase();
        if name.ends_with([' ', '.'])
            || name.contains(['<', '>', '"', '|', '?', '*'])
            || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"].contains(&stem.as_str())
            || stem
                .strip_prefix("COM")
                .or_else(|| stem.strip_prefix("LPT"))
                .is_some_and(|number| {
                    [
                        "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³",
                    ]
                    .contains(&number)
                })
        {
            return false;
        }
    }
    true
}

fn ordinary_location(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        const OFFLINE: u32 = 0x1000;
        const RECALL_ON_OPEN: u32 = 0x40000;
        const RECALL_ON_DATA_ACCESS: u32 = 0x400000;
        metadata.file_attributes()
            & (REPARSE_POINT | OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS)
            == 0
    }
    #[cfg(not(windows))]
    true
}

// Each ancestor is checked before visiting its descendants. This keeps project
// references from following junctions into network or on-demand cloud folders.
fn checked_local_file(path: &Path, extension: &str) -> Result<(), String> {
    check_path(path, extension)?;
    checked_components(path, false)
}

fn checked_components(path: &Path, directory: bool) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        if !matches!(component, Component::Normal(_)) {
            continue;
        }
        let metadata = fs::symlink_metadata(&current).map_err(|_| "无法访问本地文件路径。")?;
        let valid_kind = if current == path && !directory {
            metadata.is_file()
        } else {
            metadata.is_dir()
        };
        if !ordinary_location(&metadata) || !valid_kind {
            return Err("复核项目仅接受本地普通文件。请将文件复制到非同步的本地文件夹。".into());
        }
    }
    Ok(())
}

impl SourceReference {
    fn from_source(source: &Source<'_>) -> Result<Self, String> {
        let path = source.path.to_str().ok_or("来源路径包含无法保存的字符。")?;
        check_path(&source.path, "pdf")?;
        Ok(Self {
            path: path.to_owned(),
            bytes: source.size,
            sha256: source.sha256.clone(),
        })
    }

    fn validate(&self) -> Result<(), String> {
        if self.bytes == 0
            || self.bytes > MAX_INPUT
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
        {
            return Err("复核项目记录的来源校验值无效。".into());
        }
        Ok(())
    }
}

fn project_file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn read_project(path: &Path) -> Result<Project, String> {
    checked_local_file(path, EXTENSION)?;
    let file = File::open(path).map_err(|_| "无法打开复核项目。")?;
    let mut data = Vec::new();
    file.take(MAX_PROJECT_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|_| "无法读取复核项目。")?;
    if data.is_empty() || data.len() as u64 > MAX_PROJECT_BYTES {
        return Err("复核项目为空或超过 4 MiB 上限。".into());
    }
    let project: Project = serde_json::from_slice(&data).map_err(|_| "复核项目内容无效。")?;
    if project.format != FORMAT || project.version != VERSION {
        return Err("不支持此复核项目格式或版本。".into());
    }
    project.options.validate()?;
    project.source_a.validate()?;
    project.source_b.validate()?;
    validate_review(&project.review, project.selected_region.as_ref())?;
    Ok(project)
}

fn region_from_report(regions: &[Region], id: u32) -> Result<Region, String> {
    // IDs are only used when saving an active result with the matching job ID.
    // Coordinate and pixel evidence come from the worker's report and are later
    // checked against the recomputed result when reopening.
    regions
        .get(id.saturating_sub(1) as usize)
        .filter(|region| region.id == id)
        .cloned()
        .ok_or_else(|| "复核项不属于当前分析结果，请重新核对。".into())
}

impl<'a> Engine<'a> {
    pub(in crate::compare) fn save_project(
        &self,
        request: SaveRequest,
    ) -> Result<SavedProject, String> {
        let SaveRequest {
            path,
            options,
            job_id,
            review,
            selected_region_id,
            overwrite,
        } = request;
        options.validate()?;
        if review.len() > MAX_REVIEW {
            return Err("复核项目超过差异项上限。".into());
        }
        self.pages(&options)?;
        let (review, selected_region) =
            if job_id.is_some() || !review.is_empty() || selected_region_id.is_some() {
                let report = self
                    .last
                    .as_ref()
                    .map(|(report, _)| report)
                    .filter(|report| {
                        Some(report.job_id.as_str()) == job_id.as_deref()
                            && report.options == options
                    })
                    .ok_or("复核内容不属于当前分析参数，请重新分析后保存。")?;
                let entries = review
                    .into_iter()
                    .map(|entry| {
                        Ok(ReviewEntry {
                            region: region_from_report(&report.regions, entry.region_id)?,
                            reviewed: entry.reviewed,
                            note: entry.note,
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                let selected = selected_region_id
                    .map(|id| region_from_report(&report.regions, id))
                    .transpose()?;
                (entries, selected)
            } else {
                (Vec::new(), None)
            };
        validate_review(&review, selected_region.as_ref())?;
        let source_a =
            SourceReference::from_source(self.a.as_ref().ok_or("请先打开旧版图纸 A。")?)?;
        let source_b =
            SourceReference::from_source(self.b.as_ref().ok_or("请先打开新版图纸 B。")?)?;
        let path = Path::new(&path);
        check_path(path, EXTENSION)?;
        let requested_parent = path.parent().ok_or("请选择本地输出目录。")?;
        checked_components(requested_parent, true)?;
        let parent = requested_parent
            .canonicalize()
            .map_err(|_| "输出目录不存在或不可访问。")?;
        local_location(&parent)?;
        let destination = parent.join(path.file_name().ok_or("输出文件名无效。")?);
        let old_file = match fs::symlink_metadata(&destination) {
            Ok(existing) if existing.is_file() && ordinary_location(&existing) => true,
            Ok(_) => return Err("请选择普通本地文件作为保存目标。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => return Err("无法检查保存位置。".into()),
        };
        if old_file && !overwrite {
            return Err("PROJECT_EXISTS: 已存在同名复核项目。".into());
        }
        if old_file
            && [&source_a, &source_b].iter().any(|source| {
                checked_local_file(Path::new(&source.path), "pdf").is_ok()
                    && same_file::is_same_file(&destination, &source.path).unwrap_or(false)
            })
        {
            return Err("不能覆盖原始图纸。".into());
        }
        let project = Project {
            format: FORMAT.into(),
            version: VERSION,
            source_a,
            source_b,
            options,
            review,
            selected_region,
        };
        let data = serde_json::to_vec(&project).map_err(|_| "无法编码复核项目。")?;
        if data.len() as u64 > MAX_PROJECT_BYTES {
            return Err("复核项目超过 4 MiB 上限。".into());
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法创建项目临时文件。")?;
        temporary
            .write_all(&data)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "无法写入复核项目。")?;
        if old_file && overwrite {
            temporary
                .persist(&destination)
                .map_err(|_| "无法更新复核项目。")?;
        } else {
            temporary.persist_noclobber(&destination).map_err(|error| {
                if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                    "PROJECT_EXISTS: 已存在同名复核项目。"
                } else {
                    "无法保存复核项目。"
                }
            })?;
        }
        Ok(SavedProject {
            file_name: project_file_name(&destination),
            bytes: data.len(),
        })
    }

    pub(in crate::compare) fn open_project(
        &mut self,
        request: OpenRequest,
    ) -> Result<OpenedProject, String> {
        let project = read_project(Path::new(&request.path))?;
        let (source_a, a) = self.restore_source(
            "A",
            &project.source_a,
            request.source_a_path.as_deref(),
            request.password_a.as_deref(),
        )?;
        let (source_b, b) = self.restore_source(
            "B",
            &project.source_b,
            request.source_b_path.as_deref(),
            request.password_b.as_deref(),
        )?;
        if project.options.page_a as usize >= a.pages.len()
            || project.options.page_b as usize >= b.pages.len()
        {
            return Err("复核项目中的页码超出范围。".into());
        }
        self.a = Some(source_a);
        self.b = Some(source_b);
        self.last = None;
        self.batch = None;
        Ok(OpenedProject {
            file_name: project_file_name(Path::new(&request.path)),
            a,
            b,
            options: project.options,
            review: project.review,
            selected_region: project.selected_region,
        })
    }

    fn restore_source(
        &self,
        side: &str,
        source: &SourceReference,
        chosen: Option<&str>,
        password: Option<&str>,
    ) -> Result<(Source<'a>, SourceInfo), String> {
        let path = chosen.unwrap_or(&source.path);
        checked_local_file(Path::new(path), "pdf").map_err(|_| {
            format!(
                "PROJECT_SOURCE_{side}_MISSING: 无法访问来源 {side}，请重新选择同一份本地图纸。"
            )
        })?;
        self.stage_source(path, password, Some(source)).map_err(|error| {
            if error == "PROJECT_SOURCE_CHANGED" {
                format!("PROJECT_SOURCE_{side}_CHANGED: 来源 {side} 与保存时的内容不同，请选择原图纸。")
            } else if error.starts_with("PASSWORD_REQUIRED:") {
                format!("PROJECT_SOURCE_{side}_PASSWORD_REQUIRED: 来源 {side} 需要正确密码。")
            } else {
                error
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compare::{
        tests::pdf,
        types::{Rect, ScaleMode},
    };
    use std::sync::atomic::AtomicBool;

    fn path_text(path: &Path) -> String {
        path.to_str().unwrap().to_owned()
    }

    fn open(path: &Path) -> OpenRequest {
        OpenRequest {
            path: path_text(path),
            source_a_path: None,
            source_b_path: None,
            password_a: None,
            password_b: None,
        }
    }

    #[test]
    fn project_round_trip_changed_source_and_moved_exact_copy() {
        let _guard = crate::engine::tests::NATIVE_TEST_LOCK.lock().unwrap();
        let pdfium = crate::engine::tests::native_pdfium();
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("旧图.pdf");
        let b = dir.path().join("新图.pdf");
        let moved = dir.path().join("移动后的图.pdf");
        let project = dir.path().join("复核清单.jvcmp");
        let old = pdf("", 120, 160, 0);
        let new = pdf("0 g 30 30 12 9 re f", 120, 160, 0);
        let replacement = pdf("0 g 31 30 12 9 re f", 120, 160, 0);
        assert_eq!(new.len(), replacement.len());
        fs::write(&a, old).unwrap();
        fs::write(&b, &new).unwrap();
        let mut engine = Engine::new(pdfium);
        engine.open("a", &path_text(&a), None).unwrap();
        engine.open("b", &path_text(&b), None).unwrap();
        let options = Options {
            scale_mode: ScaleMode::Normalized,
            page_a: 0,
            page_b: 0,
            dpi: 150,
            threshold: 12,
            offset_x_mm: 0.0,
            offset_y_mm: 0.0,
            ignored: vec![Rect {
                x: 0.01,
                y: 0.01,
                width: 0.1,
                height: 0.1,
            }],
        };
        let token = AtomicBool::new(false);
        let report = engine
            .compare("checked".into(), options.clone(), &token, |_, _| {})
            .unwrap();
        let region = report.regions.first().unwrap().clone();
        let request = |overwrite| SaveRequest {
            path: path_text(&project),
            options: options.clone(),
            job_id: Some("checked".into()),
            review: vec![ReviewInput {
                region_id: region.id,
                reviewed: true,
                note: "连接孔已经复核".into(),
            }],
            selected_region_id: Some(region.id),
            overwrite,
        };
        let saved = engine.save_project(request(false)).unwrap();
        assert_eq!(saved.file_name, "复核清单.jvcmp");
        assert!(engine
            .save_project(request(false))
            .err()
            .unwrap()
            .starts_with("PROJECT_EXISTS:"));
        engine.save_project(request(true)).unwrap();
        let mut stale = request(true);
        stale.options.threshold += 1;
        assert!(engine.save_project(stale).is_err());
        let disk = read_project(&project).unwrap();
        assert_eq!(disk.source_b.sha256, super::super::source_sha256(&new));
        assert!(!fs::read_to_string(&project).unwrap().contains("password"));
        fs::write(&b, &replacement).unwrap();
        assert!(engine
            .open_project(open(&project))
            .err()
            .unwrap()
            .starts_with("PROJECT_SOURCE_B_CHANGED:"));
        assert_eq!(engine.last.as_ref().unwrap().0.job_id, "checked");
        assert_eq!(engine.b.as_ref().unwrap().sha256, disk.source_b.sha256);
        fs::write(&moved, &new).unwrap();
        let opened = engine
            .open_project(OpenRequest {
                source_b_path: Some(path_text(&moved)),
                ..open(&project)
            })
            .unwrap();
        assert!(engine.last.is_none());
        assert_eq!(opened.b.file_name, "移动后的图.pdf");
        assert_eq!(opened.options, options);
        assert_eq!(opened.selected_region.unwrap().id, region.id);
        assert_eq!(opened.review.len(), 1);
        assert!(opened.review[0].reviewed);
        assert_eq!(opened.review[0].note, "连接孔已经复核");
        let restored = engine
            .compare("restored".into(), options, &token, |_, _| {})
            .unwrap();
        assert_eq!(restored.changed_pixels, report.changed_pixels);
    }

    #[test]
    fn rejects_unsafe_path_components_and_review_coordinates() {
        assert_eq!(
            super::super::source_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        #[cfg(windows)]
        for path in [
            r"\\example.invalid\share\file.pdf",
            r"C:relative.pdf",
            r"C:\local\NUL.pdf",
            r"C:\local\doc.pdf:alt.pdf",
            r"C:\local\..\doc.pdf",
        ] {
            assert!(check_path(Path::new(path), "pdf").is_err(), "{path}");
        }
        let mut region = Region {
            id: 1,
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 0.1,
                height: 0.1,
            },
            pixels: 2,
            added: 2,
            removed: 0,
            changed: 0,
            point: [0.0, 0.0],
        };
        assert!(valid_region(&region));
        region.removed = u64::MAX;
        assert!(!valid_region(&region));
    }
}
