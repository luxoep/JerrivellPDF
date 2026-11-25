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
fn project_save_rejects_combined_decoded_image_budget_before_replacing_file() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("original.pdf");
    fs::write(&source, fixture("Original", 240, 360, 0)).unwrap();
    let mut engine = PdfEngine::new(native_pdfium());
    let document = engine.open_document(source.to_str().unwrap(), None).unwrap();
    let destination = directory.path().join("existing.jvp");
    engine.save_editable_project(destination.to_str().unwrap(), vec![page(&document, "empty")], "Safe").unwrap();
    let previous = fs::read(&destination).unwrap();
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(4096, 4096, image::Rgba([25, 60, 200, 255])))
        .write_to(&mut bytes, ImageFormat::Png).unwrap();
    let png = bytes.into_inner();
    assert!(png.len() * 3 < 16 * 1024 * 1024);
    let mut pages = vec![];
    for n in 0..3 {
        let id = format!("large-image-{n}");
        engine.assets.insert(id.clone(), ImageAsset { png: png.clone(), width: 4096, height: 4096, source_paths: vec![] });
        let mut entry = page(&document, &format!("page-{n}"));
        entry["overlays"] = json!([{"id":"image","assetId":id,"x":0.1,"y":0.1,"width":0.8,"height":0.8,"opacity":1}]);
        pages.push(entry);
    }
    assert!(engine.save_editable_project(destination.to_str().unwrap(), pages, "Oversized")
        .unwrap_err().contains("128 MiB"));
    assert_eq!(fs::read(&destination).unwrap(), previous);
    assert_eq!(engine.load_editable_project(destination.to_str().unwrap()).unwrap()["title"], "Safe");
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
    let mut legacy: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(legacy["version"], 2);
    legacy["version"] = json!(1);
    fs::write(&project, serde_json::to_vec(&legacy).unwrap()).unwrap();
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
    for mutate in 0..6 {
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
            5 => data["version"] = json!(999),
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
fn project_compact_zero_padding_and_small_frame_round_trip() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let mut engine = PdfEngine::new(native_pdfium());
    let document = engine
        .generate_pages(&GeneratePages::Blank {
            width: 240.0,
            height: 360.0,
            count: 1,
        })
        .unwrap();
    let png = image(&mut engine);
    let mut p = page(&document, "compact-page");
    p["overlays"] = json!([{"id":"compact-text","assetId":png.id,"x":0,"y":0,"width":0.05,"height":0.02,"opacity":1,
      "textSource":{"content":"123","fontFamily":"Arial","fontSize":6,"color":"#123456","bold":false,"padding":0,"frame":{"width":12,"height":6,"autoHeight":true}}}]);
    let target = directory.path().join("compact.jvp");
    engine
        .save_editable_project(target.to_str().unwrap(), vec![p.clone()], "Compact")
        .unwrap();
    let disk: Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    assert_eq!(disk["version"], 2);
    let loaded = engine
        .load_editable_project(target.to_str().unwrap())
        .unwrap();
    assert_eq!(
        loaded["workspace"][0]["overlays"][0]["textSource"],
        p["overlays"][0]["textSource"]
    );
    assert_eq!(loaded["workspace"][0]["overlays"][0]["x"], 0);
    assert_eq!(loaded["workspace"][0]["overlays"][0]["y"], 0);
    let mut invalid = disk;
    invalid["workspace"][0]["overlays"][0]["textSource"]["padding"] = json!(-1);
    let bad = directory.path().join("negative-padding.jvp");
    fs::write(&bad, serde_json::to_vec(&invalid).unwrap()).unwrap();
    assert!(engine.load_editable_project(bad.to_str().unwrap()).is_err());
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

#[test]
fn loading_another_project_and_releasing_its_sources_preserves_other_tab_history() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("independent-tabs.jvp");
    let mut engine = PdfEngine::new(native_pdfium());
    let old = engine
        .add_generated_source(fixture("Keep tab and undo", 240, 360, 0), "old.pdf")
        .unwrap();
    let png = image(&mut engine);
    let mut workspace = page(&old, "old-page");
    workspace["overlays"] = json!([{"id":"old-image","assetId":png.id,"x":0.1,"y":0.2,"width":0.2,"height":0.1,"opacity":1}]);
    let old_reference = super::super::project::page_reference(&workspace).unwrap();
    let old_pixels = engine.render_page(&old_reference, 300).unwrap().data_url;
    engine
        .save_editable_project(path.to_str().unwrap(), vec![workspace], "Independent")
        .unwrap();
    let first = engine
        .load_editable_project(path.to_str().unwrap())
        .unwrap();
    let second = engine
        .load_editable_project(path.to_str().unwrap())
        .unwrap();
    let first_reference = super::super::project::page_reference(&first["workspace"][0]).unwrap();
    let second_reference = super::super::project::page_reference(&second["workspace"][0]).unwrap();
    assert_ne!(first_reference.document_id, second_reference.document_id);
    assert_ne!(first["assets"][0]["id"], second["assets"][0]["id"]);
    assert_eq!(engine.sources.len(), 3);
    for reference in [&old_reference, &first_reference, &second_reference] {
        assert_eq!(
            engine.render_page(reference, 300).unwrap().data_url,
            old_pixels
        );
    }
    // A stale tab bookkeeping request must not partially release any live source.
    assert!(engine
        .retain_documents(&[old.id.clone(), "missing".into()])
        .is_err());
    assert_eq!(engine.sources.len(), 3);
    assert_eq!(
        engine.render_page(&first_reference, 300).unwrap().data_url,
        old_pixels
    );
    engine
        .retain_documents(&[old.id.clone(), second_reference.document_id.clone()])
        .unwrap();
    assert_eq!(engine.sources.len(), 2);
    assert!(engine
        .render_page(&first_reference, 300)
        .unwrap_err()
        .contains("DOCUMENT_CLOSED:"));
    assert!(engine
        .search_document(&first_reference.document_id, "Keep")
        .unwrap_err()
        .contains("DOCUMENT_CLOSED:"));
    assert_eq!(
        engine.render_page(&old_reference, 300).unwrap().data_url,
        old_pixels
    );
    assert_eq!(
        engine.render_page(&second_reference, 300).unwrap().data_url,
        old_pixels
    );
    // A reusable fragment image outlives the tab from which it was imported.
    assert!(engine
        .get_image_asset(first["assets"][0]["id"].as_str().unwrap())
        .is_ok());
    assert!(engine.get_image_asset(&png.id).is_ok());
}

#[test]
fn shared_project_resource_limit_failure_does_not_change_open_tabs_or_identifiers() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("resource-limit.jvp");
    let mut engine = PdfEngine::new(native_pdfium());
    let old = engine
        .add_generated_source(fixture("Resource guard", 240, 360, 0), "old.pdf")
        .unwrap();
    let workspace = page(&old, "page");
    let old_reference = super::super::project::page_reference(&workspace).unwrap();
    engine
        .save_editable_project(path.to_str().unwrap(), vec![workspace], "Limit")
        .unwrap();
    let pixels = engine.render_page(&old_reference, 240).unwrap().data_url;
    let next_id = engine.next_id;
    // Model the already-accounted snapshot budget without allocating half a GiB.
    let source_size = engine.sources.get(&old.id).unwrap().size;
    engine.sources.get_mut(&old.id).unwrap().size = MAX_SESSION_BYTES;
    assert!(engine
        .load_editable_project(path.to_str().unwrap())
        .unwrap_err()
        .contains("资源上限"));
    assert_eq!(engine.sources.len(), 1);
    assert_eq!(engine.next_id, next_id);
    assert_eq!(
        engine.render_page(&old_reference, 240).unwrap().data_url,
        pixels
    );
    engine.sources.get_mut(&old.id).unwrap().size = source_size;
    // The valid retry still receives the expected monotonic native identifier.
    let loaded = engine
        .load_editable_project(path.to_str().unwrap())
        .unwrap();
    assert!(loaded["workspace"][0]["documentId"]
        .as_str()
        .unwrap()
        .ends_with(&format!("-{next_id}")));
    assert_eq!(
        engine.render_page(&old_reference, 240).unwrap().data_url,
        pixels
    );
}
