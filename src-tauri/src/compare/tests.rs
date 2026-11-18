// SPDX-License-Identifier: MIT OR Apache-2.0
use super::*;
use std::fs;
use std::sync::atomic::AtomicBool;

pub(super) fn pdf(stream: &str, width: u32, height: u32, rotate: u32) -> Vec<u8> {
    let objects=vec!["<< /Type /Catalog /Pages 2 0 R >>".to_owned(),"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Rotate {rotate} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"),"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into(),format!("<< /Length {} >>\nstream\n{stream}\nendstream",stream.len())];
    let mut data = b"%PDF-1.7\n".to_vec();
    let mut offsets = vec![0];
    for (i, o) in objects.iter().enumerate() {
        offsets.push(data.len());
        data.extend_from_slice(format!("{} 0 obj\n{o}\nendobj\n", i + 1).as_bytes())
    }
    let xref = data.len();
    data.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()).as_bytes());
    for offset in offsets.iter().skip(1) {
        data.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes())
    }
    data.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            offsets.len()
        )
        .as_bytes(),
    );
    data
}
fn options() -> types::Options {
    types::Options {
        scale_mode: types::ScaleMode::Physical,
        page_a: 0,
        page_b: 0,
        dpi: 150,
        threshold: 0,
        offset_x_mm: 0.0,
        offset_y_mm: 0.0,
        ignored: vec![],
    }
}
#[test]
fn frontend_wire_options_round_trip() {
    let value = serde_json::json!({"pageA":0,"pageB":0,"dpi":300,"threshold":0,"offsetXmm":1.25,"offsetYmm":-0.5,"ignored":[]});
    let o: types::Options = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(o.offset_x_mm, 1.25);
    assert_eq!(serde_json::to_value(o).unwrap(), value);
}
#[test]
fn request_guard_only_local_origins() {
    for value in [
        "https://example.com/",
        "http://tauri.localhost.evil.com/",
        "http://127.0.0.1:9999/",
        "file:///C:/data.pdf",
        "javascript:alert(1)",
    ] {
        assert!(!local_url(&tauri::Url::parse(value).unwrap()), "{value}")
    }
    for value in [
        "http://tauri.localhost/compare.html",
        "http://ipc.localhost/",
        "tauri://localhost/compare.html",
    ] {
        assert!(local_url(&tauri::Url::parse(value).unwrap()))
    }
}
#[test]
fn tiles_equal_full_render_with_rotation() {
    let _guard = crate::engine::tests::NATIVE_TEST_LOCK.lock().unwrap();
    let pdfium = crate::engine::tests::native_pdfium();
    for rotation in [0, 90, 180, 270] {
        let bytes=pdf("0 0 0 RG .35 w 2 2 m 590 585 l S 20 400 540 25 re S BT /F1 23 Tf 38 230 Td (M8 +0.02) Tj ET",600,600,rotation);
        let doc = pdfium.load_pdf_from_byte_vec(bytes, None).unwrap();
        let page = doc.pages().get(0).unwrap();
        let full = engine::Engine::render(&page, 2.5, [0.0, 0.0], 0, 0, 1500, 1500).unwrap();
        let mut stitched = image::RgbaImage::new(1500, 1500);
        for y in (0..1500).step_by(512) {
            for x in (0..1500).step_by(512) {
                let tile = engine::Engine::render(
                    &page,
                    2.5,
                    [0.0, 0.0],
                    x,
                    y,
                    512.min(1500 - x),
                    512.min(1500 - y),
                )
                .unwrap();
                image::imageops::replace(&mut stitched, &tile, x as i64, y as i64)
            }
        }
        let mismatches: Vec<_> = full
            .enumerate_pixels()
            .filter(|(x, y, p)| *p != stitched.get_pixel(*x, *y))
            .map(|(x, y, p)| (x, y, p.0, stitched.get_pixel(x, y).0))
            .collect();
        let max_delta = mismatches
            .iter()
            .map(|(_, _, a, b)| (0..3).map(|c| a[c].abs_diff(b[c])).max().unwrap())
            .max()
            .unwrap_or(0);
        eprintln!("rotation {rotation}: translated-device AA deviations={}, max channel delta={max_delta}",mismatches.len());
        // PDFium's translated float32 device matrix can round AA by 1–2 levels.
        // This checks for missing/clipped geometry, not bit-identical AA between
        // two different tile layouts. A/B use the SAME layout (strict-zero test).
        assert!(
            max_delta <= 2,
            "tile rendering changed geometry at rotation {rotation}: max={max_delta}, first {:?}",
            mismatches
                .iter()
                .filter(|(_, _, a, b)| (0..3).any(|c| a[c].abs_diff(b[c]) > 2))
                .take(8)
                .collect::<Vec<_>>()
        );
    }
}
#[test]
fn actual_native_tiles_differences_alignment_and_exports() {
    // Separate PDFium instance is guarded by the crate's thread_safe binding.
    let _guard = crate::engine::tests::NATIVE_TEST_LOCK.lock().unwrap();
    let pdfium = crate::engine::tests::native_pdfium();
    let mut e = engine::Engine::new(&pdfium);
    let temp = tempfile::tempdir().unwrap();
    let a = temp.path().join("old 中文.pdf");
    let b = temp.path().join("new.pdf");
    let stream = "0 0 0 RG 0.5 w 20 20 m 500 500 l S BT /F1 18 Tf 40 140 Td (M8 +0.02) Tj ET";
    let data = pdf(stream, 600, 600, 0);
    fs::write(&a, &data).unwrap();
    fs::write(&b, &data).unwrap();
    e.open("a", a.to_str().unwrap(), None).unwrap();
    e.open("b", b.to_str().unwrap(), None).unwrap();
    let token = AtomicBool::new(false);
    let same = e
        .compare("same".into(), options(), &token, |_, _| {})
        .unwrap();
    assert_eq!(same.changed_pixels, 0);
    assert_eq!(same.tile_count, 4);
    assert!(same.regions.is_empty());
    #[cfg(windows)]
    {
        assert!(e
            .open("a", r"\\example.invalid\share\private.pdf", None)
            .is_err());
        assert!(e.open("a", "relative.pdf", None).is_err());
    }
    // Failed replacements are transactional; existing inputs are byte snapshots.
    fs::write(&b, b"this is not a PDF").unwrap();
    assert!(e.open("b", b.to_str().unwrap(), None).is_err());
    assert_eq!(
        e.compare("snapshot".into(), options(), &token, |_, _| {})
            .unwrap()
            .changed_pixels,
        0
    );
    // Tiny dot sits near a 1024-pixel seam. It must not be filtered or duplicated.
    fs::write(
        &b,
        pdf(
            &format!("{stream} 0 g 491.3 491.3 0.5 0.5 re f"),
            600,
            600,
            0,
        ),
    )
    .unwrap();
    e.open("b", b.to_str().unwrap(), None).unwrap();
    let changed = e
        .compare("changed".into(), options(), &token, |_, _| {})
        .unwrap();
    assert!(changed.changed_pixels > 0);
    assert_eq!(changed.regions.len(), 1);
    assert!(changed.regions[0].pixels < 40);
    let report_path = temp.path().join("report.csv");
    e.export("changed", report_path.to_str().unwrap(), "csv", &[1])
        .unwrap();
    assert!(fs::read_to_string(&report_path).unwrap().contains("true"));
    assert!(e
        .export("changed", report_path.to_str().unwrap(), "csv", &[])
        .is_err());
    assert!(e
        .export("changed", a.to_str().unwrap(), "png", &[])
        .is_err());
    assert_eq!(fs::read(&a).unwrap(), data);
    let mut ignored = options();
    ignored.ignored.push(types::Rect {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    });
    let excluded = e
        .compare("ignored".into(), ignored, &token, |_, _| {})
        .unwrap();
    assert_eq!(excluded.changed_pixels, 0);
    assert_eq!(
        excluded.ignored_pixels,
        excluded.pixel_width as u64 * excluded.pixel_height as u64
    );
    // A global translation can be explicitly undone without scaling the drawing.
    fs::write(
        &b,
        pdf(&format!("q 1 0 0 1 12 0 cm {stream} Q"), 600, 600, 0),
    )
    .unwrap();
    e.open("b", b.to_str().unwrap(), None).unwrap();
    let mut aligned = options();
    aligned.offset_x_mm = -12.0 * 25.4 / 72.0;
    let fixed = e
        .compare("aligned".into(), aligned, &token, |_, _| {})
        .unwrap();
    assert_eq!(fixed.changed_pixels, 0);
    assert!(fixed.uncovered);
    token.store(true, std::sync::atomic::Ordering::Release);
    assert_eq!(
        e.compare("cancel".into(), options(), &token, |_, _| {})
            .unwrap_err(),
        "COMPARE_CANCELLED"
    );
    assert!(e
        .export(
            "aligned",
            temp.path().join("stale.csv").to_str().unwrap(),
            "csv",
            &[]
        )
        .is_err());
    let mut bad = options();
    bad.page_a = u32::MAX;
    assert!(bad.validate().is_err());
    assert!(e.preview(&bad, 800, None).is_err());
}
