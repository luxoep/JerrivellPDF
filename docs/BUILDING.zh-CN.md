<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# 在 Windows 上构建 Jerrivell PDF

[English](BUILDING.md)

桌面端的目标平台为 **Windows x64**。在 PowerShell 中进入仓库根目录执行以下命令。只想使用软件时，可按[安装指南](QUICK_START.zh-CN.md)安装，无需准备开发工具。

## 环境要求

| 组件 | 用途 |
| --- | --- |
| Git | 克隆仓库，需要时切换到发布标签。 |
| Node.js 和 npm | 锁定的 Vite 工具链要求 Node `^20.19.0` 或 `>=22.12.0`。npm 安装依赖并运行本地 Tauri CLI。 |
| Rust 和 Cargo | 使用 Windows MSVC 主机工具链。[rust-toolchain.toml](../rust-toolchain.toml) 固定 Rust 1.99.1，并声明 rustfmt 和 Clippy。 |
| MSVC C++ 和 Windows SDK | 通过 Visual Studio 或 Build Tools 安装「使用 C++ 的桌面开发」，包含 x64 编译器、链接器和 Windows SDK。 |
| WebView2 Evergreen Runtime x64 | 运行桌面界面。系统缺少时需单独安装。 |
| PDFium Windows x64 | 准备脚本取得固定的 `chromium/7881` 运行库，并检查 SHA-256。 |
| Python 3.11 或更高版本 | 维护时用于许可收集和发布归档。 |

## 准备源码和依赖

需要构建公开发行版的源码时，克隆后切换到 `v0.15.0`。日常开发使用默认检出的分支。

```powershell
git clone https://github.com/luxoep/JerrivellPDF.git
Set-Location JerrivellPDF
# 可选：git switch --detach v0.15.0
npm.cmd ci
npm.cmd run setup:pdfium
cargo fetch --locked --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml
```

npm 和 Cargo 使用仓库中的锁文件。PDFium 准备脚本核对归档，并将运行库和上游许可保存在 `src-tauri/resources/pdfium/`。请使用与仓库中引擎绑定匹配的运行库。

发布许可检查离线读取 Cargo 依赖图，运行完整检查前需先获取依赖。如需离线构建，请提前缓存 npm、Cargo、PDFium 和 Tauri/NSIS 打包工具，并安装 Windows 工具链与 WebView2。首次准备可能需要联网。安装后的 PDF 处理在本机执行。

## 启动桌面开发版

```powershell
npm.cmd run tauri dev
```

Tauri 在 `127.0.0.1:1420` 启动 Vite、编译 Rust 并打开桌面窗口。停止开发会话前先保存工作，再按 `Ctrl+C`。

只需检查网页排版时，可运行 `npm.cmd run dev`。原生 PDF 操作和 Windows 对话框需要桌面应用。测试时请使用原创合成 PDF 或获准使用的样本。

## 检查与打包安装程序

执行完整发布检查并生成安装包。

```powershell
npm.cmd run build:desktop
```

开发时也可单独运行需要的检查。

```powershell
npm.cmd run check
npm.cmd run test:frontend
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

`npm.cmd run build:desktop` 执行完整发布检查，覆盖 Windows 依赖许可、前端行为、Rust 测试、桌面应用和 NSIS 打包，以及对构建产物的原生联动测试。通过后在 `test-results/<版本>/release-gate.json` 记录结果与校验值。

| 产物 | 位置 |
| --- | --- |
| Windows x64 NSIS 安装包 | `src-tauri/target/release/bundle/nsis/` |
| 原生程序 | `src-tauri/target/release/jerrivell-pdf.exe` |
| 前端生产构建 | `dist/` |
| 构建和测试记录 | `test-results/<版本>/` |

分发应用时使用完整安装包。`npm.cmd run build` 只生成前端产物。初次 Rust 优化构建可能需要几分钟。

## 许可与发布材料

源码需保留锁文件、[许可归档](../licenses/)和[第三方声明](../THIRD_PARTY_NOTICES.md)。依赖、锁文件或 PDFium 版本变动时，应重新核对实际解析出的 Windows 依赖图、对应许可文本和来源。

```powershell
python scripts/collect-licenses.py
node scripts/check-license-policy.mjs
python scripts/package-copyleft-sources.py --download-missing
```

许可收集脚本从本机依赖缓存读取文本。源码补充脚本按固定版本和校验值处理清单中的 MPL 组件及 NSIS。`--download-missing` 会在缺少归档时获取对应文件。

维护者可在发布检查通过后用 `scripts/package-release.ps1` 整理安装包、源码与清单。`scripts/verify-release.py` 还会检查本机安装副本，因此需要对应安装目录。上传前核对公开归档与校验值，业务 PDF、项目文件和私有测试输出存放在本机。

## 测试范围与排错

标准原生联动不提交实体打印任务。单独检查打印光栅化时，可运行 `node tests/native-printing.mjs --raster-only`。`tests/` 中的部分浏览器交互和独立 PDF 检查需要在开发机上另备 Python、浏览器、pypdf、Pillow 或 Poppler。发布标签对应的检查记录见[发布验证](VALIDATION.zh-CN.md)。

| 现象 | 检查项 |
| --- | --- |
| PowerShell 找不到 npm 或 Cargo | 安装缺少的工具后重开终端，检查 PATH。 |
| 链接器或 SDK 报错 | 核对 MSVC x64 和 Windows SDK 组件。 |
| 1420 端口被占用 | 停止已有开发任务，再启动 Tauri。 |
| PDFium 资源缺失 | 重跑 `npm.cmd run setup:pdfium` 并检查输出。 |
| 许可检查报告锁文件校验值不一致 | 核实依赖改动及许可来源后再刷新清单。 |
