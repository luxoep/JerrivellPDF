use super::*;
use image::{Rgba, RgbaImage};
use lopdf::dictionary;

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
fn original_edits_preserve_line_styles_across_content_streams() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("dimension-lines.pdf");
    let mut drawing = lopdf::Document::load_mem(&base_pdf(0, false)).unwrap();
    let page = drawing.get_pages()[&1];
    let form = drawing.add_object(lopdf::Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 6.into(), 6.into()],
            "Resources" => dictionary! {},
        },
        b"0 0 1 rg 0 0 6 6 re f".to_vec(),
    ));
    drawing.get_dictionary_mut(page).unwrap()
        .get_mut(b"Resources").unwrap().as_dict_mut().unwrap()
        .set("XObject", dictionary! { "Detail" => form });
    let first = drawing.add_object(lopdf::Stream::new(
        dictionary! {},
        b"q 1 0 0 1 28 274 cm /Detail Do Q\n2 w 20 260 m 210 260 l S\nq [12 5 2 5 2 5] 2 d 20 220 m 210 220 l S".to_vec(),
    ));
    let mut second = b"20 180 m 210 180 l S\n[] 0 d 20 140 m 210 140 l S\nQ\nq 50 310 200 -45 re W n 20 278 m 250 278 l S Q\n".to_vec();
    second.extend(drawing.get_page_content(page));
    let second = drawing.add_object(lopdf::Stream::new(dictionary! {}, second));
    drawing.get_dictionary_mut(page).unwrap().set(
        "Contents",
        vec![first.into(), second.into()],
    );
    drawing.save(&source).unwrap();
    let original_bytes = fs::read(&source).unwrap();
    let mut engine = PdfEngine::new(native_pdfium());
    let opened = engine.open_document(source.to_str().unwrap(), None).unwrap();
    let original = plan(&opened, 0);
    let inspection = engine.inspect_page_content(&original).unwrap();
    let text = inspection
        .objects.iter()
        .find(|item| item.text.as_deref() == Some("AlphaOld"))
        .unwrap();
    let render = |engine: &PdfEngine<'_>, page: &PageRef| pixels(engine.render_page(page, 800).unwrap());
    let before = render(&engine, &original);
    let line_pixels = |image: &RgbaImage| {
        [44, 80, 160, 240, 320]
            .into_iter()
            .flat_map(|y| (42..110).map(move |x| *image.get_pixel(x, y)))
            .collect::<Vec<_>>()
    };
    let has_gap = |y| (42..420).any(|x| before.get_pixel(x, y).0[0] == 255);
    assert!(has_gap(160) && has_gap(240), "dash patterns must include gaps");
    assert!(!has_gap(80) && !has_gap(320), "solid paths must be continuous");

    let layers = engine
        .render_object_layers(&original, text.object_index, &text.fingerprint, 800)
        .unwrap();
    assert!(line_pixels(&pixels(layers.lower)) == line_pixels(&before), "drag preview changes line styles");

    let mut edited = original.clone();
    edited.content_edits.push(patch(text, json!({"text":"BetaNew"})));
    let edited_pixels = render(&engine, &edited);
    assert!(line_pixels(&edited_pixels) == line_pixels(&before), "editing changes neighboring line styles");

    let path = directory.path().join("edited.pdf");
    engine.save_document(path.to_str().unwrap(), &[edited]).unwrap();
    let reopened = engine.open_document(path.to_str().unwrap(), None).unwrap();
    let saved = plan(&reopened, 0);
    assert!(render(&engine, &saved) == edited_pixels, "saving changes the edited preview");
    assert!(engine.page_content_text(&saved).unwrap().contains("BetaNew"));

    let region =[(0.58, 0.22), (0.8, 0.22), (0.8, 0.35), (0.58, 0.35)]
        .map(|(x, y)| ImagePoint { x, y })
        .to_vec();
    let asset = engine.edit_feature(&FeatureRequest::Extract { page: original.clone(), region: region.clone() }).unwrap();
    let generated = engine.generate_pages(&GeneratePages::CutFeature { page: original, region }).unwrap();
    let mut with_fragment = plan(&generated, 0);
    with_fragment.overlays.push(serde_json::from_value(json!({
        "id": "fragment", "assetId": asset.id, "x": 0.6, "y": 0.6,
        "width": 0.22, "height": 0.13, "opacity": 1.0
    })).unwrap());
    let path = directory.path().join("fragment.pdf");
    engine.save_document(path.to_str().unwrap(), &[with_fragment]).unwrap();
    let reopened = engine.open_document(path.to_str().unwrap(), None).unwrap();
    assert!(line_pixels(&render(&engine, &plan(&reopened, 0))) == line_pixels(&before), "feature export changes line styles outside the cut");
    assert_eq!(fs::read(&source).unwrap(), original_bytes);
}

#[test]
fn original_edit_preserves_shading_and_inline_images_in_other_streams() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let mut drawing = lopdf::Document::load_mem(&base_pdf(0, false)).unwrap();
    let page = drawing.get_pages()[&1];
    drawing.get_dictionary_mut(page).unwrap()
        .get_mut(b"Resources").unwrap().as_dict_mut().unwrap().set("Shading", dictionary! {
            "Gradient" => dictionary! {
                "ShadingType" => 2, "ColorSpace" => "DeviceRGB",
                "Coords" => vec![180.into(), 0.into(), 220.into(), 0.into()],
                "Function" => dictionary! {
                    "FunctionType" => 2, "Domain" => vec![0.into(), 1.into()],
                    "C0" => vec![1.into(), 0.into(), 0.into()],
                    "C1" => vec![0.into(), 0.into(), 1.into()], "N" => 1,
                },
            },
        });
    let gradient = drawing.add_object(lopdf::Stream::new(
        dictionary! {},
        b"q 180 40 40 30 re W n /Gradient sh Q\n".to_vec(),
    ));
    let inline = drawing.add_object(lopdf::Stream::new(
        dictionary! {},
        b"q 40 0 0 30 240 40 cm BI /W 1 /H 1 /BPC 8 /CS /RGB ID \x00\xff\x00 EI Q\n".to_vec(),
    ));
    let text_stream = drawing.get_page_contents(page)[0];
    let mut engine = PdfEngine::new(native_pdfium());
    for (name, artwork_stream, pixel_x) in [("shading", gradient, 400), ("inline", inline, 520)] {
        drawing.get_dictionary_mut(page).unwrap().set(
            "Contents", vec![artwork_stream.into(), text_stream.into()],
        );
        let source = directory.path().join(format!("{name}.pdf"));
        drawing.save(&source).unwrap();
        let opened = engine.open_document(source.to_str().unwrap(), None).unwrap();
        let mut edited = plan(&opened, 0);
        let sample = |engine: &PdfEngine<'_>, page: &PageRef| {
            let rendered = pixels(engine.render_page(page, 800).unwrap());
            *rendered.get_pixel(pixel_x, 490)
        };
        let artwork = sample(&engine, &edited);
        assert_ne!(artwork, Rgba([255; 4]));
        let inspection = engine.inspect_page_content(&edited).unwrap();
        let text = inspection.objects.iter().find(|item| item.text.as_deref() == Some("AlphaOld")).unwrap();
        edited.content_edits.push(patch(text, json!({"text":"BetaNew"})));
        let path = directory.path().join(format!("edited-{name}.pdf"));
        engine.save_document(path.to_str().unwrap(), &[edited]).unwrap();
        let reopened = engine.open_document(path.to_str().unwrap(), None).unwrap();
        let saved = plan(&reopened, 0);
        assert_eq!(sample(&engine, &saved), artwork, "{name} changed after saving");
        assert!(engine.page_content_text(&saved).unwrap().contains("BetaNew"));
    }
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
            inspection.objects.iter().any(|o| o.kind == "path"),
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
            .any(|o| o.kind == "path"));

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
fn native_pixel_erase_preserves_raster_resolution_and_page_objects_on_save() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let pdfium = native_pdfium();
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("mixed-drawing.pdf");
    let mut document = lopdf::Document::load_mem(&base_pdf(0, false)).unwrap();
    let dimensions = (3200, 128);
    let stripes = RgbaImage::from_fn(dimensions.0, dimensions.1, |x, _| {
        if x % 2 == 0 {
            Rgba([240, 20, 30, 255])
        } else {
            Rgba([40, 150, 55, 255])
        }
    });
    let rgb = stripes
        .pixels()
        .flat_map(|p| [p.0[0], p.0[1], p.0[2]])
        .collect();
    let image_id = document.add_object(lopdf::Stream::new(dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => i64::from(dimensions.0),
        "Height" => i64::from(dimensions.1), "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
    }, rgb));
    let page_id = document.get_pages()[&1];
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .get_mut(b"Resources")
        .unwrap()
        .as_dict_mut()
        .unwrap()
        .set("XObject", dictionary! {"ImShared" => image_id});
    document
        .add_page_contents(
            page_id,
            b"q 120 0 0 45 210 60 cm /ImShared Do Q\nq 120 0 0 30 210 20 cm /ImShared Do Q\n"
                .to_vec(),
        )
        .unwrap();
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    fs::write(&source, &bytes).unwrap();

    let mut engine = PdfEngine::new(pdfium);
    let opened = engine
        .open_document(source.to_str().unwrap(), None)
        .unwrap();
    let reference = plan(&opened, 0);
    let objects = engine.inspect_page_content(&reference).unwrap().objects;
    let image = objects
        .iter()
        .find(|o| o.kind == "image" && o.editable)
        .unwrap();
    let path = objects
        .iter()
        .find(|o| o.kind == "path" && o.editable)
        .unwrap();
    assert!(engine
        .extract_content_image(&reference, path.object_index, &path.fingerprint)
        .is_err());
    let selected = engine
        .extract_content_image(&reference, image.object_index, &image.fingerprint)
        .unwrap();
    let asset_pixels = |info: &ImageAssetInfo| {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(info.data_url.split_once(',').unwrap().1)
            .unwrap();
        image::load_from_memory_with_format(&bytes, ImageFormat::Png)
            .unwrap()
            .into_rgba8()
    };
    assert_eq!((selected.width, selected.height), dimensions);
    assert_eq!(
        asset_pixels(&selected),
        stripes,
        "intrinsic one-pixel stripes stay intact"
    );
    let erase = |x| EraseStroke {
        mode: EraseMode::Transparent,
        points: vec![ImagePoint { x, y: 0.5 }],
        width: 24.0,
    };
    let first_edit = engine
        .edit_image_asset(&selected.id, None, &[erase(0.5)])
        .unwrap();
    let mut edited = reference.clone();
    edited.content_edits = vec![patch(image, json!({"replacementAssetId":first_edit.id}))];
    let repeated = engine
        .extract_content_image(&edited, image.object_index, &image.fingerprint)
        .unwrap();
    assert_eq!(
        repeated.id, first_edit.id,
        "a second erase uses the same retained full-size asset"
    );
    let second_edit = engine
        .edit_image_asset(&repeated.id, None, &[erase(0.75)])
        .unwrap();
    let expected = asset_pixels(&second_edit);
    assert_eq!(expected.dimensions(), dimensions);
    assert_eq!(expected.get_pixel(1600, 64).0[3], 0);
    assert_eq!(expected.get_pixel(2400, 64).0[3], 0);
    for x in 10..200 {
        assert_eq!(expected.get_pixel(x, 64), stripes.get_pixel(x, 64));
    }

    let workspace = json!({"id":"mixed","documentId":opened.id,"pageIndex":0,"rotation":0,
    "width":opened.pages[0].width,"height":opened.pages[0].height,"sourceName":"mixed.pdf",
    "overlays":[],"decorations":[],"contentEdits":[{
        "objectIndex":image.object_index,"fingerprint":image.fingerprint,"replacementAssetId":second_edit.id
    }]});
    let project = directory.path().join("mixed.jvp");
    engine
        .save_editable_project(project.to_str().unwrap(), vec![workspace], "Mixed drawing")
        .unwrap();
    let restored = engine
        .load_editable_project(project.to_str().unwrap())
        .unwrap();
    let restored_ref = super::super::project::page_reference(&restored["workspace"][0]).unwrap();
    let original_image = engine
        .inspect_page_content(&restored_ref)
        .unwrap()
        .objects
        .into_iter()
        .find(|o| o.kind == "image" && o.editable)
        .unwrap();
    let restored_asset = engine
        .extract_content_image(
            &restored_ref,
            original_image.object_index,
            &original_image.fingerprint,
        )
        .unwrap();
    assert_eq!(asset_pixels(&restored_asset), expected);

    let export = directory.path().join("edited.pdf");
    engine
        .save_document(export.to_str().unwrap(), &[restored_ref])
        .unwrap();
    let reopened = engine
        .open_document(export.to_str().unwrap(), None)
        .unwrap();
    let reopened_ref = plan(&reopened, 0);
    assert!(engine
        .page_content_text(&reopened_ref)
        .unwrap()
        .contains("KeepText"));
    let inspection = engine.inspect_page_content(&reopened_ref).unwrap();
    assert!(inspection
        .objects
        .iter()
        .any(|object| object.kind == "path"));
    let mut images = inspection
        .objects
        .iter()
        .filter(|o| o.kind == "image" && o.editable);
    let image = images.next().unwrap();
    let sibling = images.next().unwrap();
    let exported_asset = engine
        .extract_content_image(&reopened_ref, image.object_index, &image.fingerprint)
        .unwrap();
    let exported_pixels = asset_pixels(&exported_asset);
    assert_eq!(exported_pixels.dimensions(), dimensions);
    assert_eq!(exported_pixels.get_pixel(1600, 64).0[3], 0);
    assert_eq!(exported_pixels.get_pixel(2400, 64).0[3], 0);
    for x in 10..200 {
        assert_eq!(exported_pixels.get_pixel(x, 64), expected.get_pixel(x, 64));
    }
    let sibling_asset = engine
        .extract_content_image(&reopened_ref, sibling.object_index, &sibling.fingerprint)
        .unwrap();
    assert_eq!(
        asset_pixels(&sibling_asset),
        stripes,
        "the second draw of the shared image stays unchanged"
    );
    let path = inspection
        .objects
        .iter()
        .find(|o| o.kind == "path" && o.editable)
        .unwrap();
    let mut invalid_path = reopened_ref.clone();
    invalid_path.content_edits = vec![patch(path, json!({"bounds":path.bounds}))];
    assert!(engine.inspect_page_content(&invalid_path).is_err());
    let mut removed = reopened_ref.clone();
    removed.content_edits = vec![patch(path, json!({"deleted":true}))];
    let destination = directory.path().join("removed-path.pdf");
    engine
        .save_document(destination.to_str().unwrap(), &[removed])
        .unwrap();
    let reopened = engine
        .open_document(destination.to_str().unwrap(), None)
        .unwrap();
    let after_removal = plan(&reopened, 0);
    assert!(engine
        .page_content_text(&after_removal)
        .unwrap()
        .contains("KeepText"));
    let remaining = engine.inspect_page_content(&after_removal).unwrap().objects;
    assert_eq!(remaining.len() + 1, inspection.objects.len());
    assert!(remaining.iter().any(|object| object.kind == "image"));
    assert_eq!(fs::read(source).unwrap(), bytes);
}

#[test]
fn page_region_erase_keeps_text_paths_and_original_image_resolution() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("layers.pdf");
    let mut doc = lopdf::Document::load_mem(&base_pdf(0, false)).unwrap();
    let rgb = [238, 51, 34].repeat(3400 * 32);
    let image = doc.add_object(lopdf::Stream::new(dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => 3400,
        "Height" => 32, "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
    }, rgb));
    let form = doc.add_object(lopdf::Stream::new(dictionary! {
        "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
        "Resources" => dictionary! {},
    }, b"0 0.7 0 rg 0 0 100 100 re f".to_vec()));
    let page = doc.get_pages()[&1];
    doc.get_dictionary_mut(page).unwrap()
        .get_mut(b"Resources").unwrap().as_dict_mut().unwrap()
        .set("XObject", dictionary! {"Raster" => image, "Nested" => form});
    let mut stream = b"q 140 0 0 50 45 50 cm /Raster Do Q\nq 1 0 0 1 260 60 cm /Nested Do Q\n".to_vec();
    stream.extend(doc.get_page_content(page));
    doc.change_page_content(page, stream).unwrap();
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    fs::write(&source, &bytes).unwrap();

    let mut engine = PdfEngine::new(native_pdfium());
    let opened = engine.open_document(source.to_str().unwrap(), None).unwrap();
    let start = plan(&opened, 0);
    let rect = |x0, y0, x1, y1| vec![
        ImagePoint { x: x0, y: y0 }, ImagePoint { x: x1, y: y0 },
        ImagePoint { x: x1, y: y1 }, ImagePoint { x: x0, y: y1 },
    ];
    assert!(engine.erase_regions(&start, &[rect(0.1, 0.25, 0.5, 0.5)]).is_err());
    let edited = engine.generate_pages(&GeneratePages::EraseRegions {
        page: start.clone(),
        regions: vec![rect(0.13, 0.67, 0.22, 0.81), rect(0.20, 0.69, 0.27, 0.81), rect(0.70, 0.55, 0.82, 0.70)],
    }).unwrap();
    let edited = plan(&edited, 0);
    let rendered = |engine: &PdfEngine<'_>, page: &PageRef| pixels(engine.render_page(page, 800).unwrap());
    let original = rendered(&engine, &start);
    let after = rendered(&engine, &edited);
    let pixel = |image: &RgbaImage, x: f32, y: f32| {
        image.get_pixel((x * image.width() as f32) as u32, (y * image.height() as f32) as u32).0
    };
    for (x, y) in [(0.16, 0.79), (0.21, 0.79), (0.25, 0.79), (0.74, 0.60)] {
        assert_ne!(pixel(&original, x, y), [255; 4]);
        assert_eq!(pixel(&after, x, y), [255; 4], "masked region at {x}, {y}");
    }
    for (x, y) in [(0.31, 0.79), (0.86, 0.60), (0.68, 0.26), (0.2, 0.92)] {
        assert_eq!(pixel(&after, x, y), pixel(&original, x, y));
    }
    let objects = engine.inspect_page_content(&edited).unwrap().objects;
    assert!(objects.iter().any(|object| object.editable && object.kind == "path"));
    let text = objects.iter().find(|object| object.text.as_deref() == Some("AlphaOld")).unwrap();
    assert!(text.editable, "text stays editable where it overlaps the masked image");
    assert!(engine.page_content_text(&edited).unwrap().contains("AlphaOld"));

    let rotated = PageRef { rotation: 90, ..edited };
    let erased_again = engine.erase_regions(&rotated, &[rect(0.18, 0.29, 0.23, 0.37)]).unwrap();
    let mut export = plan(&erased_again, 0);
    let previous = rendered(&engine, &rotated);
    let result = rendered(&engine, &export);
    assert_ne!(pixel(&previous, 0.21, 0.32), [255; 4]);
    assert_eq!(pixel(&result, 0.21, 0.32), [255; 4]);
    let stamp = engine.register_image(&png_data_url([25, 100, 200, 255])).unwrap();
    export.overlays = vec![serde_json::from_value(json!({"id":"stamp","assetId":stamp.id,"x":0.05,"y":0.05,"width":0.08,"height":0.08,"opacity":1})).unwrap()];
    let destination = directory.path().join("export.pdf");
    engine.save_document(destination.to_str().unwrap(), &[export.clone()]).unwrap();
    let reopened = engine.open_document(destination.to_str().unwrap(), None).unwrap();
    let reopened = plan(&reopened, 0);
    assert_eq!(rendered(&engine, &export), rendered(&engine, &reopened));
    assert_eq!(pixel(&rendered(&engine, &reopened), 0.21, 0.32), [255; 4]);
    assert!(engine.page_content_text(&reopened).unwrap().contains("KeepText"));
    let exported = lopdf::Document::load(&destination).unwrap();
    assert!(exported.objects.values().filter_map(|value| value.as_stream().ok()).any(|stream| {
        stream.dict.get(b"Width").and_then(lopdf::Object::as_i64).ok() == Some(3400)
    }));
    assert_eq!(fs::read(&source).unwrap(), bytes);
}

#[test]
fn feature_cutout_keeps_paper_opaque_and_reopens_with_recolor_source() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("feature-source.pdf");
    let original = base_pdf(0, false);
    fs::write(&input, &original).unwrap();
    let mut engine = PdfEngine::new(native_pdfium());
    let document = engine.open_document(input.to_str().unwrap(), None).unwrap();
    let page = plan(&document, 0);
    let ellipse = (0..64).map(|index| {
        let angle = index as f32 * std::f32::consts::TAU / 64.0;
        ImagePoint { x: 0.704 + 0.15 * angle.cos(), y: 0.29 + 0.14 * angle.sin() }
    }).collect::<Vec<_>>();
    let original_asset = engine.edit_feature(&FeatureRequest::Extract { page: page.clone(), region: ellipse.clone() }).unwrap();
    let pixel_data = |asset: &ImageAssetInfo| {
        let data = base64::engine::general_purpose::STANDARD.decode(asset.data_url.split_once(',').unwrap().1).unwrap();
        image::load_from_memory_with_format(&data, ImageFormat::Png).unwrap().into_rgba8()
    };
    let source_pixels = pixel_data(&original_asset);
    assert_eq!(source_pixels.get_pixel(0, 0).0[3], 0);
    let (w, h) = source_pixels.dimensions();
    assert_eq!(source_pixels.get_pixel(w / 2, h * 4 / 5).0, [255; 4]);
    assert_eq!(source_pixels.get_pixel(w / 2, h / 3).0, [0, 0, 255, 255]);
    let tinted = engine.edit_feature(&FeatureRequest::Tint { asset_id: original_asset.id.clone(), color: "#aa2010".into() }).unwrap();
    let tint_pixels = pixel_data(&tinted);
    assert_eq!(tint_pixels.get_pixel(w / 2, h * 4 / 5).0, [255; 4]);
    let colored = tint_pixels.get_pixel(w / 2, h / 3).0;
    assert!(colored[0] > colored[1] * 2 && colored[3] == 255);

    let generated = engine.generate_pages(&GeneratePages::CutFeature { page, region: ellipse }).unwrap();
    let clean = plan(&generated, 0);
    let cut = pixels(engine.render_page(&clean, 800).unwrap());
    assert_eq!(cut.get_pixel((cut.width() as f32 * 0.704) as u32, (cut.height() as f32 * 0.283) as u32).0, [255; 4]);
    let inspected = engine.inspect_page_content(&clean).unwrap();
    assert!(inspected.objects.iter().any(|item| item.text.as_deref() == Some("KeepText") && item.editable));

    let workspace = json!({"id":"feature","documentId":generated.id,"pageIndex":0,"rotation":0,
        "width":generated.pages[0].width,"height":generated.pages[0].height,"sourceName":"feature.pdf",
        "overlays":[{"id":"cutout","assetId":tinted.id,"featureSource":{"assetId":original_asset.id},
            "x":0.12,"y":0.10,"width":0.25,"height":0.20,"opacity":1,"rotation":90}]});
    let path = directory.path().join("portable.jvp");
    engine.save_editable_project(path.to_str().unwrap(), vec![workspace], "Feature cut").unwrap();
    let loaded = engine.load_editable_project(path.to_str().unwrap()).unwrap();
    let mut workspace = loaded["workspace"][0].clone();
    let original_id = workspace["overlays"][0]["featureSource"]["assetId"].as_str().unwrap().to_owned();
    assert_ne!(original_id, original_asset.id);
    assert_eq!(pixel_data(&engine.get_image_asset(&original_id).unwrap()), source_pixels);
    let next = engine.edit_feature(&FeatureRequest::Tint { asset_id: original_id, color: "#008844".into() }).unwrap();
    workspace["overlays"][0]["assetId"] = json!(next.id);
    workspace["overlays"][0]["x"] = json!(0.72);
    workspace["overlays"][0]["rotation"] = json!(180);
    engine.save_editable_project(path.to_str().unwrap(), vec![workspace], "Feature cut").unwrap();
    let reopened = engine.load_editable_project(path.to_str().unwrap()).unwrap();
    assert_eq!(reopened["workspace"][0]["overlays"][0]["x"], json!(0.72));
    assert_eq!(reopened["workspace"][0]["overlays"][0]["rotation"], 180);
    assert_eq!(fs::read(&input).unwrap(), original);
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
