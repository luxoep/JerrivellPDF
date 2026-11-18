<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# 构建 Jerrivell PDF 0.8.2

本文件适用于本标签的历史代码；功能与依赖以同一标签下的锁文件和脚本为准。

需要 Windows x64、MSVC C++ 桌面工具链和 Windows SDK、WebView2 Runtime、Git、Node.js/npm 与 Rust MSVC 工具链。Rust 固定版本见 `rust-toolchain.toml`，Node 要求见本版前端工具依赖。首次准备依赖需要网络；普通安装使用不需要开发工具。

在 PowerShell 中执行：

```powershell
git clone https://github.com/luxoep/JerrivellPDF.git
Set-Location JerrivellPDF
git checkout v0.8.2
npm ci
npm run setup:pdfium
npm run tauri dev
```

按本版准备脚本下载固定 PDFium 并校验。不要用不明来源或不同 ABI 的 DLL。退出开发任务后可打包：

```powershell
npm run build:desktop
```

安装包位于 `src-tauri/target/release/bundle/nsis/`。构建时保留 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`licenses/` 和 PDFium 原文。Python 3.11+ 供许可与发行维护脚本使用；不要将用户文档或本机缓存加入发布包。各版本的检查脚本以该标签实际内容为准，不将最新版验证套用到旧版。
