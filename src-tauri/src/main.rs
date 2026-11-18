#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if let Some(code) = jerrivell_pdf_lib::worker_entry(&args) {
        std::process::exit(code);
    }
    jerrivell_pdf_lib::run();
}
