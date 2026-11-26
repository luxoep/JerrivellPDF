<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Roadmap

[简体中文](ROADMAP.zh-CN.md) · [Project home](../README.md)

The next optimization priority is faster, sharper PDF reading and drawing comparison on Windows. Use 0.15.1 as the baseline. Editable projects, split-view editing, search highlights and drawing review are available today. [Current release](RELEASES.md) · [0.15.1 validation](VALIDATION.md)

## Next optimization · CPU and GPU acceleration

### 1. Measure the pipeline and improve reading

- Time PDFium rendering, PNG encoding, inter-process transfer, and decoding and display in WebView2 separately. Measure time to the first sharp page and the 95th-percentile latency of tab switching and settling after zoom. Repeat with several documents open, including split view and an active comparison job.
- Extend the existing foreground queue to give the current viewport priority over thumbnails and background work. Cancel obsolete requests and discard stale responses. Use measurements to decide whether to reduce PNG encoding work or replace Base64 transfer with local binary transfer.
- Fix the fixed 1000-pixel source in the page-tools crop preview. Request a sharper raster after zoom settles, sized to the visible area and display scale. Keep the previous frame visible while rendering and use viewport tiles for oversized pages where needed. Apply a memory budget to renders and the cache.

### 2. Use CPU cores for independent work

- Parallelize independent pixel classification and image processing with a bounded CPU thread pool. Preserve cross-tile merging and stable region ordering in drawing comparison. Measure whether separate read-only PDFium worker processes improve throughput for independent pages. Keep writes to each editable document ordered and tied to its current revision.
- Keep batch work cancellable and responsive to interactive requests. Include rotated and scanned pages, differing paper sizes, and changes as small as a few pixels around tile boundaries in the comparison baseline.

### 3. Evaluate optional GPU compute for drawing comparison

- Prototype local pixel difference and alignment scoring with `wgpu` and Direct3D 12 if those stages dominate the CPU baseline. Include transfers to and from GPU memory, tile assembly and report generation in the total time. Keep a bounded tile size and fall back to CPU when the adapter is unsupported or GPU execution fails.
- Use the CPU result as the reference for difference masks, region coordinates and PNG/CSV output. Adopt GPU compute only if it improves total time for representative large 300/600 DPI drawing pairs while preserving those results. Record peak memory use alongside timings.

**Acceptance checks.** Compare 0.15.1 and the optimized build with the same files, settings and machine. Check that 100% previews stop redrawing at rest, high zoom recovers fine line detail, and the reader stays responsive while a background job runs. Record median and 95th-percentile interaction latency, total comparison time and peak memory. Verify that cancellation leaves source files intact and that project reopening and export still pass.

All processing and measurement run locally. Publish only synthetic or authorized public fixtures and results. Prefer MIT or Apache-2.0 for new dependencies and run the project's license checks on added crates, enabled backends and distributed dependencies before shipping.

## Feature roadmap

### 1. Local autosave and recovery

- Save a bounded recovery draft for each edited document. Keep drafts separate from the source PDF and the last explicitly saved `.jvp`, and let users clear drafts or disable recovery for a document.
- Store page order, editable objects and their assets, plus reading position and zoom. On the next launch, show the document and draft time and let users decide what to restore.
- Write a new draft only after a complete snapshot has been validated. If interrupted, fall back to the last complete draft.

**Acceptance check.** Open two PDFs in split view, rotate or reorder pages in one and edit a recolorable feature in the other. End the app unexpectedly. On restart, restore the drafts independently and verify the feature can still be recolored and moved. Compare the source PDFs and explicitly saved projects byte for byte.

### 2. Bookmarks and native PDF annotations

- Start with a tree view for document outlines and navigation to their destination pages. Handle nested bookmarks and unavailable destinations.
- Preserve bookmark targets when pages are moved or reused in exports. Check destinations after reordering, merging or deleting pages.
- Add native text highlights and notes with appearances that survive export. Verify that both their appearance and their editable properties can be reopened in Jerrivell PDF and a second PDF reader.

**Acceptance check.** Reorder and delete pages in a document with nested bookmarks, then reopen the export and verify bookmark navigation and annotation editing in both readers.

### 3. Offline OCR

- Start with an explicitly selected image or outlined-text region in a separate local job. Preview recognized text and highlight locations before adding page-wide or batch workflows.
- Test Chinese and English scans, outlined drawing text and rotated pages separately. Keep native text available and label recognized results.
- Review the engine and language data licenses separately. Keep processing on the device, provide progress and cancellation, and validate coordinate alignment before writing a searchable text layer.

**Acceptance check.** Validate text accuracy and highlight placement on authorized samples for each document type. Cancel a job midway and verify that the document and original PDF remain usable.
