// SPDX-License-Identifier: MIT OR Apache-2.0
use super::*;

fn image(engine: &mut PdfEngine<'_>) -> ImageAssetInfo {
    let mut png = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        12,
        8,
        image::Rgba([30, 100, 180, 190]),
    ))
    .write_to(&mut png, ImageFormat::Png)
    .unwrap();
    engine
        .register_image(&format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png.into_inner())
        ))
        .unwrap()
}

fn page(document: &DocumentInfo, id: &str) -> Value {
    json!({"id":id,"documentId":document.id,"pageIndex":0,"rotation":0,"width":document.pages[0].width,"height":document.pages[0].height,
        "sourceName":document.file_name,"overlays":[],"contentEdits":[],"decorations":[]})
}

#[test]
fn project_portable_sources_semantics_native_edits_and_asset_remapping_round_trip() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("original.pdf");
    fs::write(&source, fixture("Original", 240, 360, 0)).unwrap();
    let mut engine = PdfEngine::new(native_pdfium());
    let document = engine
        .open_document(source.to_str().unwrap(), None)
        .unwrap();
    let blank = engine
        .generate_pages(&GeneratePages::Blank {
            width: 400.0,
            height: 200.0,
            count: 1,
        })
        .unwrap();
    let png = image(&mut engine);
    let original_ref = PageRef {
        document_id: document.id.clone(),
        page_index: 0,
        rotation: 0,
        overlays: vec![],
        content_edits: vec![],
        decorations: vec![],
    };
    let inspection = engine.inspect_page_content(&original_ref).unwrap();
    let text = inspection
        .objects
        .iter()
        .find(|o| o.kind == "text")
        .unwrap();
    let mut p = page(&document, "page-one");
    p["overlays"] = json!([
        {"id":"text-one","assetId":png.id,"x":0.25,"y":0.25,"width":0.3,"height":0.1,"opacity":1,"locked":false,
          "textSource":{"content":"可编辑文字 Jerry","color":"#243746","fontSize":12,"bold":false,"fontFamily":"Arial","alignment":"left","frame":{"width":72,"height":36,"autoHeight":false}}},
        {"id":"leader-one","assetId":png.id,"x":0.1,"y":0.1,"width":0.2,"height":0.2,"opacity":0.8,"leaderFor":"text-one",
          "markSource":{"color":"#243746","geometry":{"tool":"callout","bounds":{"x":0.1,"y":0.1,"width":0.2,"height":0.2},"points":[{"x":0.12,"y":0.12},{"x":0.2,"y":0.29},{"x":0.29,"y":0.29}],"pageWidth":240,"pageHeight":360,"lineWidth":2,"lineStyle":"dashDot","arrowHeads":"start"}}}
    ]);
    p["contentEdits"] =
        json!([{"objectIndex":text.object_index,"fingerprint":text.fingerprint,"text":"Revised"}]);
    let mut other = page(&blank, "page-two");
    other["rotation"] = json!(90);
    let project = directory.path().join("portable.jvp");
    engine
        .save_editable_project(
            project.to_str().unwrap(),
            vec![other, p.clone()],
            "Portable Jerry",
        )
        .unwrap();
    let raw = fs::read_to_string(&project).unwrap();
    assert!(!raw.contains(&source.to_string_lossy().replace('\\', "\\\\")));
    fs::remove_file(&source).unwrap();
    // Mutating/removing the original file cannot change this project.
    let result = engine
        .load_editable_project(project.to_str().unwrap())
        .unwrap();
    assert_eq!(result["title"], "Portable Jerry");
    assert_eq!(result["workspace"][0]["id"], "page-two");
    assert_eq!(result["workspace"][0]["rotation"], 90);
    assert_eq!(
        result["workspace"][1]["overlays"][0]["textSource"],
        p["overlays"][0]["textSource"]
    );
    assert_eq!(
        result["workspace"][1]["overlays"][1]["markSource"],
        p["overlays"][1]["markSource"]
    );
    assert_eq!(
        result["workspace"][1]["overlays"][1]["leaderFor"],
        "text-one"
    );
    assert_ne!(result["workspace"][1]["documentId"], document.id);
    assert_ne!(result["workspace"][1]["overlays"][0]["assetId"], png.id);
    assert_eq!(result["assets"].as_array().unwrap().len(), 1);
    assert!(result["documents"]
        .as_array()
        .unwrap()
        .iter()
        .all(|d| d["path"].as_str().unwrap().starts_with("memory://")));
    let refs = super::super::project::references(result["workspace"].as_array().unwrap()).unwrap();
    let destination = directory.path().join("exported.pdf");
    engine
        .save_document(destination.to_str().unwrap(), &refs)
        .unwrap();
    let reopened = engine
        .open_document(destination.to_str().unwrap(), None)
        .unwrap();
    assert_eq!(reopened.page_count, 2);
    assert_eq!(
        engine
            .search_document(&reopened.id, "Revised")
            .unwrap()
            .len(),
        1
    );
    // A later project save uses fresh native IDs yet retains all source semantics.
    engine
        .save_editable_project(
            directory.path().join("again.jvp").to_str().unwrap(),
            result["workspace"].as_array().unwrap().clone(),
            "Again",
        )
        .unwrap();
}

#[test]
fn project_invalid_load_and_save_leave_existing_session_and_destination_unchanged() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.pdf");
    fs::write(&source, fixture("Keep original", 240, 360, 0)).unwrap();
    let mut engine = PdfEngine::new(native_pdfium());
    let document = engine
        .open_document(source.to_str().unwrap(), None)
        .unwrap();
    let png = image(&mut engine);
    let mut p = page(&document, "page");
    p["overlays"] =
        json!([{"id":"one","assetId":png.id,"x":0.1,"y":0.1,"width":0.2,"height":0.1,"opacity":1}]);
    let project = directory.path().join("valid.jvp");
    engine
        .save_editable_project(project.to_str().unwrap(), vec![p.clone()], "Keep")
        .unwrap();
    let saved = fs::read(&project).unwrap();
    let original = super::super::project::page_reference(&p).unwrap();
    let raster = engine.render_page(&original, 240).unwrap().data_url;
    let mut damaged: Value = serde_json::from_slice(&saved).unwrap();
    let bad = directory.path().join("bad.jvp");
    for mutate in 0..5 {
        let mut data = damaged.clone();
        match mutate {
            0 => data["assets"][0]["pngBase64"] = json!("not-a-png"),
            1 => {
                data["workspace"][0]["overlays"][0]["textSource"] = json!({"content":"Bad","fontSize":999,"bold":false,"fontFamily":"Arial","color":"#112233"})
            }
            2 => {
                data["workspace"][0]["overlays"][0]["markSource"] = json!({"color":"#112233","geometry":{"tool":"polyarrow","points":[],"bounds":{"x":0,"y":0,"width":0.2,"height":0.2},"pageWidth":240,"pageHeight":360,"lineWidth":2}})
            }
            3 => data["workspace"][0]["overlays"][0]["leaderFor"] = json!("missing-text"),
            _ => {
                data["sources"][0]["pdfBase64"] =
                    json!(base64::engine::general_purpose::STANDARD.encode(b"not a PDF"))
            }
        }
        fs::write(&bad, serde_json::to_vec(&data).unwrap()).unwrap();
        assert!(engine.load_editable_project(bad.to_str().unwrap()).is_err());
        assert_eq!(
            engine.render_page(&original, 240).unwrap().data_url,
            raster,
            "failed load {mutate} must preserve session"
        );
    }
    p["overlays"][0]["textSource"] = json!({"content":"Invalid","fontSize":999,"bold":false,"fontFamily":"Arial","color":"#112233"});
    assert!(engine
        .save_editable_project(project.to_str().unwrap(), vec![p], "Invalid")
        .is_err());
    assert_eq!(fs::read(&project).unwrap(), saved);
    damaged["workspace"][0]["documentId"] = json!("unknown");
    fs::write(&bad, serde_json::to_vec(&damaged).unwrap()).unwrap();
    assert!(engine.load_editable_project(bad.to_str().unwrap()).is_err());
    assert_eq!(engine.render_page(&original, 240).unwrap().data_url, raster);
}

#[test]
fn project_restores_original_image_replacement_asset_references() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let pdfium = native_pdfium();
    let document = pdfium
        .load_pdf_from_byte_vec(fixture("Keep text", 240, 360, 0), None)
        .unwrap();
    let mut sheet = document.pages().get(0).unwrap();
    sheet
        .objects_mut()
        .create_image_object(
            PdfPoints::new(70.0),
            PdfPoints::new(140.0),
            &DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
                12,
                8,
                image::Rgba([240, 70, 30, 255]),
            )),
            Some(PdfPoints::new(80.0)),
            Some(PdfPoints::new(50.0)),
        )
        .unwrap();
    sheet.regenerate_content().unwrap();
    drop(sheet);
    let mut engine = PdfEngine::new(pdfium);
    let source = engine
        .add_generated_source(document.save_to_bytes().unwrap(), "embedded-image.pdf")
        .unwrap();
    let replacement = image(&mut engine);
    let mut workspace = page(&source, "image-page");
    let original = super::super::project::page_reference(&workspace).unwrap();
    let inspection = engine.inspect_page_content(&original).unwrap();
    let object = inspection
        .objects
        .iter()
        .find(|o| o.kind == "image" && o.editable)
        .expect("test source has an editable image");
    workspace["contentEdits"] = json!([{"objectIndex":object.object_index,"fingerprint":object.fingerprint,"replacementAssetId":replacement.id}]);
    let edited = super::super::project::page_reference(&workspace).unwrap();
    let expected = engine.render_page(&edited, 400).unwrap().data_url;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("replacement.jvp");
    engine
        .save_editable_project(path.to_str().unwrap(), vec![workspace], "Image replacement")
        .unwrap();
    let restored = engine
        .load_editable_project(path.to_str().unwrap())
        .unwrap();
    let id = restored["workspace"][0]["contentEdits"][0]["replacementAssetId"]
        .as_str()
        .unwrap();
    assert_ne!(id, replacement.id);
    assert_eq!(id, restored["assets"][0]["id"].as_str().unwrap());
    let reference = super::super::project::page_reference(&restored["workspace"][0]).unwrap();
    assert_eq!(
        engine.render_page(&reference, 400).unwrap().data_url,
        expected
    );
}
