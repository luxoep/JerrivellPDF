<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF 0.15.1

[简体中文](RELEASE_NOTES.zh-CN.md) · [GitHub release](https://github.com/luxoep/JerrivellPDF/releases/tag/v0.15.1)

## Fixes

- **Saving after an original-content cutout.** Fixes the `featureSource` argument error that prevented PDF preview, PDF export and PNG export after a cutout was placed on a page. Editable `.jvp` projects can still reopen and edit the cutout.
- **Line styles when editing original content.** On supported pages with multiple PDF content streams, editing an object preserves neighboring solid and dash-dot lines during drag previews and after export. Pages with top-level shadings or inline images use a compatibility path to retain that artwork. Line styles can still change on those pages.

Cutting a feature covers the original position. Source data may remain in the exported PDF. [Feature editing guide](0.15.0-分屏查找与图纸编辑.md#提取或剪切图纸特征)

## Downloads

| File | Use |
| --- | --- |
| [Jerrivell.PDF_0.15.1_x64-setup.exe](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell.PDF_0.15.1_x64-setup.exe) | Windows x64 installer |
| [Jerrivell-PDF-0.15.1-source.zip](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell-PDF-0.15.1-source.zip) | Versioned project source, lockfiles, build scripts and docs |
| [Jerrivell-PDF-0.15.1-user-guide.zip](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell-PDF-0.15.1-user-guide.zip) | Offline user guide and license information for this release |
| [JerrivellPDF-0.15.1-third-party-sources.zip](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/JerrivellPDF-0.15.1-third-party-sources.zip) | Recorded corresponding source for covered third-party components |
| [Jerrivell-PDF-0.15.1-manifest.json](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell-PDF-0.15.1-manifest.json) | Git revision, asset names and SHA-256 digests |
| [SHA256SUMS.txt](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/SHA256SUMS.txt) | SHA-256 checksums for release files |

Jerrivell PDF requires the Microsoft Edge WebView2 x64 Evergreen Runtime. The 0.15.1 installer is unsigned. Check its SHA-256 before installing. Before upgrading, save your work and close the running app. [Official WebView2 download](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

The project's own code and documentation use **MIT OR Apache-2.0** for this version. Third-party components retain their own licenses. [Version and license index](RELEASES.md)

[Quick start](QUICK_START.md) · [Release validation](VALIDATION.md) · [Publication and provenance](../PUBLICATION.md)
