<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF quick start

[简体中文](QUICK_START.zh-CN.md) · [Home](../README.md)

For Jerrivell PDF 0.15.0 on Windows x64. Document work runs locally after installation.

## Install or upgrade

1. Download the Windows x64 installer from GitHub and compare its SHA-256 with `SHA256SUMS.txt` on the release page. [0.15.0 installer](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.0/Jerrivell.PDF_0.15.0_x64-setup.exe) · [All releases](https://github.com/luxoep/JerrivellPDF/releases)
2. Install the x64 Microsoft Edge WebView2 Evergreen Runtime separately if needed. For an offline PC, get Microsoft's standalone installer before transferring it to that PC. [WebView2 download](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
3. Run the Jerrivell PDF installer and open **Jerrivell PDF** from the Start menu. Use the full installer on a new PC so it receives the matching PDFium runtime and license files.

Before upgrading, save open projects and exit the app. Use **Settings → Set as default PDF app** to choose the `.pdf` association in Windows. If File Explorer entries are missing, use **Settings → Repair Open with registration**. To remove the app, use **Windows Settings → Apps**.

## Open, read and search

- Choose **Open** or press `Ctrl+O` to open a PDF or `.jvp` in its own tab. Reopening an open file focuses that tab. File Explorer's **Open with**, PDF context command and **Send to** also open PDFs.
- Open two PDFs and use **Split left and right** or **Split top and bottom** beside the tabs. Each pane keeps its page, scroll position and zoom. Click the pane you want to edit.
- Press `Ctrl+F` to highlight searchable text. Click a result to jump to it. **Select text** copies an existing text layer when the PDF permits copying. Image-only scans and outlined lettering require OCR to become searchable. OCR is planned separately.
- Use `Ctrl+wheel` to zoom, scroll normally to read, or choose **Fit width** or **Page**. Press `Ctrl+W` to close the current tab.

## Organize and save pages

Drag thumbnails to reorder pages. Use the page controls to rotate, delete, duplicate or insert blank pages. **Import PDF** adds pages from another file to the current document. Use **Tools** for images to PDF, batch splitting, page numbers, watermarks and cropping.

| What you want to keep | Use |
| --- | --- |
| Editable work, including source PDFs, page order, added text, marks and fragments | **Save project** or `Ctrl+Shift+S` creates a `.jvp`. Open it to continue editing. |
| A PDF to read or share | **Save copy** or `Ctrl+S` opens the export review. Check page order and the warnings, then save the PDF. Added objects may be written as visual content. |
| Review progress for one drawing page pair | **Save comparison project** creates a `.jvcmp`. Keep the A and B PDFs available so the app can verify them when reopening. |

Save projects manually in 0.15.0. Automatic recovery is a planned improvement. [Roadmap](ROADMAP.md)

## Edit, mark and sign

- Open **Add content** to insert text, images and stamps. Drag out a text box on the page and type into it. **Mark** adds highlights, shapes, lines and arrows.
- Use **Edit original** or **Text lines** for supported text and objects already in the PDF. What can be adjusted depends on the original document's fonts and internal structure.
- In **Add content → Sign**, draw, type your name or import a signature image. Save a template in the local library if you want to reuse it. On placement, the mark shows the device date, time and UTC offset. This is the time recorded by the device clock. Certificate-based signing is a separate workflow.
- Use **Edit original → Extract or cut feature** to outline a fragment. Choose **Freeform curve (close manually)** and click **Close curve** when ready. **Copy as fragment** keeps the source visible. **Cut as fragment** covers the original location with a white fill. Move the fragment, resize it, rotate it in 90° steps or recolor it. The paper and ink inside the outline stay opaque.
- Use **Mark → Erase page regions** to clip the visible portions of images and supported nested content. Use the image eraser for repairs to a single image. Both region erasing and cutting can leave underlying source data in the exported PDF. Treat the exported PDF as containing that data when sharing it.

## Compare drawings and resume review

1. Open **Compare** and choose the old PDF as A and the new PDF as B. Select the pages. The comparison reads files from disk, so save a PDF copy first if you want to compare unsaved edits.
2. Set **Analysis scale**. **Fit to A (recommended)** scales B proportionally to A and can normalize print-scale differences. Choose **Original paper sizes** when overall print scale matters. Fit-to-A millimetres describe coordinates relative to A. Use the original drawing for physical measurements.
3. Verify alignment and set DPI and pixel tolerance. Use **Point alignment**, **Auto translation** followed by confirmation, or manual offsets as needed. Then choose **Compare drawings**.
4. Inspect the difference list and detail view. Mark reviewed items and add notes. Export PNG or CSV as needed. **Multi-page** lets you review page pairs and export batch CSV. Handle failed or unpaired pages separately.
5. Choose **Save comparison project** to save a `.jvcmp` for the current page pair. To resume, use **Open comparison project**. If the source files moved, select the original files or byte-identical copies. The app verifies them and recalculates the comparison. [Analysis scale](0.12.0-统一图幅分析.md) · [Review projects](0.13.0-图纸复核项目.md) (Chinese)

## Print and troubleshoot

Open **Print** to preview the result and choose pages, paper, orientation, copies, color mode and DPI. The Windows printer driver determines the printable area and final output.

| Problem | What to do |
| --- | --- |
| Blank window or missing WebView2 | Install the official x64 Evergreen Runtime and launch again. |
| Missing PDFium | Reinstall from the full Jerrivell PDF installer. |
| Development preview can only show the layout | Use the Windows desktop app for PDF operations, or run the Tauri app when developing. |
| The drawing comparison shows too many changes | Verify page pairs, scale mode, orientation and alignment. Check DPI and pixel tolerance before rerunning. |

[Build from source](BUILDING.md) · [Release validation](VALIDATION.md) · [Release history](RELEASES.md)
