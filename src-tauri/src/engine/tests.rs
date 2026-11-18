use super::*;
mod content;

static NATIVE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static NATIVE_PDFIUM: std::sync::OnceLock<Pdfium> = std::sync::OnceLock::new();

fn native_pdfium() -> &'static Pdfium {
    NATIVE_PDFIUM.get_or_init(|| {
        let library =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/pdfium/bin/pdfium.dll");
        assert!(
            library.is_file(),
            "PDFium test resource missing: {}",
            library.display()
        );
        Pdfium::new(Pdfium::bind_to_library(library.canonicalize().unwrap()).unwrap())
    })
}

fn fixture(label: &str, width: u32, height: u32, rotation: u16) -> Vec<u8> {
    fixture_with_crop(label, width, height, rotation, None)
}

fn fixture_with_crop(
    label: &str,
    width: u32,
    height: u32,
    rotation: u16,
    crop: Option<[i32; 4]>,
) -> Vec<u8> {
    let content = format!("BT /F1 18 Tf 24 48 Td ({label}) Tj ET");
    let crop = crop
        .map(|v| format!(" /CropBox [{} {} {} {}]", v[0], v[1], v[2], v[3]))
        .unwrap_or_default();
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Rotate {rotation}{crop} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
    ];
    let mut data = b"%PDF-1.7\n".to_vec();
    let mut offsets = vec![0];
    for (index, object) in objects.iter().enumerate() {
        offsets.push(data.len());
        data.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
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

#[test]
fn native_round_trip_merge_rotation_and_failure_protection() {
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let pdfium = native_pdfium();
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first.pdf");
    let second = directory.path().join("second.pdf");
    let first_bytes = fixture("Hello Alpha", 240, 360, 0);
    let second_bytes = fixture("Hello Beta", 400, 200, 90);
    fs::write(&first, &first_bytes).unwrap();
    fs::write(&second, &second_bytes).unwrap();
    let mut engine = PdfEngine::new(pdfium);
    let one = engine.open_document(first.to_str().unwrap(), None).unwrap();
    let two = engine
        .open_document(second.to_str().unwrap(), None)
        .unwrap();
    assert_eq!(one.page_count, 1);
    assert_eq!(two.pages[0].rotation, 90);
    let plan = vec![
        PageRef {
            content_edits: Vec::new(),
            document_id: two.id.clone(),
            page_index: 0,
            rotation: 90,
            overlays: vec![],
        },
        PageRef {
            content_edits: Vec::new(),
            document_id: one.id.clone(),
            page_index: 0,
            rotation: 270,
            overlays: vec![],
        },
        PageRef {
            content_edits: Vec::new(),
            document_id: one.id.clone(),
            page_index: 0,
            rotation: 0,
            overlays: vec![],
        },
    ];
    let destination = directory.path().join("merged.pdf");
    let result = engine
        .save_document(destination.to_str().unwrap(), &plan)
        .unwrap();
    assert_eq!(result.page_count, 3);
    let merged = engine
        .open_document(destination.to_str().unwrap(), None)
        .unwrap();
    assert_eq!(merged.page_count, 3);
    assert_eq!(
        merged.pages.iter().map(|p| p.rotation).collect::<Vec<_>>(),
        vec![180, 270, 0]
    );
    let beta = engine.search_document(&merged.id, "bEtA").unwrap();
    assert_eq!(beta.len(), 1);
    assert_eq!(beta[0].page_index, 0);
    let alpha = engine.search_document(&merged.id, "Alpha").unwrap();
    assert_eq!(
        alpha.iter().map(|hit| hit.page_index).collect::<Vec<_>>(),
        vec![1, 2]
    );
    for (index, planned_page) in plan.iter().enumerate() {
        let planned = engine.render_page(planned_page, 360).unwrap();
        let saved = engine
            .render_page(
                &PageRef {
                    content_edits: Vec::new(),
                    document_id: merged.id.clone(),
                    page_index: index as u32,
                    rotation: 0,
                    overlays: vec![],
                },
                360,
            )
            .unwrap();
        assert!(
            planned.data_url == saved.data_url,
            "native rotation should render identically after saving page {index}"
        );
    }
    assert_eq!(
        engine.sources[&one.id]
            .document
            .pages()
            .get(0)
            .unwrap()
            .rotation()
            .unwrap()
            .as_degrees(),
        0.0
    );
    assert_eq!(
        engine.sources[&two.id]
            .document
            .pages()
            .get(0)
            .unwrap()
            .rotation()
            .unwrap()
            .as_degrees(),
        90.0
    );

    // Additional rotation must agree between preview, PNG export and saved PDF.
    let preview = engine.render_page(&plan[1], 360).unwrap();
    assert_eq!((preview.width, preview.height), (360, 240));
    let reopened_preview = engine
        .render_page(
            &PageRef {
                content_edits: Vec::new(),
                document_id: merged.id.clone(),
                page_index: 1,
                rotation: 0,
                overlays: vec![],
            },
            360,
        )
        .unwrap();
    assert_eq!(
        (reopened_preview.width, reopened_preview.height),
        (360, 240)
    );
    let png = directory.path().join("page.png");
    engine
        .export_page(&plan[1], 360, png.to_str().unwrap())
        .unwrap();
    let exported = image::open(&png).unwrap();
    assert_eq!((exported.width(), exported.height()), (360, 240));

    // Neither source paths nor hardlink aliases may be used as destinations.
    assert!(engine
        .save_document(first.to_str().unwrap(), &plan)
        .unwrap_err()
        .contains("保护原文件"));
    let alias = directory.path().join("source-alias.pdf");
    fs::hard_link(&first, &alias).unwrap();
    assert!(engine
        .save_document(alias.to_str().unwrap(), &plan)
        .unwrap_err()
        .contains("保护原文件"));
    assert_eq!(fs::read(&first).unwrap(), first_bytes);
    assert_eq!(fs::read(&second).unwrap(), second_bytes);

    // Invalid plans leave even a pre-existing non-PDF destination byte-for-byte intact.
    let protected = directory.path().join("existing.pdf");
    fs::write(&protected, b"existing destination stays intact").unwrap();
    let bad_page = PageRef {
        content_edits: Vec::new(),
        document_id: one.id.clone(),
        page_index: 99,
        rotation: 0,
        overlays: vec![],
    };
    assert!(engine
        .save_document(protected.to_str().unwrap(), &[bad_page])
        .is_err());
    assert_eq!(
        fs::read(&protected).unwrap(),
        b"existing destination stays intact"
    );
    let bad_rotation = PageRef {
        content_edits: Vec::new(),
        document_id: one.id.clone(),
        page_index: 0,
        rotation: 45,
        overlays: vec![],
    };
    assert!(engine.render_page(&bad_rotation, 100).is_err());
    assert!(engine.render_page(&plan[0], 0).is_err());
    assert!(engine.render_page(&plan[0], 4097).is_err());

    // The engine reads an immutable snapshot, even if another program changes the source.
    fs::write(&first, b"changed externally").unwrap();
    assert_eq!(engine.search_document(&one.id, "Alpha").unwrap().len(), 1);
    let reset = WorkerRequest {
        id: 1,
        command: "close_all_documents".into(),
        args: Value::Null,
    };
    engine.dispatch(&reset).unwrap();
    assert!(engine
        .render_page(&plan[0], 200)
        .unwrap_err()
        .starts_with("SESSION_INVALIDATED:"));
}

#[test]
fn rejects_render_bombs_and_invalid_geometry_before_allocation() {
    assert!(render_dimensions(1.0, 200_000.0, 4096, false).is_err());
    assert!(render_dimensions(f32::NAN, 100.0, 100, false).is_err());
    assert!(render_dimensions(100.0, 0.0, 100, false).is_err());
    assert_eq!(
        render_dimensions(240.0, 360.0, 360, true).unwrap(),
        (240, 360)
    );
}

#[test]
fn bounded_writer_refuses_output_before_exceeding_limit() {
    let temporary = NamedTempFile::new().unwrap();
    let mut writer = LimitedWriter {
        file: temporary.as_file().try_clone().unwrap(),
        written: 0,
        limit: 4,
    };
    writer.write_all(b"123").unwrap();
    assert!(writer.write_all(b"45").is_err());
    writer.flush().unwrap();
    assert_eq!(fs::read(temporary.path()).unwrap(), b"123");
}

mod assets;
mod pdf_stamp;
