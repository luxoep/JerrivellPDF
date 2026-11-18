// SPDX-License-Identifier: MIT OR Apache-2.0
use super::*;

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
