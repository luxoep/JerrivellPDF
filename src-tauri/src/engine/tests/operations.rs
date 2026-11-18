// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;

fn reference(info: &DocumentInfo, index: u32, turn: u16) -> PageRef {
    PageRef {
        document_id: info.id.clone(),
        page_index: index,
        rotation: turn,
        overlays: vec![],
        content_edits: vec![],
        decorations: vec![],
    }
}

#[test]
fn native_blank_images_crop_decorations_and_export_review() {
    let _serial = NATIVE_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let pdfium = native_pdfium();
    let mut engine = PdfEngine::new(pdfium);
    let temp = tempfile::tempdir().unwrap();
    let blank = engine
        .generate_pages(&GeneratePages::Blank {
            width: 595.2756,
            height: 841.8898,
            count: 2,
        })
        .unwrap();
    assert_eq!(blank.page_count, 2);
    assert!(blank.path.starts_with("memory://"));
    let blank_page = reference(&blank, 0, 0);
    let report = engine
        .prepare_export(&[ExportPart {
            name: "blank.pdf".into(),
            pages: vec![blank_page.clone(), reference(&blank, 1, 90)],
        }])
        .unwrap();
    let target = temp.path().join("blank.pdf");
    let token = report["token"].as_str().unwrap();
    assert_eq!(report["pageCount"], 2);
    let saved = engine
        .save_prepared_export(token, &[target.to_string_lossy().into_owned()])
        .unwrap();
    assert_eq!(saved["succeeded"], 1);
    assert_eq!(
        fs::metadata(&target).unwrap().len(),
        report["totalBytes"].as_u64().unwrap()
    );
    assert!(engine
        .save_prepared_export(token, &[target.to_string_lossy().into_owned()])
        .is_err());
    assert_eq!(
        pdfium
            .load_pdf_from_file(&target, None)
            .unwrap()
            .pages()
            .get(1)
            .unwrap()
            .rotation()
            .unwrap()
            .as_degrees(),
        90.0
    );

    let image_path = temp.path().join("original.png");
    DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        180,
        80,
        image::Rgba([30, 180, 50, 255]),
    ))
    .save(&image_path)
    .unwrap();
    let original = fs::read(&image_path).unwrap();
    let image_doc = engine
        .generate_pages(&GeneratePages::Images {
            paths: vec![image_path.to_string_lossy().into_owned()],
            paper: "a4".into(),
            margin: 20.0,
        })
        .unwrap();
    assert!(image_doc.pages[0].width > image_doc.pages[0].height);
    assert_eq!(original, fs::read(&image_path).unwrap());
    let alias = temp.path().join("image-alias.pdf");
    fs::hard_link(&image_path, &alias).unwrap();
    assert!(engine
        .save_document(alias.to_str().unwrap(), &[reference(&image_doc, 0, 0)])
        .is_err());

    let source_path = temp.path().join("geometry.pdf");
    fs::write(
        &source_path,
        fixture_with_crop("Geometry", 400, 300, 90, Some([20, 30, 380, 270])),
    )
    .unwrap();
    let source = engine
        .open_document(source_path.to_str().unwrap(), None)
        .unwrap();
    for turn in [0, 90, 180, 270] {
        let plan = reference(&source, 0, turn);
        let cropped = engine
            .generate_pages(&GeneratePages::Crop {
                pages: vec![plan],
                bounds: ContentBounds {
                    x: 0.1,
                    y: 0.2,
                    width: 0.6,
                    height: 0.5,
                },
            })
            .unwrap();
        let (w, h) = if turn % 180 == 0 {
            (source.pages[0].width, source.pages[0].height)
        } else {
            (source.pages[0].height, source.pages[0].width)
        };
        assert!(
            (cropped.pages[0].width - w * 0.6).abs() < 0.1,
            "turn {turn}: {} / {}",
            cropped.pages[0].width,
            w * 0.6
        );
        assert!((cropped.pages[0].height - h * 0.5).abs() < 0.1);
        assert!(!engine
            .render_page(&reference(&cropped, 0, 0), 400)
            .unwrap()
            .data_url
            .is_empty());
    }
    let mut numbered = reference(&source, 0, 90);
    numbered.decorations = vec![
        PageDecoration {
            id: "number".into(),
            kind: "number".into(),
            text: "7 / 9".into(),
            font_family: None,
            font_size: 12.0,
            color: "#334455".into(),
            opacity: 1.0,
            angle: 0.0,
            x: 0.5,
            y: 0.9,
            alignment: "center".into(),
        },
        PageDecoration {
            id: "watermark".into(),
            kind: "watermark".into(),
            text: "INTERNAL".into(),
            font_family: None,
            font_size: 20.0,
            color: "#667788".into(),
            opacity: 0.2,
            angle: -30.0,
            x: 0.5,
            y: 0.5,
            alignment: "center".into(),
        },
    ];
    let diagnostic =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-results/0.6.0/diagnostic");
    fs::create_dir_all(&diagnostic).unwrap();
    let prepared = engine.prepare_document(&[numbered.clone()]).unwrap();
    let decoration_bytes = prepared.save_to_bytes().unwrap();
    fs::write(diagnostic.join("decorations.pdf"), &decoration_bytes).unwrap();
    drop(prepared);
    let reloaded = engine
        .add_generated_source(decoration_bytes, "reload.pdf")
        .unwrap();
    let reloaded_text = engine
        .page_content_text(&reference(&reloaded, 0, 0))
        .unwrap();
    assert!(reloaded_text.contains("7 / 9") && reloaded_text.contains("INTERNAL"));
    let text = engine.page_content_text(&numbered).unwrap();
    assert!(text.contains("7 / 9"), "text: {text:?}");
    assert!(text.contains("INTERNAL"), "text: {text:?}");
    engine.render_page(&numbered, 700).unwrap();
    let mut invalid = numbered.clone();
    invalid.decorations[0].x = 2.0;
    assert!(engine.prepare_document(&[invalid]).is_err());
    let batches = engine
        .prepare_export(&[
            ExportPart {
                name: "one.pdf".into(),
                pages: vec![numbered.clone()],
            },
            ExportPart {
                name: "two.pdf".into(),
                pages: vec![blank_page],
            },
        ])
        .unwrap();
    let one = temp.path().join("one.pdf");
    let two = temp.path().join("two.pdf");
    fs::write(&two, b"keep").unwrap();
    assert!(engine
        .save_prepared_export(
            batches["token"].as_str().unwrap(),
            &[
                one.to_string_lossy().into_owned(),
                two.to_string_lossy().into_owned()
            ]
        )
        .is_err());
    assert!(!one.exists());
    assert_eq!(fs::read(&two).unwrap(), b"keep");
    engine.discard_export(batches["token"].as_str().unwrap());
}

#[test]
fn native_text_line_spacing_preview_alignment_and_overflow() {
    let _serial = NATIVE_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let pdfium = native_pdfium();
    let mut engine = PdfEngine::new(pdfium);
    let temp = tempfile::tempdir().unwrap();
    let mut document = pdfium.create_new_pdf().unwrap();
    let font = document.fonts_mut().helvetica();
    let mut page = document
        .pages_mut()
        .create_page_at_end(PdfPagePaperSize::new_custom(
            PdfPoints::new(400.0),
            PdfPoints::new(300.0),
        ))
        .unwrap();
    page.objects_mut()
        .create_text_object(
            PdfPoints::new(40.0),
            PdfPoints::new(220.0),
            "HEL",
            font,
            PdfPoints::new(20.0),
        )
        .unwrap();
    page.objects_mut()
        .create_text_object(
            PdfPoints::new(79.0),
            PdfPoints::new(220.0),
            "LO",
            font,
            PdfPoints::new(20.0),
        )
        .unwrap();
    page.objects_mut()
        .create_text_object(
            PdfPoints::new(40.0),
            PdfPoints::new(60.0),
            "KEEP",
            font,
            PdfPoints::new(12.0),
        )
        .unwrap();
    page.regenerate_content().unwrap();
    drop(page);
    let path = temp.path().join("fragments.pdf");
    let original = document.save_to_bytes().unwrap();
    fs::write(&path, &original).unwrap();
    drop(document);
    let source = engine.open_document(path.to_str().unwrap(), None).unwrap();
    let plan = reference(&source, 0, 0);
    let inspection = engine.inspect_page_content(&plan).unwrap();
    let fragments: Vec<_> = inspection
        .objects
        .iter()
        .filter(|object| matches!(object.text.as_deref(), Some("HEL" | "LO")))
        .collect();
    assert_eq!(fragments.len(), 2);
    assert!(fragments
        .iter()
        .all(|object| object.text_angle.unwrap().abs() < 0.01));
    let x = fragments
        .iter()
        .map(|object| object.bounds.x)
        .fold(f32::INFINITY, f32::min);
    let y = fragments
        .iter()
        .map(|object| object.bounds.y)
        .fold(f32::INFINITY, f32::min);
    let right = fragments
        .iter()
        .map(|object| object.bounds.x + object.bounds.width)
        .fold(0.0_f32, f32::max);
    let bottom = fragments
        .iter()
        .map(|object| object.bounds.y + object.bounds.height)
        .fold(0.0_f32, f32::max);
    let mut request = LineEditRequest {
        page: plan.clone(),
        objects: fragments
            .iter()
            .map(|object| LineObjectRef {
                object_index: object.object_index,
                fingerprint: object.fingerprint.clone(),
            })
            .collect(),
        bounds: ContentBounds {
            x,
            y,
            width: right - x,
            height: bottom - y,
        },
        text: "HELLO".into(),
        font_family: None,
        font_size: 20.0,
        color: "#224466".into(),
        char_spacing: 0.0,
        alignment: "left".into(),
        constrain_width: false,
    };
    let narrow = engine.preview_line_edit(&request).unwrap();
    assert_eq!(narrow["canApply"], true);
    request.char_spacing = 3.0;
    request.alignment = "center".into();
    let expanded = engine.preview_line_edit(&request).unwrap();
    let diagnostic =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-results/0.6.0/diagnostic");
    fs::create_dir_all(&diagnostic).unwrap();
    fs::write(
        diagnostic.join("line.pdf"),
        &engine.prepared_line.as_ref().unwrap().bytes,
    )
    .unwrap();
    assert!(
        expanded["textWidth"].as_f64().unwrap() > narrow["textWidth"].as_f64().unwrap() + 10.0,
        "width narrow {:?}, wide {:?}",
        narrow["textWidth"],
        expanded["textWidth"]
    );
    assert_eq!(expanded["canApply"], true);
    assert_eq!(expanded["overflowLine"], true);
    assert!(engine
        .commit_line_preview(narrow["token"].as_str().unwrap())
        .is_err());
    let edited = engine
        .commit_line_preview(expanded["token"].as_str().unwrap())
        .unwrap();
    let result = engine
        .inspect_page_content(&reference(&edited, 0, 0))
        .unwrap();
    assert_eq!(
        result
            .objects
            .iter()
            .filter(|object| object.kind == "text")
            .count(),
        2
    );
    assert!(result
        .objects
        .iter()
        .any(|object| object.text.as_deref() == Some("HELLO")));
    assert!(result
        .objects
        .iter()
        .any(|object| object.text.as_deref() == Some("KEEP")));
    let new_line = result
        .objects
        .iter()
        .find(|object| object.text.as_deref() == Some("HELLO"))
        .unwrap();
    assert!(
        ((new_line.bounds.x + new_line.bounds.width / 2.0)
            - (request.bounds.x + request.bounds.width / 2.0))
            .abs()
            < 0.001
    );
    let mut with_decoration = reference(&edited, 0, 0);
    with_decoration.decorations = vec![PageDecoration {
        id: "continued".into(),
        kind: "number".into(),
        text: "1".into(),
        font_family: None,
        font_size: 10.0,
        color: "#222222".into(),
        opacity: 1.0,
        angle: 0.0,
        x: 0.5,
        y: 0.95,
        alignment: "center".into(),
    }];
    let continued_path = temp.path().join("continued.pdf");
    engine
        .save_document(continued_path.to_str().unwrap(), &[with_decoration])
        .unwrap();
    let continued = engine
        .open_document(continued_path.to_str().unwrap(), None)
        .unwrap();
    let continued_objects = engine
        .inspect_page_content(&reference(&continued, 0, 0))
        .unwrap();
    let continued_line = continued_objects
        .objects
        .iter()
        .find(|object| object.text.as_deref() == Some("HELLO"))
        .unwrap();
    assert!(
        (continued_line.bounds.width - new_line.bounds.width).abs() < 0.001,
        "Letter spacing must survive subsequent edits and save"
    );
    request.text = "X".repeat(100);
    request.char_spacing = 5.0;
    request.constrain_width = true;
    let overflow = engine.preview_line_edit(&request).unwrap();
    assert_eq!(overflow["overflowPage"], true);
    assert_eq!(overflow["canApply"], false);
    assert!(engine
        .commit_line_preview(overflow["token"].as_str().unwrap())
        .is_err());
    assert_eq!(fs::read(path).unwrap(), original);
}
