<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF 0.15.1 release validation

[简体中文](VALIDATION.zh-CN.md)

This record covers the Windows x64 [v0.15.1 release](https://github.com/luxoep/JerrivellPDF/releases/tag/v0.15.1). It applies to the published tag and installer. The documentation on `main` may change after a release.

The local Windows release checks passed **33 front-end check groups, 89 Rust tests and 10 native integration groups**. The checks also covered Windows dependency licensing, the production build, NSIS packaging and artifact hashes. Reproduce the checks with the [build guide](BUILDING.md).

## What was checked

| Area | Checks |
| --- | --- |
| Cutout export | Cut, recolor and move a feature. Preview the complete PDF, export it and reopen all three pages. Verify that the PNG export matches the preview. |
| Original-content line styles | Check solid and dash-dot strokes in a synthetic drawing with multiple content streams during drag previews, after editing text and after reopening the saved PDF. Check strokes outside the selected area after exporting a cutout. |
| Artwork compatibility | Verify that editing nearby text preserves shading and inline images in separate content streams after saving and reopening. |
| Editable projects | Reopen a `.jvp` and edit and save the stored feature again. Confirm the source PDF's bytes remain the same. |
| Public release files | Source archive, installer, guides, third-party source supplement and SHA-256. |

The public source archive includes the synthetic test fixtures and the code that generates the line-style samples. See the release page for the [installer, source, guide, third-party source supplement and checksums](https://github.com/luxoep/JerrivellPDF/releases/tag/v0.15.1).
