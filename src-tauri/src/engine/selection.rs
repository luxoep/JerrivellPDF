// SPDX-License-Identifier: MIT OR Apache-2.0
use super::content::{ContentFontCache, PageSpace};
use super::*;

/// Read the user COPY bit, not the accessibility-extraction bit. The wrapper's
/// can_extract_text_and_graphics() currently tests bit 10 for revision >= 3,
/// which must not be treated as permission for ordinary clipboard copying.
/// No password, decrypted text or second parser document is retained here.
pub(super) fn copy_permission(bytes: &[u8]) -> Option<bool> {
    let document = lopdf::Document::load_mem_with_options(
        bytes,
        lopdf::LoadOptions::with_max_decompressed_size(64 * 1024 * 1024),
    )
    .ok()?;
    // Loading a file with an empty user password may already have removed
    // /Encrypt. Its retained state still carries the original user COPY bit.
    if let Some(state) = &document.encryption_state {
        return Some(state.permissions().bits() & 0x10 != 0);
    }
    match document.trailer.get(b"Encrypt") {
        Err(lopdf::Error::DictKey(_)) => Some(true),
        Err(_) => None,
        Ok(value) => {
            let dictionary = match value {
                lopdf::Object::Reference(id) => document.get_dictionary(*id).ok()?,
                lopdf::Object::Dictionary(dictionary) => dictionary,
                _ => return None,
            };
            if dictionary.get(b"Filter").ok()?.as_name().ok()? != b"Standard" {
                return None;
            }
            let permissions = dictionary.get(b"P").ok()?.as_i64().ok()?;
            Some((permissions as u32) & 0x10 != 0)
        }
    }
}

pub(super) fn source_copy_permission(
    pdfium: &Pdfium,
    bytes: &[u8],
    password: Option<&str>,
) -> Option<bool> {
    // A cheap PDFium catalog probe avoids parsing every object a second time
    // for ordinary, unencrypted PDFs. The probe drops before the owned load.
    if let Ok(document) = pdfium.load_pdf_from_byte_slice(bytes, password) {
        if matches!(
            document.permissions().security_handler_revision(),
            Ok(PdfSecurityHandlerRevision::Unprotected)
        ) {
            return Some(true);
        }
    }
    copy_permission(bytes)
}

impl PdfEngine<'_> {
    pub fn get_page_text(&self, reference: &PageRef) -> Result<Value, String> {
        let source = self.source(reference)?;
        if source.copy_allowed != Some(true) {
            return Ok(json!({"status":"restricted","text":"","glyphs":[],
                "reason": if source.copy_allowed == Some(false) {"copy-forbidden"} else {"permission-unverified"}}));
        }
        let mut output = self.copied_content_page(reference)?;
        let mut page = output.pages().get(0).map_err(pdf_error)?;
        let mut fonts = ContentFontCache::default();
        self.apply_content_edits(&mut output, &mut page, reference, &mut fonts)?;
        self.append_decorations(&mut output, &mut page, reference, &mut fonts)?;
        let text = page.text().map_err(pdf_error)?;
        if text.len() > 50_000 {
            return Ok(json!({"status":"limited","text":"","glyphs":[],"reason":"text-budget"}));
        }
        let space = PageSpace::new(&page)?;
        let mut content = String::new();
        let mut utf16 = 0usize;
        let mut glyphs = Vec::new();
        let mut pending = String::new();
        let mut previous_visible = false;
        for character in text.chars().iter() {
            let Some(value) = character.unicode_char() else {
                continue;
            };
            if value == '\0' || value.is_control() && !matches!(value, '\n' | '\r' | '\t') {
                continue;
            }
            if character.is_generated().map_err(pdf_error)? && value.is_whitespace() {
                if previous_visible {
                    pending.push(value);
                }
                continue;
            }
            let bounds = character
                .loose_bounds()
                .ok()
                .and_then(|r| space.text_bounds(r))
                .or_else(|| {
                    character
                        .tight_bounds()
                        .ok()
                        .and_then(|r| space.text_bounds(r))
                });
            let Some(bounds) = bounds else {
                previous_visible = false;
                pending.clear();
                continue;
            };
            if previous_visible {
                utf16 += pending.encode_utf16().count();
                content.push_str(&pending);
            } else if !content.is_empty() && !content.ends_with('\n') {
                content.push('\n');
                utf16 += 1;
            }
            pending.clear();
            let start = utf16;
            utf16 += value.len_utf16();
            content.push(value);
            glyphs.push(json!({"start":start,"end":utf16,"bounds":bounds}));
            previous_visible = true;
        }
        Ok(
            json!({"status":if glyphs.is_empty(){"empty"}else{"ready"},"text":content,"glyphs":glyphs}),
        )
    }
}
