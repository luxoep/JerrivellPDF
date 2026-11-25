<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF 0.15.0 release validation

[简体中文](VALIDATION.zh-CN.md)

This record covers the Windows x64 [v0.15.0 release](https://github.com/luxoep/JerrivellPDF/releases/tag/v0.15.0). It applies to the published tag and installer. The documentation on `main` may change after a release.

The local Windows release checks passed **33 front-end check groups, 87 Rust tests and 10 native integration groups**. The checks also covered Windows dependency licensing, the production build, NSIS packaging and artifact hashes. These are local test results. Reproduction commands are in the [build guide](BUILDING.md).

## What was checked

| Area | Checks |
| --- | --- |
| Split view | Side-by-side and stacked layouts, switching the editing target, and independent page, scroll and zoom state. |
| Find | Searchable text, navigation to matches, and highlight alignment after zoom and rotation. |
| Signatures | Signature creation, local templates and the local date, time and UTC offset recorded on placement. |
| Local editing | Drawing a curve in segments, closing it, extracting and cutting regions, recoloring, rotating, moving, resizing and erasing. |
| Editable projects | Saving a `.jvp`, reopening in a new process, editing again, saving and exporting PDF. The existing project survives a save that exceeds resource limits. |
| Public release files | Source archive, installer, guides, third-party source supplement and SHA-256. |

Extra browser checks exercised split view, search navigation and the complete curve-selection interaction. A technical drawing was tested locally for cutting, recoloring, rotation and export. After reopening the `.jvp` in a new process, its page preview matched pixel for pixel and the feature could still be edited and saved. The source PDF's SHA-256 matched before and after the test. The public source archive includes original synthetic PDF fixtures.

The test record covers the workflows above. Compatibility with other PDF structures, Windows environments and printer drivers needs separate checks. Find results require searchable text. The release contains the [installer, source, guide, third-party source supplement and checksums](https://github.com/luxoep/JerrivellPDF/releases/tag/v0.15.0).
