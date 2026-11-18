// SPDX-License-Identifier: MIT OR Apache-2.0
//! Shell file arguments are data, never commands to execute.
use std::path::PathBuf;

pub fn pdf_paths(args: impl IntoIterator<Item = std::ffi::OsString>) -> Vec<String> {
    let mut paths = Vec::new();
    for arg in args.into_iter().skip(1) {
        let path = PathBuf::from(arg);
        if !path.extension().is_some_and(|ext| {
            ext.to_str()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        }) {
            continue;
        }
        if let Ok(path) = path.canonicalize() {
            if path.is_file() {
                // canonicalize adds the Windows extended prefix; ordinary paths are
                // more readable in the UI and supported by the existing file API.
                let value = path.to_string_lossy().into_owned();
                let value = value
                    .strip_prefix(r"\\?\UNC\")
                    .map(|p| format!(r"\\{p}"))
                    .or_else(|| value.strip_prefix(r"\\?\").map(str::to_owned))
                    .unwrap_or(value);
                if !paths.contains(&value) {
                    paths.push(value);
                }
            }
        }
        if paths.len() >= 32 {
            break;
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_unicode_spaces_and_pdf_only_without_interpreting_options() {
        let temp = tempfile::tempdir().unwrap();
        let pdf = temp.path().join("中文 space & sample.PDF");
        let text = temp.path().join("other.txt");
        std::fs::write(&pdf, b"%PDF-test").unwrap();
        std::fs::write(&text, b"text").unwrap();
        let result = pdf_paths([
            "app.exe".into(),
            "--open".into(),
            pdf.clone().into_os_string(),
            text.into_os_string(),
            pdf.into_os_string(),
            "missing.pdf".into(),
        ]);
        assert_eq!(result.len(), 1);
        assert!(result[0].ends_with("中文 space & sample.PDF"));
    }
}
