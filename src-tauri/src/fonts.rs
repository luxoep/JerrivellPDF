// SPDX-License-Identifier: MIT OR Apache-2.0
//! Enumerate installed Windows font family names without reading font files.
//!
//! Windows includes fonts available to this user in the screen DC enumeration.
//! A family can have a localized name; we return the name reported by the OS,
//! not a guessed English alias. Coverage of individual Unicode glyphs remains
//! the font's responsibility. Legacy bitmap/device fonts are omitted because
//! the editor uses WebView's outline-font text rendering.
//!
//! https://learn.microsoft.com/windows/win32/api/wingdi/nf-wingdi-enumfontfamiliesexw

use std::collections::BTreeMap;
use std::ffi::c_void;
use std::time::{Duration, Instant};

const LF_FACESIZE: usize = 32;
const DEFAULT_CHARSET: u8 = 1;
const RASTER_FONTTYPE: u32 = 1;
const MAX_FAMILIES: usize = 4096;
const MAX_CALLBACKS: usize = 100_000;
const ENUMERATION_BUDGET: Duration = Duration::from_secs(2);

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFonts {
    pub families: Vec<String>,
    pub source: &'static str,
    pub truncated: bool,
}

/// LOGFONTW has five LONGs, eight BYTEs and a 32-WCHAR family name.
#[repr(C)]
struct LogFontW {
    height: i32,
    width: i32,
    escapement: i32,
    orientation: i32,
    weight: i32,
    italic: u8,
    underline: u8,
    strike_out: u8,
    char_set: u8,
    out_precision: u8,
    clip_precision: u8,
    quality: u8,
    pitch_and_family: u8,
    face_name: [u16; LF_FACESIZE],
}

type FontEnumProc = unsafe extern "system" fn(*const LogFontW, *const c_void, u32, isize) -> i32;

#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateCompatibleDC(device: *mut c_void) -> *mut c_void;
    fn DeleteDC(device: *mut c_void) -> i32;
    fn EnumFontFamiliesExW(
        device: *mut c_void,
        description: *mut LogFontW,
        callback: Option<FontEnumProc>,
        parameter: isize,
        flags: u32,
    ) -> i32;
}

struct ScreenCompatibleDc(*mut c_void);

impl ScreenCompatibleDc {
    fn create() -> Result<Self, String> {
        // SAFETY: null requests a memory DC compatible with the current screen.
        let device = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
        if device.is_null() {
            Err("无法读取本机字体，请稍后重试。 / Could not enumerate system fonts.".into())
        } else {
            Ok(Self(device))
        }
    }
}

impl Drop for ScreenCompatibleDc {
    fn drop(&mut self) {
        // SAFETY: this owns the DC returned by CreateCompatibleDC, on the same
        // thread. The synchronous enumeration has completed before drop.
        unsafe { DeleteDC(self.0) };
    }
}

struct FontCollector {
    families: BTreeMap<String, String>,
    callbacks: usize,
    started: Instant,
    truncated: bool,
}

impl FontCollector {
    fn new() -> Self {
        Self {
            families: BTreeMap::new(),
            callbacks: 0,
            started: Instant::now(),
            truncated: false,
        }
    }

    /// Return false to ask GDI to stop. The time budget is deliberately soft:
    /// the OS call itself cannot safely be force-terminated between callbacks.
    fn receive(&mut self, raw_name: &[u16], font_type: u32) -> bool {
        self.callbacks += 1;
        if self.callbacks > MAX_CALLBACKS || self.started.elapsed() > ENUMERATION_BUDGET {
            self.truncated = true;
            return false;
        }
        if font_type & RASTER_FONTTYPE != 0 {
            return true;
        }
        let Some(name) = normalize_family(raw_name) else {
            return true;
        };
        let key = name.to_lowercase();
        if self.families.contains_key(&key) {
            return true;
        }
        if self.families.len() >= MAX_FAMILIES {
            self.truncated = true;
            return false;
        }
        self.families.insert(key, name);
        true
    }

    fn finish(self) -> SystemFonts {
        SystemFonts {
            families: self.families.into_values().collect(),
            source: "windows",
            truncated: self.truncated,
        }
    }
}

fn normalize_family(raw_name: &[u16]) -> Option<String> {
    let end = raw_name.iter().position(|character| *character == 0)?;
    if end == 0 || end >= LF_FACESIZE {
        return None;
    }
    let value = String::from_utf16(&raw_name[..end]).ok()?;
    if value.chars().any(char::is_control) {
        return None;
    }
    let name = value.trim();
    // @ names are vertical-writing aliases, not additional horizontal families.
    if name.is_empty() || name.starts_with('@') {
        return None;
    }
    Some(name.to_owned())
}

unsafe extern "system" fn collect_font(
    description: *const LogFontW,
    _metrics: *const c_void,
    font_type: u32,
    parameter: isize,
) -> i32 {
    if description.is_null() || parameter == 0 {
        return 0;
    }
    // SAFETY: EnumFontFamiliesExW calls synchronously with a valid LOGFONTW
    // prefix. parameter points to our live, uniquely borrowed collector; GDI
    // retains neither pointer after the callback returns.
    let collector = unsafe { &mut *(parameter as *mut FontCollector) };
    let name = unsafe { &(*description).face_name };
    i32::from(collector.receive(name, font_type))
}

/// Called on a blocking task; independent of the PDF worker and font files.
pub fn list_system_fonts() -> Result<SystemFonts, String> {
    let device = ScreenCompatibleDc::create()?;
    let mut collector = FontCollector::new();
    // SAFETY: all-zero bytes are valid for every LOGFONTW scalar/array field.
    let mut description: LogFontW = unsafe { std::mem::zeroed() };
    description.char_set = DEFAULT_CHARSET;
    // SAFETY: device is live, description follows the documented empty-family /
    // DEFAULT_CHARSET query, callback and collector remain live for this call.
    // dwFlags and lfPitchAndFamily are zero as required by Windows.
    unsafe {
        EnumFontFamiliesExW(
            device.0,
            &mut description,
            Some(collect_font),
            (&mut collector as *mut FontCollector) as isize,
            0,
        )
    };
    let result = collector.finish();
    // EnumFontFamiliesExW's integer return is the final callback value, not a
    // conventional success/error code. Check the actual collected result.
    if result.families.is_empty() {
        Err("没有找到可用的本机字体，请刷新后重试。 / No usable system fonts were found.".into())
    } else {
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    #[test]
    fn family_names_preserve_unicode_and_reject_invalid_or_vertical_names() {
        assert_eq!(
            normalize_family(&utf16("微软雅黑")),
            Some("微软雅黑".into())
        );
        assert_eq!(
            normalize_family(&utf16("A Family, 'Quoted'")),
            Some("A Family, 'Quoted'".into())
        );
        assert!(normalize_family(&utf16("@微软雅黑")).is_none());
        assert!(normalize_family(&utf16("\nBad family")).is_none());
        assert!(normalize_family(&utf16("   ")).is_none());
        assert!(normalize_family(&[0xd800, 0]).is_none());
        assert!(normalize_family(&[65; LF_FACESIZE]).is_none());
    }

    #[test]
    fn collector_deduplicates_styles_filters_bitmap_fonts_and_sorts_stably() {
        let mut collector = FontCollector::new();
        for name in ["Zeta", "微软雅黑", "arial", "Arial", "@微软雅黑", "Arial"] {
            assert!(collector.receive(&utf16(name), 4));
        }
        assert!(collector.receive(&utf16("Terminal"), RASTER_FONTTYPE));
        let result = collector.finish();
        assert_eq!(result.families, vec!["arial", "Zeta", "微软雅黑"]);
        assert_eq!(result.source, "windows");
        assert!(!result.truncated);
    }

    #[test]
    fn collector_reports_count_and_time_truncation_without_growing_past_limits() {
        let mut collector = FontCollector::new();
        for index in 0..MAX_FAMILIES {
            assert!(collector.receive(&utf16(&format!("Family {index}")), 4));
        }
        assert!(collector.receive(&utf16("Family 0"), 4));
        assert!(!collector.receive(&utf16("Overflow family"), 4));
        assert_eq!(collector.families.len(), MAX_FAMILIES);
        assert!(collector.truncated);
        let mut collector = FontCollector::new();
        collector.callbacks = MAX_CALLBACKS;
        assert!(!collector.receive(&utf16("Arial"), 4));
        assert!(collector.truncated);
        let mut collector = FontCollector::new();
        collector.started = Instant::now() - Duration::from_secs(3);
        assert!(!collector.receive(&utf16("Arial"), 4));
        assert!(collector.truncated);
    }

    #[test]
    fn windows_enumeration_produces_bounded_usable_family_names() {
        assert_eq!(std::mem::size_of::<LogFontW>(), 92);
        let result = list_system_fonts().expect("screen font enumeration should succeed");
        assert!(!result.families.is_empty());
        assert!(result.families.len() <= MAX_FAMILIES);
        assert!(result
            .families
            .iter()
            .all(|name| !name.starts_with('@') && !name.chars().any(char::is_control)));
        let keys: Vec<_> = result
            .families
            .iter()
            .map(|name| name.to_lowercase())
            .collect();
        assert!(keys.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
