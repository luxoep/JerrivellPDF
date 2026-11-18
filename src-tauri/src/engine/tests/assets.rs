use super::*;
use image::{Rgba, RgbaImage};

fn data_url(image: &DynamicImage) -> String {
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, ImageFormat::Png).unwrap();
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    )
}

fn decode_render(render: &RenderedPage) -> RgbaImage {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(render.data_url.split_once(',').unwrap().1)
        .unwrap();
    image::load_from_memory_with_format(&bytes, ImageFormat::Png)
        .unwrap()
        .into_rgba8()
}

fn assert_color(actual: &Rgba<u8>, expected: [u8; 3], context: &str) {
    for channel in 0..3 {
        assert!(
            actual.0[channel].abs_diff(expected[channel]) <= 3,
            "{context}: expected {expected:?}, actual {:?}",
            actual.0
        );
    }
}

#[test]
fn overlays_preserve_alpha_direction_crop_and_original_content() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let pdfium = native_pdfium();
    let directory = tempfile::tempdir().unwrap();
    let flat_path = directory.path().join("plain.pdf");
    let rotated_path = directory.path().join("native-rotated.pdf");
    let cropped_path = directory.path().join("offset-crop.pdf");
    let flat_bytes = fixture("Original searchable text", 400, 300, 0);
    let rotated_bytes = fixture("Original rotated text", 240, 360, 90);
    let cropped_bytes = fixture_with_crop(
        "Original crop text",
        400,
        300,
        270,
        Some([40, 30, 360, 270]),
    );
    fs::write(&flat_path, &flat_bytes).unwrap();
    fs::write(&rotated_path, &rotated_bytes).unwrap();
    fs::write(&cropped_path, &cropped_bytes).unwrap();
    let mut engine = PdfEngine::new(pdfium);
    let flat = engine
        .open_document(flat_path.to_str().unwrap(), None)
        .unwrap();
    let rotated = engine
        .open_document(rotated_path.to_str().unwrap(), None)
        .unwrap();
    let cropped = engine
        .open_document(cropped_path.to_str().unwrap(), None)
        .unwrap();

    // Four distinct quadrants make image orientation, intrinsic alpha, and overlay
    // opacity independently observable after saving. The fourth quadrant is transparent.
    let mut pixels = RgbaImage::new(40, 20);
    for (x, y, pixel) in pixels.enumerate_pixels_mut() {
        *pixel = match (x < 20, y < 10) {
            (true, true) => Rgba([255, 0, 0, 255]),
            (false, true) => Rgba([0, 255, 0, 255]),
            (true, false) => Rgba([0, 0, 255, 128]),
            (false, false) => Rgba([0, 0, 0, 0]),
        };
    }
    let image = DynamicImage::ImageRgba8(pixels);
    let image_url = data_url(&image);
    let registered = engine.register_image(&image_url).unwrap();
    assert_eq!((registered.width, registered.height), (40, 20));
    assert_eq!(engine.register_image(&image_url).unwrap().id, registered.id);
    let source_image_path = directory.path().join("source image.png");
    image
        .save_with_format(&source_image_path, ImageFormat::Png)
        .unwrap();
    let original_image_bytes = fs::read(&source_image_path).unwrap();
    assert_eq!(
        engine
            .import_image(source_image_path.to_str().unwrap())
            .unwrap()
            .id,
        registered.id
    );
    assert_eq!(
        engine.assets.len(),
        1,
        "importing the same PNG must not consume an asset slot"
    );
    let image_export = directory.path().join("exported stamp.png");
    engine
        .export_image(&registered.id, image_export.to_str().unwrap())
        .unwrap();
    let exported_image = image::open(&image_export).unwrap().into_rgba8();
    assert_eq!(exported_image.get_pixel(30, 15).0[3], 0);
    assert_eq!(exported_image.get_pixel(10, 15).0[3], 128);
    assert!(engine
        .export_image(&registered.id, source_image_path.to_str().unwrap())
        .is_err());
    let image_alias = directory.path().join("source-alias.png");
    fs::hard_link(&source_image_path, &image_alias).unwrap();
    assert!(engine
        .export_image(&registered.id, image_alias.to_str().unwrap())
        .is_err());
    assert_eq!(fs::read(&source_image_path).unwrap(), original_image_bytes);

    let base_overlay = PageOverlay {
        id: "stamp-1".into(),
        asset_id: registered.id.clone(),
        x: 0.125,
        y: 0.125,
        width: 0.5,
        height: 0.5,
        opacity: 0.5,
        rotation: 0,
        blend_mode: OverlayBlendMode::Normal,
    };
    let mut plan = Vec::new();
    for turn in [0, 90, 180, 270] {
        plan.push(PageRef {
            content_edits: Vec::new(),
            document_id: flat.id.clone(),
            page_index: 0,
            rotation: turn,
            overlays: vec![base_overlay.clone()],
        });
    }
    plan.push(PageRef {
        content_edits: Vec::new(),
        document_id: rotated.id.clone(),
        page_index: 0,
        rotation: 90,
        overlays: vec![base_overlay.clone()],
    });
    plan.push(PageRef {
        content_edits: Vec::new(),
        document_id: cropped.id.clone(),
        page_index: 0,
        rotation: 180,
        overlays: vec![base_overlay.clone()],
    });
    // Mirror the frontend's clockwise page rotation of an already placed layer.
    let mut turned = base_overlay.clone();
    turned.x = 1.0 - base_overlay.y - base_overlay.height;
    turned.y = base_overlay.x;
    turned.width = base_overlay.height;
    turned.height = base_overlay.width;
    turned.rotation = 90;
    plan.push(PageRef {
        content_edits: Vec::new(),
        document_id: flat.id.clone(),
        page_index: 0,
        rotation: 90,
        overlays: vec![turned],
    });

    let saved_path = directory.path().join("layers.pdf");
    engine
        .save_document(saved_path.to_str().unwrap(), &plan)
        .unwrap();
    let reopened = engine
        .open_document(saved_path.to_str().unwrap(), None)
        .unwrap();
    assert_eq!(reopened.page_count, plan.len() as u32);
    assert!(
        !engine
            .search_document(&reopened.id, "Original")
            .unwrap()
            .is_empty(),
        "original vector text must remain searchable"
    );
    for (index, reference) in plan.iter().enumerate() {
        let preview = engine.render_page(reference, 400).unwrap();
        let saved = engine
            .render_page(
                &PageRef {
                    content_edits: Vec::new(),
                    document_id: reopened.id.clone(),
                    page_index: index as u32,
                    rotation: 0,
                    overlays: vec![],
                },
                400,
            )
            .unwrap();
        assert_eq!((preview.width, preview.height), (saved.width, saved.height));
        assert!(
            preview.data_url == saved.data_url,
            "overlay preview must match saved/reopened page {index}"
        );
        let bitmap = decode_render(&saved);
        let overlay = &reference.overlays[0];
        let sample = |u: f32, v: f32| {
            bitmap.get_pixel(
                ((overlay.x + overlay.width * u) * bitmap.width() as f32) as u32,
                ((overlay.y + overlay.height * v) * bitmap.height() as f32) as u32,
            )
        };
        let expected = if overlay.rotation == 0 {
            [
                [255, 127, 127],
                [127, 255, 127],
                [191, 191, 255],
                [255, 255, 255],
            ]
        } else {
            [
                [191, 191, 255],
                [255, 127, 127],
                [255, 255, 255],
                [127, 255, 127],
            ]
        };
        for ((u, v), color) in [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)]
            .into_iter()
            .zip(expected)
        {
            assert_color(sample(u, v), color, &format!("page {index}, point {u}/{v}"));
        }
    }
    assert_eq!(fs::read(&flat_path).unwrap(), flat_bytes);
    assert_eq!(fs::read(&rotated_path).unwrap(), rotated_bytes);
    assert_eq!(fs::read(&cropped_path).unwrap(), cropped_bytes);
    assert_eq!(
        engine.sources[&flat.id]
            .document
            .pages()
            .get(0)
            .unwrap()
            .rotation()
            .unwrap()
            .as_degrees(),
        0.0
    );

    let mut invalid = plan[0].clone();
    invalid.overlays[0].asset_id = "missing".into();
    let protected = directory.path().join("protected.pdf");
    fs::write(&protected, b"existing file").unwrap();
    assert!(engine
        .save_document(protected.to_str().unwrap(), &[invalid.clone()])
        .unwrap_err()
        .starts_with("ASSET_INVALID:"));
    assert_eq!(fs::read(&protected).unwrap(), b"existing file");
    invalid.overlays[0] = base_overlay.clone();
    invalid.overlays[0].x = f32::NAN;
    assert!(engine.render_page(&invalid, 400).is_err());
    invalid.overlays[0] = base_overlay.clone();
    invalid.overlays[0].opacity = 1.1;
    assert!(engine.render_page(&invalid, 400).is_err());
    invalid.overlays[0] = base_overlay.clone();
    invalid.overlays[0].rotation = 45;
    assert!(engine.render_page(&invalid, 400).is_err());
    invalid.overlays[0] = base_overlay.clone();
    invalid.overlays[0].x = 0.9;
    assert!(engine.render_page(&invalid, 400).is_err());

    assert!(engine
        .register_image("https://example.invalid/image.png")
        .unwrap_err()
        .starts_with("ASSET_INVALID:"));
    assert!(engine
        .register_image("data:image/svg+xml;base64,AA==")
        .is_err());
    assert!(engine
        .register_image(&"x".repeat(1_500_001))
        .unwrap_err()
        .contains("缩小"));
    let too_wide = DynamicImage::ImageRgba8(RgbaImage::new(8193, 1));
    assert!(engine
        .register_image(&data_url(&too_wide))
        .unwrap_err()
        .contains("尺寸"));
    let invalid_image = directory.path().join("fake.png");
    fs::write(&invalid_image, b"not an image").unwrap();
    assert!(engine
        .import_image(invalid_image.to_str().unwrap())
        .is_err());

    let jpeg_path = directory.path().join("photo.jpg");
    image
        .to_rgb8()
        .save_with_format(&jpeg_path, ImageFormat::Jpeg)
        .unwrap();
    let jpeg = engine.import_image(jpeg_path.to_str().unwrap()).unwrap();
    assert_eq!((jpeg.width, jpeg.height), (40, 20));
    assert!(jpeg.data_url.starts_with("data:image/png;base64,"));
    let jpeg_bytes = fs::read(&jpeg_path).unwrap();
    let exif = b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
    let mut oriented_jpeg = jpeg_bytes[..2].to_vec();
    oriented_jpeg.extend_from_slice(&[0xff, 0xe1]);
    oriented_jpeg.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
    oriented_jpeg.extend_from_slice(exif);
    oriented_jpeg.extend_from_slice(&jpeg_bytes[2..]);
    let oriented_path = directory.path().join("exif-rotated-photo.jpg");
    fs::write(&oriented_path, oriented_jpeg).unwrap();
    let oriented = engine
        .import_image(oriented_path.to_str().unwrap())
        .unwrap();
    assert_eq!(
        (oriented.width, oriented.height),
        (20, 40),
        "JPEG EXIF direction must be baked into the imported PNG"
    );
    engine
        .dispatch(&WorkerRequest {
            id: 1,
            command: "close_all_documents".into(),
            args: Value::Null,
        })
        .unwrap();
    assert!(engine.assets.is_empty());
    assert!(engine
        .export_image(&registered.id, image_export.to_str().unwrap())
        .is_err());
    let mut first_small = None;
    for value in 0..64_u8 {
        let small = DynamicImage::ImageRgba8(RgbaImage::from_pixel(1, 1, Rgba([value, 0, 0, 255])));
        let item = engine.register_image(&data_url(&small)).unwrap();
        if first_small.is_none() {
            first_small = Some(item.id);
        }
    }
    assert_eq!(engine.assets.len(), 64);
    let duplicate = DynamicImage::ImageRgba8(RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 255])));
    assert_eq!(
        engine.register_image(&data_url(&duplicate)).unwrap().id,
        first_small.unwrap(),
        "duplicates remain usable at capacity"
    );
    let next_unique = DynamicImage::ImageRgba8(RgbaImage::from_pixel(1, 1, Rgba([0, 1, 0, 255])));
    assert!(engine
        .register_image(&data_url(&next_unique))
        .unwrap_err()
        .contains("64"));
}

#[test]
fn page_references_without_layers_remain_compatible() {
    let page: PageRef =
        serde_json::from_value(json!({"documentId":"one","pageIndex":0,"rotation":90})).unwrap();
    assert!(page.overlays.is_empty());
    let overlay: PageOverlay = serde_json::from_value(json!({"id":"layer","assetId":"asset","x":0.1,"y":0.2,"width":0.3,"height":0.4,"opacity":1.0})).unwrap();
    assert_eq!(overlay.rotation, 0);
}
