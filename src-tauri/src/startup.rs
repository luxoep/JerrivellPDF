// SPDX-License-Identifier: MIT OR Apache-2.0
//! Shell file arguments are data, never commands to execute.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const OPEN_FILES_EVENT: &str = "jerrivell://open-files";

/// The event is only a wake-up signal. Paths stay here until the frontend is
/// listening and can drain them, including requests received during startup.
/// Keep repeats across launches: opening A, B, A should focus A last.
#[derive(Default)]
pub struct OpenRequests(Mutex<Vec<String>>);

impl OpenRequests {
    pub fn new(files: Vec<String>) -> Self {
        Self(Mutex::new(files))
    }

    pub fn append(&self, files: Vec<String>) -> bool {
        if files.is_empty() {
            return false;
        }
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(files);
        true
    }

    pub fn drain(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

pub fn pdf_paths(args: impl IntoIterator<Item = std::ffi::OsString>) -> Vec<String> {
    pdf_paths_from(args, &std::env::current_dir().unwrap_or_default())
}

/// A subsequent launch can have a different working directory from the owner.
/// Resolve its relative files against the sender's cwd, never the owner's cwd.
pub fn pdf_paths_from(
    args: impl IntoIterator<Item = std::ffi::OsString>,
    working_directory: &Path,
) -> Vec<String> {
    let mut paths = Vec::new();
    for arg in args.into_iter().skip(1) {
        let path = PathBuf::from(arg);
        if !path.extension().is_some_and(|ext| {
            ext.to_str()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        }) {
            continue;
        }
        let path = if path.is_absolute() {
            path
        } else {
            working_directory.join(path)
        };
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
                if !paths
                    .iter()
                    .any(|existing: &String| existing.eq_ignore_ascii_case(&value))
                {
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

    #[test]
    fn resolves_relative_files_against_sending_process_directory() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("sender 中文.pdf"), b"%PDF-test").unwrap();
        std::fs::create_dir(directory.path().join("folder.pdf")).unwrap();
        let paths = pdf_paths_from(
            [
                "app.exe".into(),
                "--open".into(),
                "sender 中文.pdf".into(),
                "folder.pdf".into(),
            ],
            directory.path(),
        );
        assert_eq!(paths.len(), 1);
        assert!(Path::new(&paths[0]).is_absolute());
        assert!(paths[0].ends_with("sender 中文.pdf"));
    }

    #[test]
    fn request_queue_keeps_early_launches_and_last_duplicate_focus_order() {
        let requests = OpenRequests::new(vec!["first.pdf".into()]);
        assert!(requests.append(vec!["second.pdf".into(), "first.pdf".into()]));
        assert!(!requests.append(vec![]));
        assert_eq!(
            requests.drain(),
            vec!["first.pdf", "second.pdf", "first.pdf"]
        );
        assert!(requests.drain().is_empty());
        requests.append(vec!["after-ready.pdf".into()]);
        assert_eq!(requests.drain(), vec!["after-ready.pdf"]);
    }

    #[test]
    fn concurrent_drain_never_loses_or_duplicates_an_arrival() {
        let requests = std::sync::Arc::new(OpenRequests::default());
        let producer = requests.clone();
        let thread = std::thread::spawn(move || {
            for n in 0..1000 {
                producer.append(vec![format!("{n}.pdf")]);
            }
        });
        let mut received = Vec::new();
        while !thread.is_finished() {
            received.extend(requests.drain());
            std::thread::yield_now();
        }
        thread.join().unwrap();
        received.extend(requests.drain());
        assert_eq!(
            received,
            (0..1000).map(|n| format!("{n}.pdf")).collect::<Vec<_>>()
        );
    }
}
