use super::*;
use image::{Rgba, RgbaImage};

fn base_pdf(turn: u16, crop: bool) -> Vec<u8> {
    let stream = "0 0 0 rg BT /F1 18 Tf 60 80 Td (AlphaOld) Tj ET\nBT /F1 14 Tf 60 130 Td (KeepText) Tj ET\n0 0 1 rg 240 200 70 30 re f";
    let crop = if crop {
        " /CropBox [40 30 360 270]"
    } else {
        ""
    };
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Rotate {turn}{crop} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
    ];
    let mut data = b"%PDF-1.7\n".to_vec();
    let mut offsets = vec![0];
    for (i, object) in objects.iter().enumerate() {
        offsets.push(data.len());
        data.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, object).as_bytes());
    }
    let xref = data.len();
    data.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()).as_bytes());
    for offset in offsets.iter().skip(1) {
        data.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
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

fn source_bytes(pdfium: &Pdfium, turn: u16, crop: bool) -> Vec<u8> {
    let document = pdfium
        .load_pdf_from_byte_vec(base_pdf(turn, crop), None)
        .unwrap();
    let mut page = document.pages().get(0).unwrap();
    let pixels = DynamicImage::ImageRgba8(RgbaImage::from_pixel(12, 8, Rgba([255, 0, 0, 255])));
    page.objects_mut()
        .create_image_object(
            PdfPoints::new(250.0),
            PdfPoints::new(60.0),
            &pixels,
            Some(PdfPoints::new(60.0)),
            Some(PdfPoints::new(45.0)),
        )
        .unwrap();
    page.regenerate_content().unwrap();
    drop(page);
    document.save_to_bytes().unwrap()
}

fn plan(document: &DocumentInfo, turn: u16) -> PageRef {
    PageRef {
        document_id: document.id.clone(),
        page_index: 0,
        rotation: turn,
        overlays: vec![],
        content_edits: vec![],
        decorations: vec![],
    }
}

fn patch(object: &ContentObject, fields: Value) -> ContentEdit {
    let mut value = fields.as_object().unwrap().clone();
    value.insert("objectIndex".into(), json!(object.object_index));
    value.insert("fingerprint".into(), json!(object.fingerprint));
    serde_json::from_value(Value::Object(value)).unwrap()
}

fn pixels(render: RenderedPage) -> RgbaImage {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(render.data_url.split_once(',').unwrap().1)
        .unwrap();
    image::load_from_memory_with_format(&bytes, ImageFormat::Png)
        .unwrap()
        .into_rgba8()
}

fn png_data_url(color: [u8; 4]) -> String {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(RgbaImage::from_pixel(16, 10, Rgba(color)))
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    )
}

fn near(actual: f32, expected: f32, message: &str) {
    assert!(
        (actual - expected).abs() < 0.0001,
        "{message}: actual {actual}, expected {expected}"
    );
}

#[test]
fn original_objects_edit_search_geometry_images_delete_and_round_trip() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let pdfium = native_pdfium();
    let directory = tempfile::tempdir().unwrap();
    for (case, (native_turn, extra_turn, crop)) in [
        (0, 0, false),
        (0, 90, false),
        (90, 0, false),
        (90, 180, false),
        (270, 90, true),
        (0, 270, true),
    ]
    .into_iter()
    .enumerate()
    {
        let source = directory.path().join(format!("source-{case}.pdf"));
        let original_bytes = source_bytes(pdfium, native_turn, crop);
        fs::write(&source, &original_bytes).unwrap();
        let mut engine = PdfEngine::new(pdfium);
        let document = engine
            .open_document(source.to_str().unwrap(), None)
            .unwrap();
        let original = plan(&document, extra_turn);
        let inspection = engine.inspect_page_content(&original).unwrap();
        let text = inspection
            .objects
            .iter()
            .find(|o| o.text.as_deref() == Some("AlphaOld"))
            .unwrap();
        let image = inspection
            .objects
            .iter()
            .find(|o| o.kind == "image")
            .unwrap();
        assert!(text.editable, "{:?}", text.reason);
        assert!(image.editable, "{:?}", image.reason);
        assert!(
            inspection.objects.iter().any(|o| o.kind == "unsupported"),
            "The original vector must stay an object"
        );
        let asset = engine
            .register_image(&png_data_url([0, 255, 0, 255]))
            .unwrap();
        let mut edited = original.clone();
        edited.content_edits = vec![
            patch(
                text,
                json!({"text":"BetaNew","fontSize":22,"fillColor":"#C02B38","bounds":{"x":0.1,"y":0.6,"width":0.5,"height":0.08}}),
            ),
            patch(
                image,
                json!({"replacementAssetId":asset.id,"bounds":{"x":0.6,"y":0.15,"width":0.2,"height":0.2}}),
            ),
        ];
        let current = engine.inspect_page_content(&edited).unwrap();
        let current_text = current
            .objects
            .iter()
            .find(|o| o.object_index == text.object_index)
            .unwrap();
        assert_eq!(current_text.text.as_deref(), Some("BetaNew"));
        assert_eq!(
            current_text.fingerprint, text.fingerprint,
            "identity is always from original"
        );
        assert_eq!(current_text.original_text.as_deref(), Some("AlphaOld"));
        near(
            current_text.bounds.x,
            0.1,
            "normalized x after source/native rotation and CropBox",
        );
        near(current_text.bounds.y, 0.6, "normalized y");
        near(current_text.bounds.width, 0.5, "normalized width");
        near(current_text.bounds.height, 0.08, "normalized height");
        let text_after = engine.page_content_text(&edited).unwrap();
        assert!(text_after.contains("BetaNew") && text_after.contains("KeepText"));
        assert!(!text_after.contains("AlphaOld"));
        let before = pixels(engine.render_page(&edited, 800).unwrap());
        let green = before.get_pixel(
            (before.width() as f32 * 0.7) as u32,
            (before.height() as f32 * 0.25) as u32,
        );
        assert!(
            green.0[1] > 245 && green.0[0] < 10 && green.0[2] < 10,
            "replacement image {green:?}"
        );
        let destination = directory.path().join(format!("edited-{case}.pdf"));
        engine
            .save_document(destination.to_str().unwrap(), &[edited.clone()])
            .unwrap();
        let reopened = engine
            .open_document(destination.to_str().unwrap(), None)
            .unwrap();
        assert_eq!(
            engine
                .search_document(&reopened.id, "BetaNew")
                .unwrap()
                .len(),
            1
        );
        assert!(engine
            .search_document(&reopened.id, "AlphaOld")
            .unwrap()
            .is_empty());
        assert_eq!(
            before,
            pixels(engine.render_page(&plan(&reopened, 0), 800).unwrap()),
            "saved and planned pixels must agree"
        );
        let reopened_info = engine.inspect_page_content(&plan(&reopened, 0)).unwrap();
        assert_eq!(reopened_info.total_objects, inspection.total_objects);
        assert!(reopened_info
            .objects
            .iter()
            .any(|o| o.kind == "unsupported"));

        // Native removal, not overpainting. The deleted original identity stays
        // in inspection results for restoring the immutable plan.
        let mut removed = original.clone();
        removed.content_edits = vec![
            patch(text, json!({"deleted":true})),
            patch(image, json!({"deleted":true})),
        ];
        let removed_info = engine.inspect_page_content(&removed).unwrap();
        assert_eq!(removed_info.objects.iter().filter(|o| o.deleted).count(), 2);
        assert!(!engine
            .page_content_text(&removed)
            .unwrap()
            .contains("AlphaOld"));
        let removed_destination = directory.path().join(format!("removed-{case}.pdf"));
        engine
            .save_document(removed_destination.to_str().unwrap(), &[removed])
            .unwrap();
        let removed_document = engine
            .open_document(removed_destination.to_str().unwrap(), None)
            .unwrap();
        assert_eq!(
            engine
                .inspect_page_content(&plan(&removed_document, 0))
                .unwrap()
                .total_objects,
            inspection.total_objects - 2
        );
        assert!(engine
            .page_content_text(&original)
            .unwrap()
            .contains("AlphaOld"));
        assert_eq!(fs::read(&source).unwrap(), original_bytes);
        assert!(engine
            .save_document(source.to_str().unwrap(), &[edited])
            .is_err());
    }
}

#[test]
fn original_text_local_font_embedding_bounds_and_invalid_patches() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let pdfium = native_pdfium();
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("font-source.pdf");
    let original_bytes = source_bytes(pdfium, 0, false);
    fs::write(&source, &original_bytes).unwrap();
    let mut engine = PdfEngine::new(pdfium);
    let document = engine
        .open_document(source.to_str().unwrap(), None)
        .unwrap();
    let original = plan(&document, 0);
    let info = engine.inspect_page_content(&original).unwrap();
    let text = info
        .objects
        .iter()
        .find(|o| o.text.as_deref() == Some("AlphaOld"))
        .unwrap();
    let image = info.objects.iter().find(|o| o.kind == "image").unwrap();
    let mut edited = original.clone();
    edited.content_edits = vec![patch(
        text,
        json!({"text":"原文修改 DEMO","fontFamily":"楷体","fontSize":16}),
    )];
    let changed = engine.inspect_page_content(&edited).unwrap();
    assert_eq!(
        changed
            .objects
            .iter()
            .find(|o| o.object_index == text.object_index)
            .unwrap()
            .text
            .as_deref(),
        Some("原文修改 DEMO")
    );
    let expected = pixels(engine.render_page(&edited, 800).unwrap());
    let file = directory.path().join("embedded-cjk.pdf");
    engine
        .save_document(file.to_str().unwrap(), &[edited.clone(), edited.clone()])
        .unwrap();
    assert_eq!(
        engine.content_fonts.borrow().len(),
        1,
        "session must reuse one font-byte snapshot"
    );
    let reopened = engine.open_document(file.to_str().unwrap(), None).unwrap();
    assert_eq!(reopened.page_count, 2);
    assert_eq!(
        engine
            .search_document(&reopened.id, "原文修改")
            .unwrap()
            .len(),
        2
    );
    assert!(engine
        .search_document(&reopened.id, "AlphaOld")
        .unwrap()
        .is_empty());
    assert_eq!(
        expected,
        pixels(engine.render_page(&plan(&reopened, 0), 800).unwrap())
    );

    for fields in [
        json!({"text":""}),
        json!({"text":"one\ntwo"}),
        json!({"text":"😀"}),
        json!({"fontSize":0}),
        json!({"fontSize":513}),
        json!({"opacity":0.0}),
        json!({"opacity":1.1}),
        json!({"bold":true}),
        json!({"italic":true}),
        json!({"fillColor":"#GG00FF"}),
        json!({"bounds":{"x":0.99,"y":0,"width":0.5,"height":0.1}}),
        json!({"text":"新增字符"}),
        json!({"fontFamily":"not-a-real-installed-family-040"}),
        json!({"replacementAssetId":"missing"}),
    ] {
        let mut invalid = original.clone();
        invalid.content_edits = vec![patch(text, fields.clone())];
        assert!(
            engine.inspect_page_content(&invalid).is_err(),
            "must reject {fields}"
        );
    }
    let mut invalid = original.clone();
    invalid.content_edits = vec![patch(image, json!({"text":"not image text"}))];
    assert!(engine.inspect_page_content(&invalid).is_err());
    invalid.content_edits = vec![
        patch(text, json!({"text":"Beta"})),
        patch(text, json!({"text":"Beta"})),
    ];
    assert!(engine.inspect_page_content(&invalid).is_err());
    invalid.content_edits = vec![patch(text, json!({"fingerprint":"bad","text":"Beta"}))];
    // patch() always supplies the correct identity, so explicitly corrupt it.
    invalid.content_edits[0].fingerprint = "bad".into();
    assert!(engine.inspect_page_content(&invalid).is_err());
    let unchanged = engine.inspect_page_content(&original).unwrap();
    assert_eq!(
        unchanged
            .objects
            .iter()
            .find(|o| o.object_index == text.object_index)
            .unwrap()
            .text
            .as_deref(),
        Some("AlphaOld")
    );
    assert_eq!(fs::read(&source).unwrap(), original_bytes);
}

#[test]
fn original_text_real_style_opacity_and_saved_searchable_unicode() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let pdfium = native_pdfium();
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("real-style-source.pdf");
    fs::write(&source, source_bytes(pdfium, 0, false)).unwrap();
    let mut engine = PdfEngine::new(pdfium);
    let document = engine
        .open_document(source.to_str().unwrap(), None)
        .unwrap();
    let original = plan(&document, 0);
    let info = engine.inspect_page_content(&original).unwrap();
    let text = info
        .objects
        .iter()
        .find(|object| object.text.as_deref() == Some("AlphaOld"))
        .unwrap();
    for (index, (bold, italic)) in [(false, false), (true, false), (false, true), (true, true)]
        .into_iter()
        .enumerate()
    {
        let mut edited = original.clone();
        edited.content_edits = vec![patch(
            text,
            json!({"text":"Native styled text", "fontFamily":"Arial", "fontSize":16, "bold":bold, "italic":italic, "opacity":0.65}),
        )];
        let current = engine.inspect_page_content(&edited).unwrap();
        let current = current
            .objects
            .iter()
            .find(|object| object.object_index == text.object_index)
            .unwrap();
        assert_eq!(current.fingerprint, text.fingerprint);
        assert_eq!(current.bold, Some(bold));
        assert_eq!(current.italic, Some(italic));
        assert!((current.opacity.unwrap() - 0.65).abs() < 0.005);
        let pixels_before = pixels(engine.render_page(&edited, 600).unwrap());
        let output = directory.path().join(format!("style-{index}.pdf"));
        engine
            .save_document(output.to_str().unwrap(), &[edited])
            .unwrap();
        let reopened = engine
            .open_document(output.to_str().unwrap(), None)
            .unwrap();
        assert_eq!(
            engine
                .search_document(&reopened.id, "Native styled text")
                .unwrap()
                .len(),
            1
        );
        assert!(engine
            .search_document(&reopened.id, "AlphaOld")
            .unwrap()
            .is_empty());
        assert_eq!(
            pixels_before,
            pixels(engine.render_page(&plan(&reopened, 0), 600).unwrap())
        );
    }
    assert_eq!(
        engine.content_fonts.borrow().len(),
        4,
        "font cache must separate four real faces"
    );
    assert!(engine
        .page_content_text(&original)
        .unwrap()
        .contains("AlphaOld"));
}
