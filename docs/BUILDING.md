<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Build Jerrivell PDF on Windows

[简体中文](BUILDING.zh-CN.md)

The desktop build targets **Windows x64**. Run the commands below from the repository root in PowerShell. To use Jerrivell PDF without build tools, start with the [installation guide](QUICK_START.md).

## Requirements

| Component | Purpose |
| --- | --- |
| Git | Clone the repository and select a release tag when needed. |
| Node.js and npm | The locked Vite toolchain requires Node `^20.19.0` or `>=22.12.0`. npm installs dependencies and runs the local Tauri CLI. |
| Rust and Cargo | Use the Windows MSVC host toolchain. [rust-toolchain.toml](../rust-toolchain.toml) pins Rust 1.99.1 and lists rustfmt and Clippy. |
| MSVC C++ and Windows SDK | Install **Desktop development with C++** through Visual Studio or Build Tools, including x64 compiler, linker and Windows SDK. |
| WebView2 Evergreen Runtime x64 | Runs the desktop interface. Install it separately if missing. |
| PDFium for Windows x64 | The setup script prepares the pinned `chromium/7881` runtime and verifies its SHA-256. |
| Python 3.11 or later | Used by maintainers for licensing and release archives. |

## Prepare the checkout

To reproduce the source of the public release, select tag `v0.15.1` after cloning. Use the default checkout for development.

```powershell
git clone https://github.com/luxoep/JerrivellPDF.git
Set-Location JerrivellPDF
# Optional: git switch --detach v0.15.1
npm.cmd ci
npm.cmd run setup:pdfium
cargo fetch --locked --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml
```

npm and Cargo use the checked-in lockfiles. The PDFium setup script verifies the archive and retains the runtime and upstream license materials in `src-tauri/resources/pdfium/`. Keep that runtime matched to the checked-in engine bindings.

The release license check reads Cargo's dependency graph offline. Fetch the dependencies before running the full check. If you need to build offline, first cache npm, Cargo, PDFium and the Tauri/NSIS packaging tools, and install the Windows toolchain and WebView2. Initial setup may require a network connection. PDF processing in the installed app runs locally.

## Run the desktop app during development

```powershell
npm.cmd run tauri dev
```

Tauri starts Vite on `127.0.0.1:1420`, compiles Rust and opens the desktop window. Save your work before stopping the development session with `Ctrl+C`.

Run `npm.cmd run dev` to inspect the web layout alone. Native PDF operations and Windows dialogs require the desktop app. Use original synthetic PDFs or samples you have permission to use for testing.

## Build and check the installer

Run the complete release check and installer build.

```powershell
npm.cmd run build:desktop
```

For a quicker development check, run the relevant part on its own.

```powershell
npm.cmd run check
npm.cmd run test:frontend
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

`npm.cmd run build:desktop` runs the complete release check. It checks Windows dependency licenses, exercises front-end behavior, runs Rust tests, builds the desktop app and NSIS installer, and runs native integration tests against the resulting executable. A successful run writes checks and hashes to `test-results/<version>/release-gate.json`.

| Output | Location |
| --- | --- |
| Windows x64 NSIS installer | `src-tauri/target/release/bundle/nsis/` |
| Native executable | `src-tauri/target/release/jerrivell-pdf.exe` |
| Production front end | `dist/` |
| Test and build records | `test-results/<version>/` |

Use the complete installer when distributing the app. `npm.cmd run build` builds the front end only. An initial optimized Rust build may take several minutes.

## Licenses and release materials

Keep the lockfiles, [license collection](../licenses/) and [third-party notices](../THIRD_PARTY_NOTICES.md) with the source. When a dependency, lockfile or PDFium version changes, check the resolved Windows dependency graph together with the relevant license texts and source provenance.

```powershell
python scripts/collect-licenses.py
node scripts/check-license-policy.mjs
python scripts/package-copyleft-sources.py --download-missing
```

The license collector reads texts from local dependency caches. The source supplement script uses pinned versions and hashes for the listed MPL components and NSIS. `--download-missing` may fetch missing archives.

Maintainers can use `scripts/package-release.ps1` after the release checks pass to assemble the installer, source and manifest. `scripts/verify-release.py` also checks the local installed copy, so it needs the relevant installation directory. Review the public archive and its hashes before upload. Keep business PDFs, project files and private test output in local storage.

## Test scope and troubleshooting

The standard native checks avoid sending physical print jobs. To exercise print rasterization explicitly, run `node tests/native-printing.mjs --raster-only`. Some optional browser and independent PDF checks in `tests/` need Python, a browser, pypdf, Pillow or Poppler on the development machine. See [release validation](VALIDATION.md) for the checks recorded for the tagged release.

| Symptom | Check |
| --- | --- |
| PowerShell cannot find npm or Cargo | Install the missing tool and reopen the terminal so it picks up PATH. |
| Linker or SDK errors | Check the MSVC x64 and Windows SDK components. |
| Port 1420 is in use | Stop the existing development task before restarting Tauri. |
| PDFium resources are missing | Rerun `npm.cmd run setup:pdfium` and review its output. |
| The license check reports a lockfile hash mismatch | Verify the dependency change and its provenance before refreshing the inventory. |
