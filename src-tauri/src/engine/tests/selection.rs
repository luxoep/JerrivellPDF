// SPDX-License-Identifier: MIT OR Apache-2.0
use super::*;

#[test]
fn search_highlights_follow_workspace_rotation_and_ignore_cropped_hits() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut engine = PdfEngine::new(native_pdfium());
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("search-highlights.pdf");
    fs::write(
        &path,
        fixture_with_crop("HIT   HIT", 300, 200, 0, Some([10, 20, 280, 190])),
    )
    .unwrap();
    let info = engine.open_document(path.to_str().unwrap(), None).unwrap();
    let normal: PageRef =
        serde_json::from_value(json!({"documentId":info.id,"pageIndex":0,"rotation":0}))
            .unwrap();
    let rotated = PageRef { rotation: 90, ..normal.clone() };
    let matches = engine.search_pages(&[rotated, normal.clone()], "hIt").unwrap();
    assert_eq!(matches.len(), 2);
    assert_eq!(matches[0].page_index, 0);
    assert_eq!(matches[1].page_index, 1);
    for hit in &matches {
        assert_eq!(hit.match_count, 2);
        assert_eq!(hit.rects.len(), 2);
    }
    for bbox in &matches[1].rects {
        assert!(bbox.width > 0.03 && bbox.width < 0.2);
        assert!(matches[0].rects.iter().any(|rotated| {
            let expected = [1.0 - bbox.y - bbox.height, bbox.x, bbox.height, bbox.width];
            let rendered = [rotated.x, rotated.y, rotated.width, rotated.height];
            expected.into_iter().zip(rendered).all(|(a, b)| (a - b).abs() < 0.002)
        }));
    }
    let left = &matches[1].rects[0];
    let right = &matches[1].rects[1];
    assert!(left.x + left.width < right.x);
    let crop_x = (left.x + left.width + right.x) / 2.0;
    let cropped = engine.generate_pages(&GeneratePages::Crop {
        pages: vec![normal],
        bounds: ContentBounds { x: crop_x, y: 0.0, width: 1.0 - crop_x, height: 1.0 },
    }).unwrap();
    let matches = engine.search_document(&cropped.id, "hit").unwrap();
    assert_eq!(matches[0].match_count, 1);
    assert_eq!(matches[0].rects.len(), 1);
    assert!((matches[0].rects[0].x - (right.x - crop_x) / (1.0 - crop_x)).abs() < 0.002);
}

#[test]
fn selectable_text_matches_rotation_crop_edits_and_copy_permissions() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut engine = PdfEngine::new(native_pdfium());
    let directory = tempfile::tempdir().unwrap();
    for rotation in [0, 90, 180, 270] {
        let path = directory.path().join(format!("text-{rotation}.pdf"));
        fs::write(
            &path,
            fixture_with_crop("COPY TEST", 300, 200, 90, Some([10, 20, 280, 190])),
        )
        .unwrap();
        let info = engine.open_document(path.to_str().unwrap(), None).unwrap();
        let reference: PageRef =
            serde_json::from_value(json!({"documentId":info.id,"pageIndex":0,"rotation":rotation}))
                .unwrap();
        let text = engine.get_page_text(&reference).unwrap();
        assert_eq!(text["status"], "ready");
        assert!(text["text"].as_str().unwrap().contains("COPY TEST"));
        for glyph in text["glyphs"].as_array().unwrap() {
            let b = &glyph["bounds"];
            let x = b["x"].as_f64().unwrap();
            let y = b["y"].as_f64().unwrap();
            assert!(
                x >= 0.0
                    && y >= 0.0
                    && x + b["width"].as_f64().unwrap() <= 1.00001
                    && y + b["height"].as_f64().unwrap() <= 1.00001
            );
            assert!(glyph["start"].as_u64().unwrap() < glyph["end"].as_u64().unwrap());
        }
    }
    use lopdf::encryption::{EncryptionState, EncryptionVersion, Permissions};
    for user_password in ["", "user"] {
        for allow in [false, true] {
            let mut document =
                lopdf::Document::load_mem(&fixture("PERMISSION", 300, 200, 0)).unwrap();
            let id = lopdf::Object::String(vec![7; 16], lopdf::StringFormat::Hexadecimal);
            document
                .trailer
                .set("ID", lopdf::Object::Array(vec![id.clone(), id]));
            let mut permissions = Permissions::all();
            if !allow {
                permissions.remove(Permissions::COPYABLE);
            }
            // Accessibility extraction remains enabled: it must not grant COPY.
            assert!(permissions.contains(Permissions::COPYABLE_FOR_ACCESSIBILITY));
            let state = EncryptionState::try_from(EncryptionVersion::V2 {
                document: &document,
                owner_password: "owner",
                user_password,
                key_length: 128,
                permissions,
            })
            .unwrap();
            document.encrypt(&state).unwrap();
            let mut bytes = Vec::new();
            document.save_to(&mut bytes).unwrap();
            assert_eq!(
                super::super::selection::copy_permission(&bytes),
                Some(allow)
            );
            let path = directory
                .path()
                .join(format!("permission-{}-{allow}.pdf", user_password.len()));
            fs::write(&path, &bytes).unwrap();
            let info = engine
                .open_document(path.to_str().unwrap(), Some(user_password))
                .unwrap();
            let reference: PageRef =
                serde_json::from_value(json!({"documentId":info.id,"pageIndex":0,"rotation":0}))
                    .unwrap();
            let text = engine.get_page_text(&reference).unwrap();
            assert_eq!(text["status"], if allow { "ready" } else { "restricted" });
            if !allow {
                assert_eq!(text["text"], "");
                assert_eq!(text["glyphs"].as_array().unwrap().len(), 0);
            }
        }
    }
    assert_eq!(
        super::super::selection::copy_permission(b"invalid pdf"),
        None
    );
}
