use super::*;
use image::{Rgba, RgbaImage};

fn synthetic_pdf(pages: &[(u32, u32, u16, &str)]) -> Vec<u8> {
    let kids = (0..pages.len())
        .map(|index| format!("{} 0 R", 4 + index * 2))
        .collect::<Vec<_>>()
        .join(" ");
    let mut objects = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        format!("<< /Type /Pages /Kids [{kids}] /Count {} >>", pages.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    for (index, (width, height, turn, content)) in pages.iter().enumerate() {
        let stream = 5 + index * 2;
        objects.push(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Rotate {turn} /Resources << /Font << /F1 3 0 R >> >> /Contents {stream} 0 R >>"));
        objects.push(format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len()
        ));
    }
    let mut bytes = b"%PDF-1.7\n".to_vec();
    let mut offsets = vec![0];
    for (index, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref = bytes.len();
    bytes.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()).as_bytes());
    for offset in offsets.iter().skip(1) {
        bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            offsets.len()
        )
        .as_bytes(),
    );
    bytes
}

fn pixels(asset: &ImageAssetInfo) -> RgbaImage {
    image::load_from_memory_with_format(
        &base64::engine::general_purpose::STANDARD
            .decode(asset.data_url.split_once(',').unwrap().1)
            .unwrap(),
        ImageFormat::Png,
    )
    .unwrap()
    .into_rgba8()
}

fn render_pixels(render: &RenderedPage) -> RgbaImage {
    image::load_from_memory_with_format(
        &base64::engine::general_purpose::STANDARD
            .decode(render.data_url.split_once(',').unwrap().1)
            .unwrap(),
        ImageFormat::Png,
    )
    .unwrap()
    .into_rgba8()
}

fn color(actual: &Rgba<u8>, expected: [u8; 3]) {
    for (got, wanted) in actual.0[..3].iter().zip(expected) {
        assert!(
            got.abs_diff(wanted) <= 3,
            "actual {:?}, expected {expected:?}",
            actual.0
        );
    }
}

#[test]
fn pdf_fragments_crop_transparency_multiply_and_preserve_sources() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let pdfium = native_pdfium();
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("fragment source.pdf");
    let ink = "1 0 0 rg 40 120 80 40 re f 0 1 0 rg 280 40 80 40 re f 0 0 0 rg BT /F1 12 Tf 20 8 Td (SOURCE-TEXT) Tj ET";
    let white_content = format!("1 1 1 rg 0 0 400 200 re f {ink}");
    let source_bytes = synthetic_pdf(&[
        (400, 200, 0, &white_content),
        (400, 200, 90, ink),
        (400, 200, 0, ""),
    ]);
    fs::write(&source, &source_bytes).unwrap();
    let mut engine = PdfEngine::new(pdfium);

    let full = engine
        .import_pdf_stamp(source.to_str().unwrap(), 0, false, false, None)
        .unwrap();
    assert_eq!(full.page_count, 3);
    assert_eq!((full.image.width, full.image.height), (1600, 800));
    let full_pixels = pixels(&full.image);
    assert_eq!(full_pixels.get_pixel(0, 0).0, [255, 255, 255, 255]);
    color(full_pixels.get_pixel(250, 220), [255, 0, 0]);
    assert!(
        engine.sources.is_empty(),
        "PDF fragment imports must not consume workspace source slots"
    );

    let rect = PdfStampCrop {
        x: 0.0625,
        y: 0.125,
        width: 0.3125,
        height: 0.375,
        points: Vec::new(),
        regions: Vec::new(),
    };
    let cropped = engine
        .import_pdf_stamp(source.to_str().unwrap(), 0, false, false, Some(&rect))
        .unwrap();
    assert_eq!((cropped.image.width, cropped.image.height), (500, 300));
    assert_eq!(
        pixels(&cropped.image),
        image::imageops::crop_imm(&full_pixels, 100, 100, 500, 300).to_image()
    );
    let keyed = engine
        .import_pdf_stamp(source.to_str().unwrap(), 0, true, false, Some(&rect))
        .unwrap();
    let keyed_pixels = pixels(&keyed.image);
    assert_eq!(keyed_pixels.get_pixel(0, 0).0[3], 0);
    assert_eq!(keyed_pixels.get_pixel(100, 100).0, [255, 0, 0, 255]);
    let tight = engine
        .import_pdf_stamp(source.to_str().unwrap(), 0, true, true, Some(&rect))
        .unwrap();
    assert_eq!((tight.image.width, tight.image.height), (320, 160));
    assert!(
        pixels(&tight.image)
            .pixels()
            .all(|p| p.0 == [255, 0, 0, 255]),
        "Only the selected red rectangle should remain; other page content must be excluded"
    );
    assert_eq!(
        engine
            .import_pdf_stamp(source.to_str().unwrap(), 0, true, true, Some(&rect))
            .unwrap()
            .image
            .id,
        tight.image.id
    );

    let rotated = engine
        .import_pdf_stamp(source.to_str().unwrap(), 1, false, false, None)
        .unwrap();
    assert_eq!((rotated.image.width, rotated.image.height), (800, 1600));
    let rotated_pixels = pixels(&rotated.image);
    assert_eq!(
        rotated_pixels.get_pixel(0, 0).0[3],
        0,
        "Transparent PDF paper must remain transparent without white removal"
    );
    let rotated_rect = PdfStampCrop {
        x: 0.5,
        y: 0.0625,
        width: 0.375,
        height: 0.3125,
        points: Vec::new(),
        regions: Vec::new(),
    };
    let rotated_crop = engine
        .import_pdf_stamp(
            source.to_str().unwrap(),
            1,
            false,
            false,
            Some(&rotated_rect),
        )
        .unwrap();
    assert_eq!(
        pixels(&rotated_crop.image),
        image::imageops::crop_imm(&rotated_pixels, 400, 100, 300, 500).to_image()
    );
    let rotated_tight = engine
        .import_pdf_stamp(
            source.to_str().unwrap(),
            1,
            false,
            true,
            Some(&rotated_rect),
        )
        .unwrap();
    assert_eq!(
        (rotated_tight.image.width, rotated_tight.image.height),
        (160, 320)
    );
    assert!(pixels(&rotated_tight.image)
        .pixels()
        .all(|p| p.0 == [255, 0, 0, 255]));
    let blank = engine
        .import_pdf_stamp(source.to_str().unwrap(), 2, false, true, None)
        .unwrap();
    assert_eq!(blank.page_count, 3);
    assert_eq!((blank.image.width, blank.image.height), (1, 1));
    assert_eq!(pixels(&blank.image).get_pixel(0, 0).0[3], 0);
    assert!(engine
        .import_pdf_stamp(source.to_str().unwrap(), 3, false, false, None)
        .is_err());
    for rect in [
        PdfStampCrop {
            x: 0.9,
            y: 0.0,
            width: 0.2,
            height: 1.0,
            points: Vec::new(),
            regions: Vec::new(),
        },
        PdfStampCrop {
            x: f32::NAN,
            y: 0.0,
            width: 1.0,
            height: 1.0,
            points: Vec::new(),
            regions: Vec::new(),
        },
        PdfStampCrop {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 1.0,
            points: Vec::new(),
            regions: Vec::new(),
        },
    ] {
        assert!(engine
            .import_pdf_stamp(source.to_str().unwrap(), 0, false, false, Some(&rect))
            .is_err());
    }
    let invalid_pdf = directory.path().join("invalid.pdf");
    fs::write(&invalid_pdf, b"not a pdf").unwrap();
    assert!(engine
        .import_pdf_stamp(invalid_pdf.to_str().unwrap(), 0, false, false, None)
        .is_err());
    let response = engine.dispatch(&WorkerRequest { id: 1, command: "import_pdf_stamp".into(), args: json!({"path":source,"pageIndex":0,"removeWhiteBackground":false,"trimTransparentMargins":false}) }).unwrap();
    assert_eq!(response["id"], full.image.id);
    assert_eq!(response["pageCount"], 3);
    assert!(
        response.get("image").is_none(),
        "Image asset response fields must remain flattened"
    );

    let base_path = directory.path().join("destination source.pdf");
    fs::write(&base_path, synthetic_pdf(&[(100,100,0,"0.50196 0.784314 0.62745 rg 0 0 100 100 re f 0 0 0 rg BT /F1 5 Tf 4 4 Td (BASE-TEXT) Tj ET")])).unwrap();
    let base = engine
        .open_document(base_path.to_str().unwrap(), None)
        .unwrap();
    let mut reference = PageRef {
        decorations: vec![],
        content_edits: Vec::new(),
        document_id: base.id,
        page_index: 0,
        rotation: 0,
        overlays: vec![PageOverlay {
            id: "fragment".into(),
            asset_id: full.image.id,
            x: 0.1,
            y: 0.1,
            width: 0.8,
            height: 0.4,
            opacity: 1.0,
            rotation: 0,
            blend_mode: OverlayBlendMode::Normal,
        }],
    };
    let normal = render_pixels(&engine.render_page(&reference, 400).unwrap());
    color(normal.get_pixel(48, 48), [255, 255, 255]);
    color(normal.get_pixel(100, 88), [255, 0, 0]);
    color(normal.get_pixel(296, 152), [0, 255, 0]);
    reference.overlays[0].blend_mode = OverlayBlendMode::Multiply;
    let multiplied = engine.render_page(&reference, 400).unwrap();
    let multiplied_pixels = render_pixels(&multiplied);
    color(multiplied_pixels.get_pixel(48, 48), [128, 200, 160]);
    color(multiplied_pixels.get_pixel(100, 88), [128, 0, 0]);
    color(multiplied_pixels.get_pixel(296, 152), [0, 200, 0]);
    reference.overlays[0].opacity = 0.5;
    let faded = render_pixels(&engine.render_page(&reference, 400).unwrap());
    color(faded.get_pixel(48, 48), [128, 200, 160]);
    color(faded.get_pixel(100, 88), [128, 100, 80]);
    color(faded.get_pixel(296, 152), [64, 200, 80]);
    reference.overlays[0].opacity = 1.0;
    let saved = directory.path().join("multiplied.pdf");
    engine
        .save_document(saved.to_str().unwrap(), &[reference.clone()])
        .unwrap();
    let reopened = engine.open_document(saved.to_str().unwrap(), None).unwrap();
    let reopened_render = engine
        .render_page(
            &PageRef {
                decorations: vec![],
                content_edits: Vec::new(),
                document_id: reopened.id.clone(),
                page_index: 0,
                rotation: 0,
                overlays: vec![],
            },
            400,
        )
        .unwrap();
    assert_eq!(
        multiplied.data_url, reopened_render.data_url,
        "Multiply must survive saving and reopening with identical pixels"
    );
    assert_eq!(
        engine
            .search_document(&reopened.id, "BASE-TEXT")
            .unwrap()
            .len(),
        1
    );
    assert!(
        engine
            .save_document(source.to_str().unwrap(), &[reference.clone()])
            .unwrap_err()
            .contains("保护来源文件"),
        "The imported fragment PDF is protected even though it was never a workspace source"
    );
    let source_alias = directory.path().join("fragment-alias.pdf");
    fs::hard_link(&source, &source_alias).unwrap();
    assert!(engine
        .save_document(source_alias.to_str().unwrap(), &[reference])
        .unwrap_err()
        .contains("保护来源文件"));
    let image_alias = directory.path().join("fragment-alias.png");
    fs::hard_link(&source, &image_alias).unwrap();
    assert!(engine
        .export_image(&tight.image.id, image_alias.to_str().unwrap())
        .unwrap_err()
        .contains("保护来源文件"));
    assert_eq!(fs::read(&source).unwrap(), source_bytes);
    assert!(serde_json::from_value::<PageOverlay>(json!({"id":"o","assetId":"a","x":0,"y":0,"width":1,"height":1,"opacity":1,"blendMode":"screen"})).is_err());
    let old: PageOverlay = serde_json::from_value(
        json!({"id":"o","assetId":"a","x":0,"y":0,"width":1,"height":1,"opacity":1}),
    )
    .unwrap();
    assert_eq!(old.blend_mode, OverlayBlendMode::Normal);
}
