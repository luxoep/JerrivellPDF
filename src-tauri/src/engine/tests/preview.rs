// SPDX-License-Identifier: MIT OR Apache-2.0
use super::*;

fn rendered(image: &RenderedPage) -> image::RgbaImage {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image.data_url.split_once(',').unwrap().1)
        .unwrap();
    image::load_from_memory_with_format(&bytes, ImageFormat::Png)
        .unwrap()
        .to_rgba8()
}

fn over(bottom: &mut image::RgbaImage, top: &image::RgbaImage, multiply: bool) {
    assert_eq!(bottom.dimensions(), top.dimensions());
    for (dst, src) in bottom.pixels_mut().zip(top.pixels()) {
        let alpha = src.0[3] as f32 / 255.0;
        for channel in 0..3 {
            dst.0[channel] = ((if multiply {
                src.0[channel] as f32 * dst.0[channel] as f32 / 255.0
            } else {
                src.0[channel] as f32
            }) * alpha
                + dst.0[channel] as f32 * (1.0 - alpha))
                .round() as u8;
        }
    }
}

#[test]
fn native_reader_layers_preserve_transparency_order_rotation_and_crop() {
    let _serial = NATIVE_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let pdfium = native_pdfium();
    let mut engine = PdfEngine::new(pdfium);
    let source_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/sample.pdf");
    let original = fs::read(&source_path).unwrap();
    let document = engine
        .open_document(source_path.to_str().unwrap(), None)
        .unwrap();
    for index in 0..document.page_count {
        let plan = PageRef {
            document_id: document.id.clone(),
            page_index: index,
            rotation: 0,
            overlays: vec![],
            content_edits: vec![],
            decorations: vec![],
        };
        let layers = engine.render_page_layers(&plan, 600).unwrap();
        let mut composite = rendered(&layers.background);
        for layer in &layers.foreground {
            over(
                &mut composite,
                &rendered(&layer.image),
                matches!(layer.blend_mode, OverlayBlendMode::Multiply),
            );
        }
        let full = rendered(&engine.render_page(&plan, 600).unwrap());
        let error: u64 = composite
            .pixels()
            .zip(full.pixels())
            .map(|(a, b)| {
                (0..3)
                    .map(|channel| {
                        (a.0[channel] as i32 - b.0[channel] as i32).unsigned_abs() as u64
                    })
                    .sum::<u64>()
            })
            .sum();
        assert!(
            (error as f64 / (full.width() * full.height() * 3) as f64) < 0.5,
            "source page {index}: average error {error}"
        );
        if index == 0 {
            let foreground = rendered(
                &layers
                    .foreground
                    .first()
                    .expect("Source annotations must have their own foreground")
                    .image,
            );
            assert!(
                foreground
                    .enumerate_pixels()
                    .filter(|(_, y, _)| *y < foreground.height() / 5)
                    .all(|(_, _, pixel)| pixel.0[3] == 0),
                "Foreground must not retain or duplicate the original heading"
            );
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let cropped = temp.path().join("crop.pdf");
    fs::write(
        &cropped,
        fixture_with_crop("Layers", 400, 300, 90, Some([20, 30, 380, 270])),
    )
    .unwrap();
    let source = engine
        .open_document(cropped.to_str().unwrap(), None)
        .unwrap();
    for turn in [0, 90, 180, 270] {
        let mut plan = PageRef {
            document_id: source.id.clone(),
            page_index: 0,
            rotation: turn,
            overlays: vec![],
            content_edits: vec![],
            decorations: vec![],
        };
        let empty = engine.render_page_layers(&plan, 500).unwrap();
        assert!(empty.foreground.is_empty());
        plan.decorations = vec![PageDecoration {
            id: "above".into(),
            kind: "watermark".into(),
            text: "TOP".into(),
            font_family: None,
            font_size: 30.0,
            color: "#DA2244".into(),
            opacity: 0.35,
            angle: -25.0,
            x: 0.5,
            y: 0.5,
            alignment: "center".into(),
        }];
        let layers = engine.render_page_layers(&plan, 500).unwrap();
        let foreground = rendered(&layers.foreground[0].image);
        assert_eq!(
            foreground.get_pixel(0, 0).0[3],
            0,
            "Foreground must not erase the PDF or marks with white pixels"
        );
        assert!(foreground
            .pixels()
            .any(|pixel| pixel.0[3] > 0 && pixel.0[3] < 255));
        let mut composite = rendered(&layers.background);
        over(&mut composite, &foreground, false);
        let full = rendered(&engine.render_page(&plan, 500).unwrap());
        let error: u64 = composite
            .pixels()
            .zip(full.pixels())
            .map(|(a, b)| {
                (0..3)
                    .map(|channel| {
                        (a.0[channel] as i32 - b.0[channel] as i32).unsigned_abs() as u64
                    })
                    .sum::<u64>()
            })
            .sum();
        assert!(
            (error as f64 / (full.width() * full.height() * 3) as f64) < 0.5,
            "turn {turn} error {error}"
        );
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            8,
            8,
            image::Rgba([255, 200, 0, 200]),
        ))
        .write_to(&mut png, ImageFormat::Png)
        .unwrap();
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png.into_inner())
        );
        let asset = engine.register_image(&data_url).unwrap();
        plan.overlays=vec![serde_json::from_value(json!({"id":"mark","assetId":asset.id,"x":0.1,"y":0.1,"width":0.2,"height":0.2,"opacity":1,"rotation":90})).unwrap()];
        assert!(
            engine.render_page_layers(&plan, 500).is_err(),
            "Native base must not silently bake added marks twice"
        );
        assert!(
            engine.render_page(&plan, 500).is_ok(),
            "Export preview keeps the complete native renderer"
        );
    }
    assert_eq!(fs::read(source_path).unwrap(), original);
}

#[test]
fn original_highlight_does_not_hide_black_text_in_reader_layers() {
    let _serial = NATIVE_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let pdfium = native_pdfium();
    let mut engine = PdfEngine::new(pdfium);
    let mut document = lopdf::Document::load_mem(&fixture("HIGHLIGHT TEXT", 300, 150, 0)).unwrap();
    let form = lopdf::Stream::new(
        lopdf::dictionary! {
            "Type"=>"XObject", "Subtype"=>"Form", "BBox"=>vec![0.into(),0.into(),230.into(),28.into()],
            "Resources"=>lopdf::dictionary!{"ExtGState"=>lopdf::dictionary!{"GS"=>lopdf::dictionary!{"BM"=>"Multiply","ca"=>1}}}
        },
        b"q /GS gs 1 1 0 rg 0 0 230 28 re f Q".to_vec(),
    );
    let appearance = document.add_object(form);
    let annotation=document.add_object(lopdf::dictionary!{
        "Type"=>"Annot","Subtype"=>"Highlight","Rect"=>vec![20.into(),42.into(),250.into(),70.into()],
        "QuadPoints"=>vec![20.into(),70.into(),250.into(),70.into(),20.into(),42.into(),250.into(),42.into()],
        "C"=>vec![1.into(),1.into(),0.into()],"F"=>4,"AP"=>lopdf::dictionary!{"N"=>appearance}
    });
    document
        .get_dictionary_mut((3, 0))
        .unwrap()
        .set("Annots", vec![lopdf::Object::Reference(annotation)]);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let source = engine.add_generated_source(bytes, "highlight.pdf").unwrap();
    let plan = PageRef {
        document_id: source.id.clone(),
        page_index: 0,
        rotation: 0,
        overlays: vec![],
        content_edits: vec![],
        decorations: vec![],
    };
    let layers = engine.render_page_layers(&plan, 600).unwrap();
    let mut composite = rendered(&layers.background);
    for layer in &layers.foreground {
        over(
            &mut composite,
            &rendered(&layer.image),
            matches!(layer.blend_mode, OverlayBlendMode::Multiply),
        );
    }
    let full = rendered(&engine.render_page(&plan, 600).unwrap());
    assert!(
        full.pixels()
            .filter(|pixel| pixel.0[0] > 200 && pixel.0[1] > 200 && pixel.0[2] < 80)
            .count()
            > 100,
        "Fixture must contain a visible yellow highlight"
    );
    let mut black = 0;
    let mut retained = 0;
    for (a, b) in composite.pixels().zip(full.pixels()) {
        if b.0[..3].iter().all(|v| *v < 40) {
            black += 1;
            if a.0[..3].iter().all(|v| *v < 50) {
                retained += 1;
            }
        }
    }
    assert!(black > 200);
    assert!(
        retained as f32 / black as f32 > 0.95,
        "Existing highlight must retain text: {retained}/{black}"
    );
}

#[test]
fn native_high_dpi_rasters_preserve_requested_pixels_for_tall_wide_and_rotated_pages() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut engine = PdfEngine::new(native_pdfium());
    // Portrait rendering crosses the former 16M-pixel limit; landscape and the
    // intrinsic rotation cross the former 4096px request-width limit.
    for (width, height, rotation, target, expected) in [
        (400, 600, 0, 3600, (3600, 5400)),
        (600, 400, 0, 4800, (4800, 3200)),
        (400, 600, 90, 4800, (4800, 3200)),
    ] {
        let source = engine.add_generated_source(fixture("NATIVE HIGH DPI", width, height, rotation), "high-dpi.pdf").unwrap();
        let plan = PageRef { document_id: source.id, page_index: 0, rotation: 0,
            overlays: vec![], content_edits: vec![], decorations: vec![] };
        let layers = engine.render_page_layers(&plan, target).unwrap();
        assert_eq!((layers.background.width, layers.background.height), expected);
        let pixels = rendered(&layers.background);
        assert_eq!(pixels.dimensions(), expected);
        assert!(pixels.pixels().any(|pixel| pixel.0[..3].iter().all(|channel| *channel < 100)),
            "High-DPI output must contain the original vector text, not an empty placeholder");
    }
}

#[test]
fn higher_native_resolution_rasterizes_vector_detail_instead_of_upscaling_old_preview() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut document = lopdf::Document::load_mem(&fixture("NATIVE 012345", 300, 150, 0)).unwrap();
    let mut content = String::from("BT /F1 18 Tf 24 48 Td (NATIVE 012345) Tj ET\nq 0 g\n");
    for index in 0..80 {
        let x = 40.0 + index as f64 * 0.25;
        content.push_str(&format!("{x:.3} 90 0.125 30 re f\n"));
    }
    content.push_str("Q\n");
    document.objects.insert((5, 0), lopdf::Object::Stream(lopdf::Stream::new(lopdf::dictionary!{}, content.into_bytes())));
    let mut bytes = Vec::new(); document.save_to(&mut bytes).unwrap();
    let mut engine = PdfEngine::new(native_pdfium());
    let source = engine.add_generated_source(bytes, "vector-detail.pdf").unwrap();
    let plan = PageRef { document_id: source.id, page_index: 0, rotation: 0,
        overlays: vec![], content_edits: vec![], decorations: vec![] };
    let lower = rendered(&engine.render_page_layers(&plan, 2400).unwrap().background);
    let higher = rendered(&engine.render_page_layers(&plan, 4800).unwrap().background);
    assert_eq!(higher.dimensions(), (4800, 2400));
    assert!(higher.pixels().any(|pixel| pixel.0[..3].iter().all(|channel| *channel < 100)));
    let upscaled = image::imageops::resize(&lower, higher.width(), higher.height(), image::imageops::FilterType::Triangle);
    let resolved = higher.pixels().zip(upscaled.pixels()).filter(|(a,b)| {
        (0..3).any(|channel| (i16::from(a.0[channel])-i16::from(b.0[channel])).unsigned_abs() >= 16)
    }).count();
    assert!(resolved > 250, "New vector pixels must differ visibly from stretching the old 2400px bitmap: {resolved} pixels");
}
