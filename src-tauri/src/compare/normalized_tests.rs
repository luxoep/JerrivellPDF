// SPDX-License-Identifier: MIT OR Apache-2.0
use super::{engine::Engine, tests::pdf, types::*};
use base64::Engine as _;
use std::{fs, sync::atomic::AtomicBool};
const DRAW: &str = "0 0 0 RG .6 w 30 40 520 500 re S 55 130 m 420 290 l S 80 300 130 45 re S 320 180 80 140 re S BT /F1 20 Tf 50 465 Td (M8 +0.02) Tj ET";
fn options() -> Options {
    Options {
        scale_mode: ScaleMode::Normalized,
        page_a: 0,
        page_b: 0,
        dpi: 150,
        threshold: 0,
        offset_x_mm: 0.,
        offset_y_mm: 0.,
        ignored: vec![],
    }
}
#[test]
fn normalized_analysis_matches_twice_sized_page_and_preserves_tiny_changes() {
    let _guard = crate::engine::tests::NATIVE_TEST_LOCK.lock().unwrap();
    let p = crate::engine::tests::native_pdfium();
    let mut e = Engine::new(p);
    let d = tempfile::tempdir().unwrap();
    let a = d.path().join("a.pdf");
    let b = d.path().join("b.pdf");
    let token = AtomicBool::new(false);
    fs::write(&a, pdf(DRAW, 600, 800, 0)).unwrap();
    fs::write(
        &b,
        pdf(&format!("q 2 0 0 2 0 0 cm {DRAW} Q"), 1200, 1600, 0),
    )
    .unwrap();
    e.open("a", a.to_str().unwrap(), None).unwrap();
    e.open("b", b.to_str().unwrap(), None).unwrap();
    let o = options();
    let r = e
        .compare("normalized".into(), o.clone(), &token, |_, _| {})
        .unwrap();
    assert_eq!(r.changed_pixels, 0);
    assert!(!r.uncovered);
    assert_eq!((r.width_pt, r.height_pt), (600., 800.));
    let preview = e.preview(&o, 900, None).unwrap();
    assert_eq!(preview.a.data_url, preview.b.data_url);
    let mut physical = o.clone();
    physical.scale_mode = ScaleMode::Physical;
    let raw = e
        .compare("physical".into(), physical, &token, |_, _| {})
        .unwrap();
    assert!(raw.uncovered);
    assert!(raw.changed_pixels > 0);
    fs::write(
        &b,
        pdf(
            &format!("q 2 0 0 2 0 0 cm {DRAW} 0 g 480 700 .8 .8 re f Q"),
            1200,
            1600,
            0,
        ),
    )
    .unwrap();
    e.open("b", b.to_str().unwrap(), None).unwrap();
    let changed = e
        .compare("changed".into(), o.clone(), &token, |_, _| {})
        .unwrap();
    assert!(changed.changed_pixels > 0);
    assert!(changed.regions.iter().any(|v| v.pixels <= 25));
    let csv = d.path().join("normalized.csv");
    e.export("changed", csv.to_str().unwrap(), "csv", &[])
        .unwrap();
    let text = fs::read_to_string(csv).unwrap();
    assert!(text.contains("scaleMode=normalized"));
    assert!(text.contains("scaleB=0.500000000"));
    assert!(text.contains("x_ref_mm"));
    assert!(text.contains("not-physical"));
    let b = e
        .compare_batch("batch".into(), vec![o], false, &token, |_, _| {})
        .unwrap();
    assert!(b.all_analyzed);
    assert_eq!(b.items[0].changed_pixels, Some(changed.changed_pixels));
    let csv = d.path().join("batch.csv");
    e.export_batch("batch", csv.to_str().unwrap()).unwrap();
    let text = fs::read_to_string(csv).unwrap();
    assert!(text.contains("scale_mode,scale_b,coordinate_units"));
    assert!(text.contains(",normalized,0.500000000,A-reference-units-not-physical"));
}
#[test]
fn normalized_rendering_keeps_aspect_ratio_and_centers_letterbox() {
    let _guard = crate::engine::tests::NATIVE_TEST_LOCK.lock().unwrap();
    let p = crate::engine::tests::native_pdfium();
    let mut e = Engine::new(p);
    let d = tempfile::tempdir().unwrap();
    let a = d.path().join("a.pdf");
    let b = d.path().join("b.pdf");
    fs::write(&a, pdf("", 600, 800, 0)).unwrap();
    fs::write(&b, pdf("0 0 0 RG 2 w 100 100 800 800 re S", 1000, 1000, 0)).unwrap();
    e.open("a", a.to_str().unwrap(), None).unwrap();
    e.open("b", b.to_str().unwrap(), None).unwrap();
    let preview = e.preview(&options(), 600, None).unwrap();
    assert!(preview.uncovered);
    assert_eq!((preview.b.width, preview.b.height), (600, 800));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(preview.b.data_url.split_once(',').unwrap().1)
        .unwrap();
    let image = image::load_from_memory(&bytes).unwrap().to_rgb8();
    let (mut l, mut t, mut r, mut b) = (600, 800, 0, 0);
    for (x, y, p) in image.enumerate_pixels() {
        if p[0] < 100 {
            l = l.min(x);
            t = t.min(y);
            r = r.max(x);
            b = b.max(y)
        }
    }
    assert!((r - l).abs_diff(b - t) <= 2);
    assert!(
        l.abs_diff(59) <= 2 && t.abs_diff(159) <= 2,
        "square must be centered without stretching: {l},{t},{r},{b}"
    );
}
#[test]
fn normalized_auto_alignment_refines_in_reference_units_and_rotation_stays_valid() {
    let _guard = crate::engine::tests::NATIVE_TEST_LOCK.lock().unwrap();
    let p = crate::engine::tests::native_pdfium();
    let mut e = Engine::new(p);
    let d = tempfile::tempdir().unwrap();
    let a = d.path().join("a.pdf");
    let b = d.path().join("b.pdf");
    let token = AtomicBool::new(false);
    fs::write(&a, pdf(DRAW, 600, 800, 0)).unwrap();
    fs::write(
        &b,
        pdf(&format!("q 2 0 0 2 24 -12 cm {DRAW} Q"), 1200, 1600, 0),
    )
    .unwrap();
    e.open("a", a.to_str().unwrap(), None).unwrap();
    e.open("b", b.to_str().unwrap(), None).unwrap();
    let mut o = options();
    o.dpi = 300;
    o.threshold = 16;
    let alignment = e.auto_align(&o, &token, |_, _| {}).unwrap();
    assert!(alignment.reliable);
    assert!((alignment.offset_x_mm + 12. * 25.4 / 72.).abs() < 0.18);
    assert!((alignment.offset_y_mm + 6. * 25.4 / 72.).abs() < 0.18);
    let raw = e
        .compare("raw".into(), o.clone(), &token, |_, _| {})
        .unwrap();
    o.offset_x_mm = alignment.offset_x_mm;
    o.offset_y_mm = alignment.offset_y_mm;
    let aligned = e.compare("aligned".into(), o, &token, |_, _| {}).unwrap();
    assert!(aligned.changed_pixels <= raw.changed_pixels / 4);
    for rotation in [90, 180, 270] {
        fs::write(&a, pdf(DRAW, 600, 800, rotation)).unwrap();
        fs::write(
            &b,
            pdf(&format!("q 2 0 0 2 0 0 cm {DRAW} Q"), 1200, 1600, rotation),
        )
        .unwrap();
        e.open("a", a.to_str().unwrap(), None).unwrap();
        e.open("b", b.to_str().unwrap(), None).unwrap();
        let same = e
            .compare(format!("rotation-{rotation}"), options(), &token, |_, _| {})
            .unwrap();
        assert_eq!(same.changed_pixels, 0, "rotation {rotation}");
    }
}
