// SPDX-License-Identifier: MIT OR Apache-2.0
use super::*;
use std::collections::HashSet;

pub(super) struct PreparedExport {
    token: String,
    outputs: Vec<(Vec<u8>, usize)>,
}

pub(super) struct LimitedBuffer {
    pub bytes: Vec<u8>,
    pub limit: usize,
}
impl Write for LimitedBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) > self.limit {
            return Err(std::io::Error::other("PDF 输出超过内存预算。"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> PdfEngine<'a> {
    pub(super) fn document_bytes(
        &self,
        document: &PdfDocument<'a>,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        let mut buffer = LimitedBuffer {
            bytes: Vec::new(),
            limit,
        };
        document.save_to_writer(&mut buffer).map_err(pdf_error)?;
        Ok(buffer.bytes)
    }

    pub(super) fn prepare_document(&self, pages: &[PageRef]) -> Result<PdfDocument<'a>, String> {
        if pages.is_empty() || pages.len() > MAX_PAGES {
            return Err("输出必须包含 1～5000 页。".into());
        }
        self.validate_output_overlay_budget(pages)?;
        let mut output = self.pdfium.create_new_pdf().map_err(pdf_error)?;
        let mut fonts = content::ContentFontCache::default();
        for (index, reference) in pages.iter().enumerate() {
            self.copy_prepared_page_with_fonts(&mut output, reference, index as i32, &mut fonts)?;
        }
        Ok(output)
    }

    pub fn prepare_export(&mut self, parts: &[ExportPart]) -> Result<Value, String> {
        if parts.is_empty() || parts.len() > 200 {
            return Err("单次导出需要 1～200 个输出文件。".into());
        }
        if parts.iter().map(|part| part.pages.len()).sum::<usize>() > MAX_PAGES {
            return Err("单次导出合计最多 5000 页。".into());
        }
        self.prepared_export = None;
        let mut outputs = Vec::new();
        let mut reports = Vec::new();
        let mut total = 0_usize;
        let mut used_sources = HashSet::new();
        let mut annotations = 0_usize;
        let mut forms = false;
        for part in parts {
            if part.name.chars().count() > 180 {
                return Err("输出文件标签过长。".into());
            }
            for reference in &part.pages {
                let source = self.source(reference)?;
                used_sources.insert(reference.document_id.clone());
                let page = source
                    .document
                    .pages()
                    .get(reference.page_index as i32)
                    .map_err(pdf_error)?;
                annotations += page.annotations().len() as usize;
                forms |= source.document.form().is_some();
            }
            let document = self.prepare_document(&part.pages)?;
            let bytes =
                self.document_bytes(&document, (MAX_OUTPUT_BYTES as usize).saturating_sub(total))?;
            let reopened = self
                .pdfium
                .load_pdf_from_byte_slice(&bytes, None)
                .map_err(pdf_error)?;
            if reopened.pages().len() as usize != part.pages.len() {
                return Err("临时导出的页数验证失败。".into());
            }
            drop(reopened);
            total += bytes.len();
            reports.push(
                json!({"name": part.name, "pageCount": part.pages.len(), "bytes": bytes.len()}),
            );
            outputs.push((bytes, part.pages.len()));
        }
        let mut signatures = 0;
        let mut attachments = 0;
        let mut bookmarks = 0;
        let mut protected = false;
        for id in &used_sources {
            let document = &self.sources[id].document;
            signatures += document.signatures().len();
            attachments += document.attachments().len();
            bookmarks += document.bookmarks().iter().take(10_001).count();
            protected |= document
                .permissions()
                .security_handler_revision()
                .map(|value| value != PdfSecurityHandlerRevision::Unprotected)
                .unwrap_or(true);
        }
        let mut risks =
            vec!["输出按当前页序重组；文档级元数据、标签结构和内部链接目标不保证保留。"];
        if annotations > 0 {
            risks.push("来源选页包含批注或链接；外观、交互行为及目标页可能改变，请核对输出。");
        }
        if bookmarks > 0 {
            risks.push("来源包含书签；当前页面重组输出不保证保留书签目录。");
        }
        if attachments > 0 {
            risks.push("来源包含附件；当前输出不保证保留文档附件。");
        }
        if forms {
            risks.push("来源含表单结构；当前不保证字段、计算、填写与交互行为保留。");
        }
        if signatures > 0 {
            risks.push("来源包含数字签名；本次输出是新文档，不能保留原签名有效性。");
        }
        if protected {
            risks.push("来源包含加密或受保护设置；新输出不继承原加密设置。");
        }
        let token = format!("export-{}-{}", std::process::id(), self.next_job);
        self.next_job += 1;
        let report = json!({"token": token, "outputs": reports, "totalBytes": total, "pageCount": parts.iter().map(|part| part.pages.len()).sum::<usize>(),
            "structures": {"sourceCount": used_sources.len(), "annotationsAndLinks": annotations, "bookmarks": bookmarks, "attachments": attachments, "signatures": signatures, "forms": forms, "protected": protected}, "risks": risks});
        self.prepared_export = Some(PreparedExport { token, outputs });
        Ok(report)
    }

    pub fn discard_export(&mut self, token: &str) {
        if self
            .prepared_export
            .as_ref()
            .is_some_and(|job| job.token == token)
        {
            self.prepared_export = None;
        }
    }

    pub fn save_prepared_export(&mut self, token: &str, paths: &[String]) -> Result<Value, String> {
        let job = self
            .prepared_export
            .as_ref()
            .filter(|job| job.token == token)
            .ok_or("导出预览已失效，请重新预检。")?;
        if paths.len() != job.outputs.len() {
            return Err("输出路径数量与预览不一致。".into());
        }
        let batch = paths.len() > 1;
        let mut destinations = Vec::new();
        let mut seen = HashSet::new();
        for path in paths {
            let destination = self.destination(path, "pdf")?;
            if !seen.insert(destination.to_string_lossy().to_lowercase()) {
                return Err("输出路径不能重复。".into());
            }
            if batch && destination.exists() {
                return Err(format!("批量导出不覆盖已有文件：{}", destination.display()));
            }
            destinations.push(destination);
        }
        let mut results = Vec::new();
        let mut succeeded = 0;
        for ((bytes, page_count), destination) in job.outputs.iter().zip(&destinations) {
            let write = (|| -> Result<(), String> {
                self.destination(destination.to_str().ok_or("输出路径无效。")?, "pdf")?;
                let mut temporary =
                    NamedTempFile::new_in(destination.parent().unwrap()).map_err(pdf_error)?;
                temporary.write_all(bytes).map_err(pdf_error)?;
                temporary.as_file_mut().sync_all().map_err(pdf_error)?;
                if batch {
                    temporary
                        .persist_noclobber(destination)
                        .map_err(|error| format!("无法创建输出文件：{}", error.error))?;
                } else {
                    temporary.persist(destination).map_err(|error| {
                        format!("无法提交输出，已有文件保持不变：{}", error.error)
                    })?;
                }
                Ok(())
            })();
            match write {
                Ok(()) => { succeeded += 1; results.push(json!({"path": destination.to_string_lossy(), "pageCount": page_count, "bytes": bytes.len(), "success": true})); },
                Err(error) => results.push(json!({"path": destination.to_string_lossy(), "pageCount": page_count, "success": false, "error": error})),
            }
        }
        if succeeded == paths.len() {
            self.prepared_export = None;
        }
        Ok(json!({"results": results, "succeeded": succeeded, "failed": paths.len() - succeeded}))
    }
}
