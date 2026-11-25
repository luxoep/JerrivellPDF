<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF 0.15.0

[简体中文](RELEASE_NOTES.zh-CN.md) · [GitHub release](https://github.com/luxoep/JerrivellPDF/releases/tag/v0.15.0)

## What changed

- **Side-by-side and stacked split views.** With two documents open, switch layouts at the right end of the tab bar. Each pane keeps its own page, scroll position and zoom. Click a pane to set the active document for editing.
- **Search highlights.** Press `Ctrl+F` to search the existing text layer. Choose a result to jump to it. Highlights stay aligned when you zoom or rotate the page.
- **Visible signatures with local time.** Draw a signature, type a name, import an image or save a local template. Each placement displays the device date, time and UTC offset.
- **Curve-based cutouts.** Select **Edit original → Extract or cut feature**, draw a curve and close it. You can move, resize, rotate 90°, recolor and reuse the fragment in other PDFs. The fragment retains the paper inside the outline. Cutting covers the original position with a white fill. The page eraser also accepts manually closed curves.
- **Editable project saves.** Save a `.jvp` from **Save project** or by pressing `Ctrl+Shift+S`. Saving and reopening apply the same resource checks. If a save exceeds the limits, the previous project file is preserved. Exporting a PDF copy can still leave editable changes to save as a project.

The displayed signing time comes from the local device clock. Cutouts and local erasing affect the visible page. Source data may remain in the exported PDF.

## Downloads

| File | Use |
| --- | --- |
| [Jerrivell.PDF_0.15.0_x64-setup.exe](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.0/Jerrivell.PDF_0.15.0_x64-setup.exe) | Windows x64 installer |
| [Jerrivell-PDF-0.15.0-source.zip](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.0/Jerrivell-PDF-0.15.0-source.zip) | Versioned project source, lockfiles, build scripts and docs |
| [Jerrivell-PDF-0.15.0-user-guide.zip](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.0/Jerrivell-PDF-0.15.0-user-guide.zip) | Offline user guide and license information for this release |
| [JerrivellPDF-0.15.0-third-party-sources.zip](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.0/JerrivellPDF-0.15.0-third-party-sources.zip) | Recorded corresponding source for covered third-party components |
| [Jerrivell-PDF-0.15.0-manifest.json](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.0/Jerrivell-PDF-0.15.0-manifest.json) | Git revision, asset names and SHA-256 digests |
| [SHA256SUMS.txt](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.0/SHA256SUMS.txt) | SHA-256 checksums for release files |

Jerrivell PDF requires the Microsoft Edge WebView2 x64 Evergreen Runtime. The 0.15.0 installer is unsigned. Check its SHA-256 before installing. Before upgrading, save your work and close the running app. [Official WebView2 download](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

The project's own code and documentation use **MIT OR Apache-2.0** for this version. Third-party components retain their own licenses. [Version and license index](RELEASES.md)

[Quick start](QUICK_START.md) · [Release validation](VALIDATION.md) · [Publication and provenance](../PUBLICATION.md)
