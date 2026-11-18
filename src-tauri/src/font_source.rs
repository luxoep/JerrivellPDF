// SPDX-License-Identifier: MIT OR Apache-2.0
//! Runtime access to an installed TrueType face, for editable PDF text only.
//!
//! No font program is copied into the project, installer or persistent font cache.
//! The OS/2 flags are a machine-readable embedding check, not a replacement for
//! the font's applicable license. Restricted, preview-only, bitmap-only and
//! no-subsetting faces are refused by this first implementation.
//!
//! References:
//! https://learn.microsoft.com/windows/win32/api/wingdi/nf-wingdi-getfontdata
//! https://learn.microsoft.com/windows/win32/api/wingdi/nf-wingdi-gettextfacew
//! https://learn.microsoft.com/typography/opentype/spec/os2
//! https://learn.microsoft.com/typography/opentype/spec/cmap

use std::collections::{BTreeMap, BTreeSet};

pub const MAX_FONT_BYTES: usize = 32 * 1024 * 1024;
const MAX_TABLES: usize = 256;
const MAX_TEXT_SCALARS: usize = 10_000;

#[derive(Debug)]
pub struct EditableFont {
    pub family: String,
    pub bytes: Vec<u8>,
    pub fs_type: u16,
}

fn invalid(message: &str) -> String {
    format!("FONT_SOURCE_INVALID: {message}")
}

fn be16(data: &[u8], offset: usize) -> Result<u16, String> {
    let raw = data
        .get(offset..offset.saturating_add(2))
        .ok_or_else(|| invalid("字体表数据不完整。"))?;
    Ok(u16::from_be_bytes([raw[0], raw[1]]))
}

fn be32(data: &[u8], offset: usize) -> Result<u32, String> {
    let raw = data
        .get(offset..offset.saturating_add(4))
        .ok_or_else(|| invalid("字体表数据不完整。"))?;
    Ok(u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]))
}

fn table_directory(data: &[u8]) -> Result<BTreeMap<[u8; 4], &[u8]>, String> {
    if data.len() > MAX_FONT_BYTES || data.len() < 12 {
        return Err(invalid("字体为空、过大或不是受支持的 TrueType 字体。"));
    }
    if data.get(..4) != Some(&[0, 1, 0, 0]) {
        return Err(invalid(
            "首版仅支持独立 TrueType 轮廓字体；集合、CFF 和其他格式请更换字体。",
        ));
    }
    let count = be16(data, 4)? as usize;
    if count == 0 || count > MAX_TABLES || 12 + count * 16 > data.len() {
        return Err(invalid("TrueType 字体表目录无效。"));
    }
    let mut tables = BTreeMap::new();
    for index in 0..count {
        let record = 12 + index * 16;
        let tag: [u8; 4] = data[record..record + 4].try_into().unwrap();
        let offset = be32(data, record + 8)? as usize;
        let length = be32(data, record + 12)? as usize;
        let end = offset
            .checked_add(length)
            .ok_or_else(|| invalid("字体表长度溢出。"))?;
        if offset < 12 + count * 16
            || end > data.len()
            || tables.insert(tag, &data[offset..end]).is_some()
        {
            return Err(invalid("字体表越界或包含重复标签。"));
        }
    }
    Ok(tables)
}

fn required<'a>(tables: &'a BTreeMap<[u8; 4], &'a [u8]>, tag: [u8; 4]) -> Result<&'a [u8], String> {
    tables
        .get(&tag)
        .copied()
        .ok_or_else(|| invalid("字体缺少必要的 TrueType 表。"))
}

fn embedding_permissions(os2: &[u8]) -> Result<u16, String> {
    if os2.len() < 10 {
        return Err(invalid("无法确认字体的可编辑嵌入权限。"));
    }
    let version = be16(os2, 0)?;
    if version > 5 {
        return Err(invalid("字体使用尚未支持的 OS/2 表版本。"));
    }
    let flags = be16(os2, 8)?;
    if flags & 0x000f != 0 && flags & 0x000f != 8 {
        return Err(
            "FONT_EMBEDDING_DENIED: 该字体未声明允许可编辑嵌入，请选择其他本机字体。".into(),
        );
    }
    // Refuse no-subsetting even though we retrieve a full face: do not assume
    // every subsequent PDF optimization/export path preserves the full program.
    if flags & 0x0100 != 0 {
        return Err("FONT_EMBEDDING_DENIED: 该字体禁止子集化，当前导出流程尚未对这一限制完成验证，请换字体。".into());
    }
    if flags & 0x0200 != 0 {
        return Err("FONT_EMBEDDING_DENIED: 该字体只允许位图嵌入，不能用于可编辑原文。".into());
    }
    if flags & !0x030f != 0 {
        return Err(invalid("字体包含未知的嵌入权限位，请换字体。"));
    }
    Ok(flags)
}

fn unicode_cmap(cmap: &[u8]) -> Result<&[u8], String> {
    if be16(cmap, 0)? != 0 {
        return Err(invalid("字体 Unicode cmap 版本无效。"));
    }
    let count = be16(cmap, 2)? as usize;
    if count == 0 || count > 256 || 4 + count * 8 > cmap.len() {
        return Err(invalid("字体 cmap 目录无效。"));
    }
    let mut best: Option<(u8, &[u8])> = None;
    for index in 0..count {
        let record = 4 + index * 8;
        let platform = be16(cmap, record)?;
        let encoding = be16(cmap, record + 2)?;
        if platform != 0 && !(platform == 3 && matches!(encoding, 1 | 10)) {
            continue;
        }
        let offset = be32(cmap, record + 4)? as usize;
        if offset < 4 + count * 8 {
            return Err(invalid("字体 cmap 子表偏移无效。"));
        }
        let tail = cmap
            .get(offset..)
            .ok_or_else(|| invalid("字体 cmap 子表越界。"))?;
        let format = be16(tail, 0)?;
        let (rank, length) = match format {
            12 if platform == 0 || encoding == 10 => (2, be32(tail, 4)? as usize),
            4 if platform == 0 || encoding == 1 => (1, be16(tail, 2)? as usize),
            _ => continue,
        };
        let subtable = tail
            .get(..length)
            .ok_or_else(|| invalid("字体 cmap 子表长度越界。"))?;
        if best.as_ref().is_none_or(|previous| rank > previous.0) {
            best = Some((rank, subtable));
        }
    }
    best.map(|(_, table)| table)
        .ok_or_else(|| invalid("该字体没有受支持的 Unicode cmap（格式 4/12），请换字体。"))
}

fn glyph_index(cmap: &[u8], code: u32) -> Result<u32, String> {
    match be16(cmap, 0)? {
        12 => {
            if cmap.len() < 16 {
                return Err(invalid("格式 12 cmap 不完整。"));
            }
            let groups = be32(cmap, 12)? as usize;
            if groups > 1_000_000 || 16 + groups * 12 > cmap.len() {
                return Err(invalid("格式 12 cmap 分组越界。"));
            }
            let mut low = 0;
            let mut high = groups;
            while low < high {
                let middle = low + (high - low) / 2;
                let offset = 16 + middle * 12;
                let start = be32(cmap, offset)?;
                let end = be32(cmap, offset + 4)?;
                if start > end || end > 0x10ffff {
                    return Err(invalid("格式 12 cmap 区间无效。"));
                }
                if code < start {
                    high = middle;
                } else if code > end {
                    low = middle + 1;
                } else {
                    return be32(cmap, offset + 8)?
                        .checked_add(code - start)
                        .ok_or_else(|| invalid("字体 glyph 索引溢出。"));
                }
            }
            Ok(0)
        }
        4 => {
            if code > 0xffff {
                return Ok(0);
            }
            let twice = be16(cmap, 6)? as usize;
            if twice == 0 || twice % 2 != 0 {
                return Err(invalid("格式 4 cmap 区间数量无效。"));
            }
            let count = twice / 2;
            if 16 + count * 8 > cmap.len() {
                return Err(invalid("格式 4 cmap 数组越界。"));
            }
            let end_base = 14;
            let start_base = 16 + count * 2;
            let delta_base = 16 + count * 4;
            let range_base = 16 + count * 6;
            let code = code as u16;
            let mut low = 0;
            let mut high = count;
            while low < high {
                let middle = low + (high - low) / 2;
                if code > be16(cmap, end_base + middle * 2)? {
                    low = middle + 1;
                } else {
                    high = middle;
                }
            }
            if low == count {
                return Ok(0);
            }
            let start = be16(cmap, start_base + low * 2)?;
            let end = be16(cmap, end_base + low * 2)?;
            if start > end {
                return Err(invalid("格式 4 cmap 区间顺序无效。"));
            }
            if code < start {
                return Ok(0);
            }
            let delta = be16(cmap, delta_base + low * 2)?;
            let relative = be16(cmap, range_base + low * 2)? as usize;
            if relative == 0 {
                return Ok(code.wrapping_add(delta) as u32);
            }
            if relative % 2 != 0 {
                return Err(invalid("格式 4 cmap 字形偏移无效。"));
            }
            let position = range_base + low * 2 + relative + (code - start) as usize * 2;
            if position < range_base + count * 2 {
                return Err(invalid("格式 4 cmap 字形偏移指向目录。"));
            }
            let glyph = be16(cmap, position)?;
            Ok(if glyph == 0 {
                0
            } else {
                glyph.wrapping_add(delta) as u32
            })
        }
        _ => Err(invalid("不支持的字体 cmap 格式。")),
    }
}

/// Validate exact Unicode coverage; glyph zero is not silently accepted.
/// The font bytes remain private to the native worker and never cross IPC.
pub fn validate_text_coverage(bytes: &[u8], text: &str) -> Result<(), String> {
    if text.chars().count() > MAX_TEXT_SCALARS {
        return Err(invalid("待编辑文字过长。"));
    }
    let tables = table_directory(bytes)?;
    let maxp = required(&tables, *b"maxp")?;
    let glyph_count = be16(maxp, 4)? as u32;
    if glyph_count == 0 {
        return Err(invalid("字体不包含字形。"));
    }
    let cmap = unicode_cmap(required(&tables, *b"cmap")?)?;
    let characters: BTreeSet<char> = text.chars().collect();
    for ch in characters {
        if ch.is_control() {
            return Err(invalid("原文对象暂不支持换行、制表符或控制字符。"));
        }
        let glyph = glyph_index(cmap, ch as u32)?;
        if glyph == 0 || glyph >= glyph_count {
            return Err(format!(
                "FONT_GLYPH_MISSING: 所选字体不含字符 U+{:04X}（{}），请更换字体。",
                ch as u32, ch
            ));
        }
    }
    Ok(())
}

pub fn validate_font_text(font: &EditableFont, text: &str) -> Result<(), String> {
    if !matches!(font.fs_type, 0 | 8) {
        return Err("FONT_EMBEDDING_DENIED: 字体快照未声明允许可编辑嵌入。".into());
    }
    validate_text_coverage(&font.bytes, text)
}

fn verified_tables(bytes: &[u8]) -> Result<BTreeMap<[u8; 4], &[u8]>, String> {
    let tables = table_directory(bytes)?;
    let head = required(&tables, *b"head")?;
    if head.len() < 54 || be32(head, 12)? != 0x5f0f3cf5 {
        return Err(invalid("字体 head 表无效。"));
    }
    let maxp = required(&tables, *b"maxp")?;
    let glyph_count = be16(maxp, 4)? as usize;
    if glyph_count == 0 {
        return Err(invalid("字体不包含字形。"));
    }
    let glyf = required(&tables, *b"glyf")?;
    let loca = required(&tables, *b"loca")?;
    let width = match be16(head, 50)? {
        0 => 2,
        1 => 4,
        _ => return Err(invalid("字体 loca 格式无效。")),
    };
    if loca.len() < (glyph_count + 1) * width {
        return Err(invalid("字体 loca 表不完整。"));
    }
    let mut previous = 0;
    for i in 0..=glyph_count {
        let current = if width == 2 {
            be16(loca, i * width)? as usize * 2
        } else {
            be32(loca, i * width)? as usize
        };
        if current < previous || current > glyf.len() {
            return Err(invalid("字体字形轮廓偏移无效。"));
        }
        previous = current;
    }
    let hhea = required(&tables, *b"hhea")?;
    let hmetrics = be16(hhea, 34)? as usize;
    let hmtx = required(&tables, *b"hmtx")?;
    if hmetrics == 0
        || hmetrics > glyph_count
        || hmtx.len() < hmetrics * 4 + (glyph_count - hmetrics) * 2
    {
        return Err(invalid("字体水平度量表无效。"));
    }
    Ok(tables)
}

fn verify_font(bytes: &[u8]) -> Result<u16, String> {
    let tables = verified_tables(bytes)?;
    let os2 = required(&tables, *b"OS/2")?;
    let minimum = match be16(os2, 0)? {
        0 => 78,
        1 => 86,
        2..=4 => 96,
        5 => 100,
        _ => return Err(invalid("字体 OS/2 表版本尚未支持。")),
    };
    if os2.len() < minimum {
        return Err(invalid("字体 OS/2 表不完整，无法确认嵌入属性。"));
    }
    embedding_permissions(os2)
}

fn checksum(bytes: &[u8]) -> u32 {
    bytes.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

/// Relocate all tables of one complete selected face from a TTC into an sfnt.
/// No glyphs are subsetted. DSIG is omitted because its old container signature
/// does not apply after table-offset relocation. No other collection face is read.
fn rebuild_sfnt(mut tables: BTreeMap<[u8; 4], Vec<u8>>) -> Result<Vec<u8>, String> {
    tables.remove(b"DSIG");
    let count = tables.len();
    if count == 0 || count > MAX_TABLES {
        return Err(invalid("系统字体表数量无效。"));
    }
    let head = tables
        .get_mut(b"head")
        .ok_or_else(|| invalid("系统字体缺少 head 表。"))?;
    if head.len() < 54 {
        return Err(invalid("系统字体 head 表不完整。"));
    }
    head[8..12].fill(0);
    let selector = usize::BITS - 1 - count.leading_zeros();
    let search_range = (1usize << selector) * 16;
    let mut output = vec![0u8; 12 + count * 16];
    output[..4].copy_from_slice(&[0, 1, 0, 0]);
    output[4..6].copy_from_slice(&(count as u16).to_be_bytes());
    output[6..8].copy_from_slice(&(search_range as u16).to_be_bytes());
    output[8..10].copy_from_slice(&(selector as u16).to_be_bytes());
    output[10..12].copy_from_slice(&((count * 16 - search_range) as u16).to_be_bytes());
    let mut head_offset = 0;
    for (index, (tag, data)) in tables.into_iter().enumerate() {
        let offset = output.len();
        let padded = data
            .len()
            .checked_add(3)
            .map(|value| value & !3)
            .ok_or_else(|| invalid("字体表长度溢出。"))?;
        let end = offset
            .checked_add(padded)
            .ok_or_else(|| invalid("字体大小溢出。"))?;
        if end > MAX_FONT_BYTES {
            return Err(invalid("所选字体超过 32 MiB 限制。"));
        }
        let record = 12 + index * 16;
        output[record..record + 4].copy_from_slice(&tag);
        output[record + 4..record + 8].copy_from_slice(&checksum(&data).to_be_bytes());
        output[record + 8..record + 12].copy_from_slice(&(offset as u32).to_be_bytes());
        output[record + 12..record + 16].copy_from_slice(&(data.len() as u32).to_be_bytes());
        if tag == *b"head" {
            head_offset = offset;
        }
        output.extend_from_slice(&data);
        output.resize(end, 0);
    }
    let adjustment = 0xb1b0afbau32.wrapping_sub(checksum(&output));
    output[head_offset + 8..head_offset + 12].copy_from_slice(&adjustment.to_be_bytes());
    Ok(output)
}

fn valid_family(family: &str) -> Result<&str, String> {
    let family = family.trim();
    if family.is_empty()
        || family.encode_utf16().count() > 31
        || family.starts_with('@')
        || family
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | ':'))
    {
        return Err(invalid("请选择一个有效的本机横排字体名称。"));
    }
    Ok(family)
}

fn family_aliases(bytes: &[u8]) -> Result<BTreeSet<String>, String> {
    let tables = table_directory(bytes)?;
    let data = required(&tables, *b"name")?;
    let count = be16(data, 2)? as usize;
    let string_base = be16(data, 4)? as usize;
    if count > 4096 || 6 + count * 12 > data.len() || string_base < 6 + count * 12 {
        return Err(invalid("字体名称表无效。"));
    }
    let mut result = BTreeSet::new();
    for index in 0..count {
        let record = 6 + index * 12;
        let platform = be16(data, record)?;
        let encoding = be16(data, record + 2)?;
        let name_id = be16(data, record + 6)?;
        if !(platform == 0 || platform == 3 && matches!(encoding, 0 | 1 | 10))
            || !matches!(name_id, 1 | 4 | 6 | 16 | 21)
        {
            continue;
        }
        let length = be16(data, record + 8)? as usize;
        let offset = string_base + be16(data, record + 10)? as usize;
        let raw = data
            .get(offset..offset.saturating_add(length))
            .ok_or_else(|| invalid("字体名称字符串越界。"))?;
        if length % 2 != 0 || length > 1024 {
            return Err(invalid("字体名称编码无效。"));
        }
        let words: Vec<_> = raw
            .chunks_exact(2)
            .map(|word| u16::from_be_bytes([word[0], word[1]]))
            .collect();
        if let Ok(name) = String::from_utf16(&words) {
            if !name.chars().any(char::is_control) {
                result.insert(name.trim().to_lowercase());
            }
        }
    }
    Ok(result)
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::ffi::c_void;
    use std::ptr::null_mut;

    type Handle = *mut c_void;
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
        face_name: [u16; 32],
    }
    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn CreateCompatibleDC(device: Handle) -> Handle;
        fn DeleteDC(device: Handle) -> i32;
        fn CreateFontIndirectW(description: *const LogFontW) -> Handle;
        fn DeleteObject(object: Handle) -> i32;
        fn SelectObject(device: Handle, object: Handle) -> Handle;
        fn GetTextFaceW(device: Handle, count: i32, name: *mut u16) -> i32;
        fn GetFontData(
            device: Handle,
            table: u32,
            offset: u32,
            buffer: *mut c_void,
            length: u32,
        ) -> u32;
    }

    struct SelectedFont {
        device: Handle,
        font: Handle,
        previous: Handle,
    }
    impl Drop for SelectedFont {
        fn drop(&mut self) {
            // SAFETY: all handles belong to this value and stay on one thread;
            // a GDI font must be deselected before DeleteObject.
            unsafe {
                if !self.previous.is_null() {
                    SelectObject(self.device, self.previous);
                }
                if !self.font.is_null() {
                    DeleteObject(self.font);
                }
                if !self.device.is_null() {
                    DeleteDC(self.device);
                }
            }
        }
    }

    fn get_table(device: Handle, table: u32) -> Result<Vec<u8>, String> {
        // SAFETY: the font remains selected in a live thread-local DC. The size
        // query bounds allocation and the output buffer stays live through GDI.
        let length = unsafe { GetFontData(device, table, 0, null_mut(), 0) };
        if length == u32::MAX || length == 0 || length as usize > MAX_FONT_BYTES {
            return Err(invalid(
                "该字体无法读取为受限大小的 TrueType 字体，请换字体。",
            ));
        }
        let mut data = vec![0u8; length as usize];
        let copied = unsafe { GetFontData(device, table, 0, data.as_mut_ptr().cast(), length) };
        if copied != length {
            return Err(invalid("系统字体读取不完整，请重新选择字体。"));
        }
        Ok(data)
    }

    fn selected_face_program(device: Handle) -> Result<Vec<u8>, String> {
        // Preserve an independent font byte for byte. A collection-face view
        // often instead retains absolute offsets into the entire TTC container.
        if let Ok(bytes) = get_table(device, 0) {
            if verified_tables(&bytes).is_ok() && family_aliases(&bytes).is_ok() {
                return Ok(bytes);
            }
        }
        let mut header = [0u8; 12];
        let copied = unsafe {
            GetFontData(
                device,
                0,
                0,
                header.as_mut_ptr().cast(),
                header.len() as u32,
            )
        };
        if copied != header.len() as u32 || header[..4] != [0, 1, 0, 0] {
            return Err(invalid("所选字体不是受支持的 TrueType 轮廓字体。"));
        }
        let count = u16::from_be_bytes([header[4], header[5]]) as usize;
        if count == 0 || count > MAX_TABLES {
            return Err(invalid("系统字体表目录无效。"));
        }
        let mut directory = vec![0u8; count * 16];
        let copied = unsafe {
            GetFontData(
                device,
                0,
                12,
                directory.as_mut_ptr().cast(),
                directory.len() as u32,
            )
        };
        if copied != directory.len() as u32 {
            return Err(invalid("系统字体表目录读取不完整。"));
        }
        let mut tables = BTreeMap::new();
        let mut total = 12 + count * 16;
        for record in directory.chunks_exact(16) {
            let tag: [u8; 4] = record[..4].try_into().unwrap();
            if tag == *b"DSIG" {
                continue;
            }
            // Win32 dwTable uses the four tag bytes in little-endian order.
            let data = get_table(device, u32::from_le_bytes(tag))?;
            total += (data.len() + 3) & !3;
            if total > MAX_FONT_BYTES || tables.insert(tag, data).is_some() {
                return Err(invalid("字体表重复或总大小超过 32 MiB。"));
            }
        }
        rebuild_sfnt(tables)
    }

    pub fn load(family: &str, bold: bool, italic: bool) -> Result<(String, Vec<u8>), String> {
        // SAFETY: all-zero scalars/array form a valid initial LOGFONTW.
        let mut description: LogFontW = unsafe { std::mem::zeroed() };
        description.height = -16;
        description.weight = if bold { 700 } else { 400 };
        description.italic = u8::from(italic);
        description.char_set = 1; // DEFAULT_CHARSET
        description.out_precision = 7; // OUT_TT_ONLY_PRECIS
        for (slot, word) in description.face_name.iter_mut().zip(family.encode_utf16()) {
            *slot = word;
        }
        // SAFETY: null requests a screen-compatible memory DC; the description
        // is NUL-terminated and remains valid through CreateFontIndirectW.
        let device = unsafe { CreateCompatibleDC(null_mut()) };
        if device.is_null() {
            return Err(invalid("Windows 无法创建字体读取环境。"));
        }
        let mut selected = SelectedFont {
            device,
            font: null_mut(),
            previous: null_mut(),
        };
        selected.font = unsafe { CreateFontIndirectW(&description) };
        if selected.font.is_null() {
            return Err(invalid("Windows 无法打开所选字体。"));
        }
        let previous = unsafe { SelectObject(selected.device, selected.font) };
        if previous.is_null() || previous as isize == -1 {
            return Err(invalid("Windows 无法选择该字体。"));
        }
        selected.previous = previous;
        let mut name = [0u16; 128];
        let length = unsafe { GetTextFaceW(selected.device, name.len() as i32, name.as_mut_ptr()) };
        if length <= 0 {
            return Err(invalid("无法核对 Windows 实际使用的字体。"));
        }
        let end = name
            .iter()
            .position(|x| *x == 0)
            .ok_or_else(|| invalid("系统字体名称未正常结束。"))?;
        let actual =
            String::from_utf16(&name[..end]).map_err(|_| invalid("系统字体名称编码无效。"))?;
        let bytes = selected_face_program(selected.device)?;
        let aliases = family_aliases(&bytes)?;
        let requested = family.to_lowercase();
        if requested != actual.to_lowercase() && !aliases.contains(&requested) {
            return Err(
                "FONT_NOT_FOUND: Windows 未使用请求的字体，已拒绝静默替代；请刷新字体列表后重选。"
                    .into(),
            );
        }
        Ok((actual, bytes))
    }

    #[cfg(test)]
    #[test]
    fn windows_logfont_layout_matches_gdi() {
        assert_eq!(std::mem::size_of::<LogFontW>(), 92);
    }
}

/// Resolve one installed face and enforce editable embedding and exact glyphs.
pub fn load_editable_font(family: &str, text: &str) -> Result<EditableFont, String> {
    load_editable_font_style(family, text, false, false)
}

/// Require an actual matching installed face. GDI's synthetic bold/italic is
/// not part of GetFontData and must never be advertised as embedded styling.
pub fn load_editable_font_style(
    family: &str,
    text: &str,
    bold: bool,
    italic: bool,
) -> Result<EditableFont, String> {
    let family = valid_family(family)?;
    #[cfg(windows)]
    {
        let (actual, bytes) = native::load(family, bold, italic)?;
        let fs_type = verify_font(&bytes)?;
        validate_face_style(&bytes, bold, italic)?;
        validate_text_coverage(&bytes, text)?;
        Ok(EditableFont {
            family: actual,
            bytes,
            fs_type,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (family, text, bold, italic);
        Err(invalid("当前仅支持 Windows 本机字体读取。"))
    }
}

fn validate_face_style(bytes: &[u8], bold: bool, italic: bool) -> Result<(), String> {
    let tables = table_directory(bytes)?;
    let os2 = required(&tables, *b"OS/2")?;
    let selection = be16(os2, 62)?;
    let actual_bold = be16(os2, 4)? >= 600 || selection & 0x20 != 0;
    let actual_italic = selection & 1 != 0;
    if actual_bold != bold || actual_italic != italic {
        return Err(invalid(
            "该字体没有匹配的真实粗体/斜体字形，已拒绝合成样式；请更换字体或关闭相应样式。",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedding_bits_require_editable_or_installable_and_refuse_unverified_restrictions() {
        let mut os2 = [0u8; 10];
        os2[1] = 4;
        for allowed in [0u16, 8] {
            os2[8..10].copy_from_slice(&allowed.to_be_bytes());
            assert_eq!(embedding_permissions(&os2).unwrap(), allowed);
        }
        for denied in [1u16, 2, 4, 6, 10, 12, 0x100, 0x108, 0x200, 0x208, 0x400] {
            os2[8..10].copy_from_slice(&denied.to_be_bytes());
            assert!(embedding_permissions(&os2).is_err(), "{denied:#x}");
        }
        assert!(embedding_permissions(&[]).is_err());
    }

    #[test]
    fn family_input_cannot_be_a_path_vertical_alias_or_control_string() {
        for value in [
            "",
            "@Arial",
            "C:\\Windows\\arial.ttf",
            "../font",
            "Bad\0Font",
            "LongLongLongLongLongLongLongLongFont",
        ] {
            assert!(valid_family(value).is_err(), "{value:?}");
        }
        assert_eq!(valid_family(" 微软雅黑 ").unwrap(), "微软雅黑");
    }

    fn format4() -> Vec<u8> {
        let mut data = vec![0; 32];
        data[0..2].copy_from_slice(&4u16.to_be_bytes());
        data[2..4].copy_from_slice(&32u16.to_be_bytes());
        data[6..8].copy_from_slice(&4u16.to_be_bytes());
        data[14..16].copy_from_slice(&67u16.to_be_bytes());
        data[16..18].copy_from_slice(&0xffffu16.to_be_bytes());
        data[20..22].copy_from_slice(&65u16.to_be_bytes());
        data[22..24].copy_from_slice(&0xffffu16.to_be_bytes());
        data[24..26].copy_from_slice(&(-64i16).to_be_bytes());
        data[26..28].copy_from_slice(&1u16.to_be_bytes());
        data
    }

    fn synthetic_tables() -> BTreeMap<[u8; 4], Vec<u8>> {
        let mut tables = BTreeMap::new();
        let mut head = vec![0; 54];
        head[12..16].copy_from_slice(&0x5f0f3cf5u32.to_be_bytes());
        let mut maxp = vec![0; 6];
        maxp[4..6].copy_from_slice(&4u16.to_be_bytes());
        let mut hhea = vec![0; 36];
        hhea[34..36].copy_from_slice(&1u16.to_be_bytes());
        let mut os2 = vec![0; 96];
        os2[1] = 4;
        os2[9] = 8;
        let mut cmap = vec![0; 12];
        cmap[3] = 1;
        cmap[5] = 3;
        cmap[7] = 1;
        cmap[11] = 12;
        cmap.extend_from_slice(&format4());
        tables.insert(*b"head", head);
        tables.insert(*b"maxp", maxp);
        tables.insert(*b"hhea", hhea);
        tables.insert(*b"hmtx", vec![0; 10]);
        tables.insert(*b"loca", vec![0; 10]);
        tables.insert(*b"glyf", vec![0; 4]);
        tables.insert(*b"OS/2", os2);
        tables.insert(*b"cmap", cmap);
        tables
    }

    #[test]
    fn requested_styles_require_real_font_program_flags_not_gdi_synthesis() {
        let mut tables = synthetic_tables();
        let regular = rebuild_sfnt(tables.clone()).unwrap();
        assert!(validate_face_style(&regular, false, false).is_ok());
        assert!(validate_face_style(&regular, true, false).is_err());
        assert!(validate_face_style(&regular, false, true).is_err());
        let os2 = tables.get_mut(b"OS/2").unwrap();
        os2[4..6].copy_from_slice(&700u16.to_be_bytes());
        os2[62..64].copy_from_slice(&0x21u16.to_be_bytes());
        let bold_italic = rebuild_sfnt(tables).unwrap();
        assert!(validate_face_style(&bold_italic, true, true).is_ok());
        assert!(validate_face_style(&bold_italic, false, true).is_err());
        assert!(validate_face_style(&bold_italic, true, false).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn installed_arial_has_four_distinct_embeddable_real_style_programs() {
        let mut programs = BTreeSet::new();
        for (bold, italic) in [(false, false), (true, false), (false, true), (true, true)] {
            let font = load_editable_font_style("Arial", "Editable ABC 123", bold, italic).unwrap();
            assert!(
                programs.insert(font.bytes.clone()),
                "requested style must select a distinct real font program"
            );
            assert!(validate_text_coverage(&font.bytes, "Editable ABC 123").is_ok());
        }
    }

    #[test]
    fn rebuilding_selected_collection_face_keeps_all_glyph_tables_and_correct_checksum() {
        let mut tables = synthetic_tables();
        tables.insert(*b"DSIG", vec![1, 2, 3, 4]);
        let original_glyf = tables[b"glyf"].clone();
        let original_maxp = tables[b"maxp"].clone();
        let bytes = rebuild_sfnt(tables).unwrap();
        assert_eq!(checksum(&bytes), 0xb1b0afba);
        assert_eq!(verify_font(&bytes).unwrap(), 8);
        let rebuilt = table_directory(&bytes).unwrap();
        assert_eq!(rebuilt[b"glyf"], original_glyf);
        assert_eq!(rebuilt[b"maxp"], original_maxp);
        assert!(!rebuilt.contains_key(b"DSIG"));
        for record in bytes[12..12 + rebuilt.len() * 16].chunks_exact(16) {
            let tag: [u8; 4] = record[..4].try_into().unwrap();
            let mut data = rebuilt[&tag].to_vec();
            if tag == *b"head" {
                data[8..12].fill(0);
            }
            assert_eq!(be32(record, 4).unwrap(), checksum(&data));
            assert_eq!(be32(record, 8).unwrap() % 4, 0);
        }
        validate_text_coverage(&bytes, "ABC").unwrap();
        assert!(validate_text_coverage(&bytes, "ABCD")
            .unwrap_err()
            .starts_with("FONT_GLYPH_MISSING:"));
        assert!(validate_text_coverage(&bytes, "A\n").is_err());
        let font = EditableFont {
            family: "Synthetic".into(),
            bytes,
            fs_type: 8,
        };
        validate_font_text(&font, "").unwrap();
        validate_font_text(&font, "CBA").unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn chinese_collection_face_is_relocated_without_missing_glyph_fallback() {
        let font = match load_editable_font("Microsoft YaHei UI", "原文编辑 中文 ABC 123") {
            Ok(font) => font,
            Err(error) if error.starts_with("FONT_NOT_FOUND:") => {
                eprintln!("SKIPPED native CJK face check: optional YaHei UI is not installed on this Windows target");
                return;
            }
            Err(error) => panic!("installed YaHei collection face failed validation: {error}"),
        };
        assert_eq!(font.family, "Microsoft YaHei UI");
        validate_font_text(&font, "修改后的原文 456").unwrap();
        assert!(font.bytes.len() <= MAX_FONT_BYTES);
        let tables = verified_tables(&font.bytes).unwrap();
        assert!(tables.contains_key(b"glyf"));
        assert!(validate_font_text(&font, "\u{10ffff}").is_err());
        println!(
            "YaHei UI: {} bytes, fsType={}",
            font.bytes.len(),
            font.fs_type
        );
    }

    #[test]
    fn cmap4_delta_and_range_offset_mapping_reject_truncation_and_missing_glyphs() {
        let mut data = format4();
        assert_eq!(glyph_index(&data, 65).unwrap(), 1);
        assert_eq!(glyph_index(&data, 67).unwrap(), 3);
        assert_eq!(glyph_index(&data, 68).unwrap(), 0);
        assert_eq!(glyph_index(&data, 0xffff).unwrap(), 0);
        assert_eq!(glyph_index(&data, 0x1f600).unwrap(), 0);
        data.extend_from_slice(&[0, 5, 0, 0, 0, 7]);
        data[2..4].copy_from_slice(&38u16.to_be_bytes());
        data[24..26].copy_from_slice(&2u16.to_be_bytes());
        data[28..30].copy_from_slice(&4u16.to_be_bytes());
        assert_eq!(glyph_index(&data, 65).unwrap(), 7);
        assert_eq!(glyph_index(&data, 66).unwrap(), 0);
        assert_eq!(glyph_index(&data, 67).unwrap(), 9);
        data[28..30].copy_from_slice(&0xfffeu16.to_be_bytes());
        assert!(glyph_index(&data, 65).is_err());
        assert!(glyph_index(&data[..7], 65).is_err());
    }

    #[test]
    fn cmap12_covers_non_bmp_without_treating_surrogates_as_characters() {
        let mut data = vec![0; 28];
        data[0..2].copy_from_slice(&12u16.to_be_bytes());
        data[4..8].copy_from_slice(&28u32.to_be_bytes());
        data[12..16].copy_from_slice(&1u32.to_be_bytes());
        data[16..20].copy_from_slice(&0x20000u32.to_be_bytes());
        data[20..24].copy_from_slice(&0x20002u32.to_be_bytes());
        data[24..28].copy_from_slice(&21u32.to_be_bytes());
        assert_eq!(glyph_index(&data, 0x20000).unwrap(), 21);
        assert_eq!(glyph_index(&data, 0x20002).unwrap(), 23);
        assert_eq!(glyph_index(&data, 0x20003).unwrap(), 0);
        data[12..16].copy_from_slice(&2u32.to_be_bytes());
        assert!(glyph_index(&data, 0x20000).is_err());
    }

    #[test]
    fn font_table_directory_rejects_collections_duplicate_tags_and_out_of_range_tables() {
        for data in [
            &b"ttcf........"[..],
            &b"OTTO........"[..],
            &b"\0\x01\0\0"[..],
        ] {
            assert!(table_directory(data).is_err());
        }
        let mut data = vec![0; 44];
        data[0..4].copy_from_slice(&[0, 1, 0, 0]);
        data[4..6].copy_from_slice(&2u16.to_be_bytes());
        for offset in [12, 28] {
            data[offset..offset + 4].copy_from_slice(b"cmap");
            data[offset + 8..offset + 12].copy_from_slice(&44u32.to_be_bytes());
        }
        assert!(table_directory(&data).is_err());
        data[28..32].copy_from_slice(b"head");
        data[40..44].copy_from_slice(&1u32.to_be_bytes());
        assert!(table_directory(&data).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn installed_arial_resolves_without_fallback_and_has_ascii_glyphs() {
        let font = load_editable_font("Arial", "Editable text 123")
            .expect("Windows Arial should support editable ASCII");
        assert!(!font.bytes.is_empty() && font.bytes.len() <= MAX_FONT_BYTES);
        assert!(font.fs_type == 0 || font.fs_type == 8);
        assert!(validate_text_coverage(&font.bytes, "\u{10ffff}").is_err());
        assert!(load_editable_font("Rivuleaf Definitely Missing Font", "test").is_err());
        println!(
            "Arial: {} bytes, fsType={}, actual={}",
            font.bytes.len(),
            font.fs_type,
            font.family
        );
    }
}
