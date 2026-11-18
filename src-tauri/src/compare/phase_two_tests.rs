// SPDX-License-Identifier: MIT OR Apache-2.0
use super::{engine::Engine, tests::pdf, types::*};
use std::{fs, sync::atomic::AtomicBool};
fn opts() -> Options {
    Options {
        page_a: 0,
        page_b: 0,
        dpi: 300,
        threshold: 16,
        offset_x_mm: 0.,
        offset_y_mm: 0.,
        ignored: vec![],
    }
}
const DRAW:&str="0 0 0 RG .6 w 30 40 520 500 re S 55 130 m 420 290 l S 80 300 130 45 re S 320 180 80 140 re S BT /F1 20 Tf 50 465 Td (M8 +0.02) Tj ET";
#[test]
fn per_side_clear_preserves_other_snapshot_and_preview() {
    let _guard = crate::engine::tests::NATIVE_TEST_LOCK.lock().unwrap();
    let p = crate::engine::tests::native_pdfium();
    let mut e = Engine::new(p);
    let d = tempfile::tempdir().unwrap();
    let a = d.path().join("a.pdf");
    let b = d.path().join("b.pdf");
    fs::write(&a, pdf(DRAW, 600, 800, 0)).unwrap();
    fs::write(&b, pdf(DRAW, 1200, 1600, 0)).unwrap();
    e.open("a", a.to_str().unwrap(), None).unwrap();
    e.open("b", b.to_str().unwrap(), None).unwrap();
    let before = e.page_preview("b", 0, 768).unwrap();
    e.clear("a").unwrap();
    let after = e.page_preview("b", 0, 768).unwrap();
    assert_eq!(before.data_url, after.data_url);
    assert!(e.preview(&opts(), 768, None).is_err());
    assert!(e.page_preview("a", 0, 768).is_err());
    assert!(e.input_bytes() > 0);
    assert!(e.clear("x").is_err());
}
#[test]
fn display_preview_does_not_scale_away_paper_changes() {
    let _guard = crate::engine::tests::NATIVE_TEST_LOCK.lock().unwrap();
    let p = crate::engine::tests::native_pdfium();
    let mut e = Engine::new(p);
    let d = tempfile::tempdir().unwrap();
    let a = d.path().join("a.pdf");
    let b = d.path().join("b.pdf");
    fs::write(&a, pdf(DRAW, 600, 800, 0)).unwrap();
    fs::write(
        &b,
        pdf(&format!("q 2 0 0 2 0 0 cm {DRAW} Q"), 1200, 1600, 0),
    )
    .unwrap();
    e.open("a", a.to_str().unwrap(), None).unwrap();
    e.open("b", b.to_str().unwrap(), None).unwrap();
    let a = e.page_preview("a", 0, 768).unwrap();
    let b = e.page_preview("b", 0, 768).unwrap();
    assert_eq!((a.width, a.height), (b.width, b.height));
    let mut o = opts();
    o.dpi = 150;
    let r = e
        .compare("size".into(), o, &AtomicBool::new(false), |_, _| {})
        .unwrap();
    assert!(r.uncovered);
    assert!(r.changed_pixels > 0);
}
#[test]
fn translation_proposal_and_explicit_application() {
    let _guard = crate::engine::tests::NATIVE_TEST_LOCK.lock().unwrap();
    let p = crate::engine::tests::native_pdfium();
    let mut e = Engine::new(p);
    let d = tempfile::tempdir().unwrap();
    let a = d.path().join("a.pdf");
    let b = d.path().join("b.pdf");
    fs::write(&a, pdf(DRAW, 600, 600, 0)).unwrap();
    fs::write(
        &b,
        pdf(&format!("q 1 0 0 1 12 -8 cm {DRAW} Q"), 600, 600, 0),
    )
    .unwrap();
    e.open("a", a.to_str().unwrap(), None).unwrap();
    e.open("b", b.to_str().unwrap(), None).unwrap();
    let o = opts();
    let t = AtomicBool::new(false);
    let m = e.auto_align(&o, &t, |_, _| {}).unwrap();
    eprintln!(
        "proposal reliable={} offsets={:.5},{:.5} agreement={:.4} margin={:.4} reason={}",
        m.reliable, m.offset_x_mm, m.offset_y_mm, m.agreement, m.ambiguity_margin, m.reason
    );
    assert!(m.reliable);
    assert!((m.offset_x_mm + 12. * 25.4 / 72.).abs() < 0.18);
    assert!((m.offset_y_mm + 8. * 25.4 / 72.).abs() < 0.18);
    let unaligned = e.compare("raw".into(), o.clone(), &t, |_, _| {}).unwrap();
    assert!(unaligned.changed_pixels > 0);
    let mut applied = o;
    applied.offset_x_mm = m.offset_x_mm;
    applied.offset_y_mm = m.offset_y_mm;
    let aligned = e.compare("aligned".into(), applied, &t, |_, _| {}).unwrap();
    eprintln!(
        "alignment pixel changes before={} after={}",
        unaligned.changed_pixels, aligned.changed_pixels
    );
    assert!(
        aligned.changed_pixels < unaligned.changed_pixels / 4,
        "subpixel raster residuals must be reduced without hiding them"
    );
}
#[test]
fn blank_alignment_and_cancel_are_not_successful_alignment() {
    let _guard = crate::engine::tests::NATIVE_TEST_LOCK.lock().unwrap();
    let p = crate::engine::tests::native_pdfium();
    let mut e = Engine::new(p);
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("blank.pdf");
    fs::write(&f, pdf(" ", 600, 600, 0)).unwrap();
    e.open("a", f.to_str().unwrap(), None).unwrap();
    e.open("b", f.to_str().unwrap(), None).unwrap();
    assert!(
        !e.auto_align(&opts(), &AtomicBool::new(false), |_, _| {})
            .unwrap()
            .reliable
    );
    assert!(e
        .auto_align(&opts(), &AtomicBool::new(true), |_, _| {})
        .is_err());
}
#[test]
fn batch_summary_csv_and_cancel_guard() {
    let _guard = crate::engine::tests::NATIVE_TEST_LOCK.lock().unwrap();
    let p = crate::engine::tests::native_pdfium();
    let mut e = Engine::new(p);
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("source.pdf");
    fs::write(&f, pdf(DRAW, 600, 600, 0)).unwrap();
    e.open("a", f.to_str().unwrap(), None).unwrap();
    e.open("b", f.to_str().unwrap(), None).unwrap();
    let mut o = opts();
    o.dpi = 150;
    let r = e
        .compare_batch(
            "batch".into(),
            vec![o.clone()],
            false,
            &AtomicBool::new(false),
            |_, _| {},
        )
        .unwrap();
    assert!(r.all_analyzed);
    assert_eq!(r.items[0].changed_pixels, Some(0));
    let csv = d.path().join("report.csv");
    e.export_batch("batch", csv.to_str().unwrap()).unwrap();
    assert!(fs::read_to_string(&csv).unwrap().contains("complete"));
    assert!(e.export_batch("batch", csv.to_str().unwrap()).is_err());
    assert!(e
        .compare_batch(
            "cancel".into(),
            vec![o.clone()],
            false,
            &AtomicBool::new(true),
            |_, _| {}
        )
        .is_err());
    assert!(e
        .export_batch("batch", d.path().join("stale.csv").to_str().unwrap())
        .is_err());
    assert!(e
        .compare_batch(
            "duplicate".into(),
            vec![o.clone(), o],
            false,
            &AtomicBool::new(false),
            |_, _| {}
        )
        .is_err());
}
#[test]
fn text_assistance_keeps_sign_changes() {
    let _guard = crate::engine::tests::NATIVE_TEST_LOCK.lock().unwrap();
    let p = crate::engine::tests::native_pdfium();
    let mut e = Engine::new(p);
    let d = tempfile::tempdir().unwrap();
    let a = d.path().join("old.pdf");
    let b = d.path().join("new.pdf");
    fs::write(&a, pdf(DRAW, 600, 600, 0)).unwrap();
    fs::write(&b, pdf(&DRAW.replace("M8 +0.02", "M10 -0.02"), 600, 600, 0)).unwrap();
    e.open("a", a.to_str().unwrap(), None).unwrap();
    e.open("b", b.to_str().unwrap(), None).unwrap();
    let v = e.text_assist(&opts()).unwrap();
    assert_eq!(v["status"], "available");
    assert!(v["changes"].to_string().contains("-0.02"));
}
