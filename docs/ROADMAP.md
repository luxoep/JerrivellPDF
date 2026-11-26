<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Roadmap

[简体中文](ROADMAP.zh-CN.md) · [Project home](../README.md)

The next milestone focuses on safe recovery of editing work. Version 0.15.1 already supports portable editable projects, split-view editing, search highlights and drawing review. The stages below describe planned work and acceptance checks. [Current release](RELEASES.md) · [0.15.1 validation](VALIDATION.md)

## 1. Local autosave and recovery

- Save a bounded recovery draft for each edited document. Keep drafts separate from the source PDF and the last explicitly saved `.jvp`, and let users clear drafts or disable recovery for a document.
- Store page order, editable objects and their assets, plus reading position and zoom. On the next launch, show the document and draft time and let users decide what to restore.
- Write a new draft only after a complete snapshot has been validated. If interrupted, fall back to the last complete draft.

**Acceptance check.** Open two PDFs in split view, rotate or reorder pages in one and edit a recolorable feature in the other. End the app unexpectedly. On restart, restore the drafts independently and verify the feature can still be recolored and moved. Compare the source PDFs and explicitly saved projects byte for byte.

## 2. Bookmarks and native PDF annotations

- Start with a tree view for document outlines and navigation to their destination pages. Handle nested bookmarks and unavailable destinations.
- Preserve bookmark targets when pages are moved or reused in exports. Check destinations after reordering, merging or deleting pages.
- Add native text highlights and notes with appearances that survive export. Verify that both their appearance and their editable properties can be reopened in Jerrivell PDF and a second PDF reader.

**Acceptance check.** Reorder and delete pages in a document with nested bookmarks, then reopen the export and verify bookmark navigation and annotation editing in both readers.

## 3. Offline OCR

- Start with an explicitly selected image or outlined-text region in a separate local job. Preview recognized text and highlight locations before adding page-wide or batch workflows.
- Test Chinese and English scans, outlined drawing text and rotated pages separately. Keep native text available and label recognized results.
- Review the engine and language data licenses separately. Keep processing on the device, provide progress and cancellation, and validate coordinate alignment before writing a searchable text layer.

**Acceptance check.** Validate text accuracy and highlight placement on authorized samples for each document type. Cancel a job midway and verify that the document and original PDF remain usable.
