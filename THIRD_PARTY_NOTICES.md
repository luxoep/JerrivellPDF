# 第三方组件与许可声明

<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

Jerrivell PDF 自有代码、文档与原创合成样本采用 `GPL-3.0-or-later`，完整文本见 [LICENSE](LICENSE)。本声明不改变第三方组件原有许可，也不能代替它们的版权、许可证和 NOTICE 文件。

本文件与 `licenses/` 保存的原文一同交付。精确版本以 `src-tauri/Cargo.lock`、`package-lock.json`、PDFium 来源清单及实际随包内容为准。`licenses/inventory.json` 记录从当前本地依赖取得的许可文件、元数据和 SHA-256；清单也包含部分构建/开发依赖，不代表每个包都进入最终二进制。安装后本文件位于 `legal/`，对应原文位于 `legal/licenses/`。

0.4.1 根据用户 Jerry 的名字将产品更名为 **Jerrivell PDF**。旧名 Rivuleaf PDF（页澜）在历史源码包和验证记录中保留。新应用图标由项目几何路径与生成器创作，不采用第三方图标模板或字体轮廓；工具栏的 Lucide 图标及各第三方声明继续保留。当前主源码交付名为 `Jerrivell-PDF-0.6.2-source.zip`，第三方源码补充包为 `JerrivellPDF-0.6.2-third-party-sources.zip`；实际产物及核对结果见 [本版公开清单](https://github.com/luxoep/JerrivellPDF/releases/download/v0.6.2/Jerrivell-PDF-0.6.2-manifest.json)。下方保留的旧版本归档名是历史取得材料，不表示它们已经改名。

## 主要直接组件

| 组件 | 来源 | 上游许可/处理方式 |
| --- | --- | --- |
| React / React DOM 19.3.1 | [facebook/react](https://github.com/facebook/react) | MIT；对应版本原文位于 `licenses/npm/` |
| Tauri 2.12.5 / 前端 API 2.12.4 | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) | MIT OR Apache-2.0；原文位于 `licenses/rust/` 和 `licenses/npm/` |
| Tauri dialog 2.8.4 | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) | MIT OR Apache-2.0；Rust 与前端插件均保留原文 |
| Vite 8.3.5 | [vitejs/vite](https://github.com/vitejs/vite) | MIT；构建工具，原文也保留供审阅 |
| TypeScript 5.9.3 | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0；开发工具 |
| Lucide React 1.63.0 | [lucide-icons/lucide](https://github.com/lucide-icons/lucide) | ISC；其 LICENSE 同时保留 Feather 派生图标的 MIT 版权声明 |
| pdfium-render 0.9.4 | [ajrcarey/pdfium-render](https://github.com/ajrcarey/pdfium-render/tree/0.9.4) | MIT OR Apache-2.0；两种许可文本应随来源记录保存 |
| PDFium 151.0.7881.0 | [Chromium PDFium](https://pdfium.googlesource.com/pdfium/) | 实际构建的 `pdfium/licenses/pdfium.txt` 保存 PDFium BSD-style 与 Apache-2.0 原文；组成部分分别保留 |
| lopdf 0.46.0 | [J-F-Liu/lopdf](https://github.com/J-F-Liu/lopdf) | MIT；仅用于本软件自己生成的文字行内容流字距写入，关闭默认功能，保留 `licenses/rust/lopdf-0.46.0/` 原文 |
| flate2 1.1.10 | [rust-lang/flate2-rs](https://github.com/rust-lang/flate2-rs) | MIT OR Apache-2.0；纯 Rust 解压后端，有限额地读取自生成内容流；原文保留 |
| PDFium Windows x64 预编译包 | [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries/releases/tag/chromium%2F7881) | 外层 `pdfium/LICENSE` 是该分发项目的 MIT 文本；不能代替 PDFium/组成部分原文 |
| NSIS 3.13 | [Tauri 官方工具归档](https://github.com/tauri-apps/binary-releases/releases/tag/nsis-3.13) | 安装器工具链；原始 COPYING 位于 `licenses/upstream/nsis-3.13-COPYING`，包括 zlib/libpng、bzip2 和 LZMA CPL 1.0 各自条款 |
| nsis_tauri_utils 0.5.3 | [Tauri NSIS 插件](https://github.com/tauri-apps/nsis-tauri-utils/releases/tag/nsis_tauri_utils-v0.5.3) | MIT OR Apache-2.0；固定源码提交的原文位于 `licenses/upstream/` |

`pdfium-render` 的许可不覆盖 PDFium native DLL。它的 `pdfium_7881` 功能用于匹配对应的 PDFium API；它不授予 Adobe、Google 或其他项目的商标使用或背书权。

`src-tauri/resources/pdfium` 保留实际运行库、15 份组成部分许可文件、版本/构建参数与 `aurapdf-runtime.json`。安装资源映射为 `pdfium/`。当前 PDFium 关闭 V8 和 XFA。

固定归档 SHA-256：`73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08`。DLL SHA-256：`79d4676b656cfb1abcea88f9ade3b4b0826c5200382db5f4ec72a636c598c118`。准备脚本为 `scripts/setup-pdfium.ps1`，从指定版本来源下载并验证。

PDFium 的组成部分包括 FreeType、Independent JPEG Group / libjpeg-turbo、ICU、libpng、OpenJPEG、zlib、lcms、libtiff、AGG、Abseil、fast_float、simdutf 与 LLVM libc，具体声明以该归档内原文为准。Jerrivell PDF 通过 PDFium 使用 FreeType 代码，相关版权与免责声明见 `pdfium/licenses/freetype.txt`。This software is based in part on the work of the FreeType Team. This software is based in part on the work of the Independent JPEG Group. 对应 JPEG 声明见 `pdfium/licenses/libjpeg_turbo.ijg` 和 `libjpeg_turbo.md`。

少量注册表包未携带许可证全文的情况，使用其 `.cargo_vcs_info.json` 标注的固定上游提交，或同版本 npm 父包来补齐；来源和校验值在 `licenses/upstream-manifest.json`。MPL 2.0 标准原文从 Mozilla 官方地址保存。没有修改第三方源代码。

Windows、WebView2 及系统字体是外部平台依赖，各自采用其供应方许可。当前安装包配置不嵌入 Microsoft WebView2 引导器，运行环境需已具备 WebView2；本项目 GPL 声明不覆盖这些平台组件。

0.4.0 原文编辑显式替换字体时，通过 Windows GDI 读取选定 TrueType 字体的内存快照，核对实际名称、`OS/2.fsType` 和所需字形，再嵌入用户保存的 PDF；不将系统字体加入项目、安装包、主源码或第三方源码补充包。该权限位检查不能代替字体许可条款；用户应确认文档用途和嵌入/传播权限。新增文字和图章仍以本机 Canvas 绘制为 PNG。详见 [原文编辑说明](docs/原文编辑说明.md)。

## MPL 覆盖源码与安装器来源

本地已识别的 Rust MPL-2.0 组件如下；其源代码仍受 MPL-2.0 保护，不因本项目根目录许可而失去原有权利。确切源码包和注册表校验值已整理到同版本交付文件 `RivuleafPDF-0.1.0-third-party-sources.zip` 的 `third-party-sources/mpl-crates/`。以下官方地址也是对应源代码的取得方式：

| 组件 | 官方版本源包 |
| --- | --- |
| cssparser 0.37.0 | [发布源包](https://crates.io/api/v1/crates/cssparser/0.37.0/download) |
| cssparser-macros 0.7.1 | [发布源包](https://crates.io/api/v1/crates/cssparser-macros/0.7.1/download) |
| dtoa-short 0.3.5 | [发布源包](https://crates.io/api/v1/crates/dtoa-short/0.3.5/download) |
| option-ext 0.2.0 | [发布源包](https://crates.io/api/v1/crates/option-ext/0.2.0/download) |
| selectors 0.38.0 | [发布源包](https://crates.io/api/v1/crates/selectors/0.38.0/download) |

MPL 的完整条款在相应 `legal/licenses/` 原文中。对于满足 MPL 2.0 第 3.3 节、未标记为与 Secondary Licenses 不兼容的覆盖源码，与本项目 GPL-3.0-or-later 自有代码组成 Larger Work 时，依该节保留 MPL 权利并额外提供适用的 GPL 许可选项；不删除原版权和许可声明。本机检查上述五个源包的普通源文件，未发现 Exhibit B 不兼容标记；该检查不代替未来版本的逐项复核。

npm 中 `lightningcss` 与 `lightningcss-win32-x64-msvc` 1.33.0 也采用 MPL-2.0；它们是 Vite 构建依赖。当前应用安装资源不包含这些 Node/native 构建工具，输出 CSS 不应被误标为第三方引擎本身。若今后把完整开发工具或 `node_modules/` 一并分发，应另外履行相应源码提供和通知义务。

当前 NSIS 安装器使用 LZMA 压缩。其 CPL-1.0 原文及专用链接例外保存在 `legal/licenses/upstream/nsis-3.13-COPYING`；该例外不要求将独立应用改为 CPL，但压缩模块自身的条款仍适用。同版本源码 `nsis-3.13-src.tar.bz2` 已放在上述第三方源码交付包内，也可从 [NSIS 官方发布目录](https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/nsis-3.13-src.tar.bz2/download) 取得。SHA-256 为 `a8ffe024602d46b6d766f9e1ce30c324ad2a24daeacd3efc2642d436a0c157ac`。

该套件补充目前识别的 MPL 与安装器源码，不宣称它已单独构成所有 GPL Corresponding Source。公开分发应用二进制时，仍须按实际组合和适用条款提供自有源码、所需对应源码、构建/安装脚本及明确可用的取得方式；不能只交付 LICENSE 和压缩后的前端资源。

## 原创样本与字体

`fixtures/sample.pdf`、`fixtures/second.pdf` 和它们的生成器是为本项目独立编写的测试材料，采用 `GPL-3.0-or-later`。生成器是这些 PDF 的可修改源形式。样本没有从其他文档复制文字、图像或页面。

样本使用 PDF 标准字体名称 Helvetica 和 Helvetica-Bold，由阅读器提供字体渲染；样本与生成器均未包含或分发字体程序文件。当前没有随包引入 Noto、思源、Windows 系统字体、OCR 模型或商业 PDF SDK。

## 更新与分发记录

依赖更新后执行 `python scripts/collect-licenses.py`，检查原文清单与实际构建。该脚本不访问网络，补充文件由随源码保留的 `upstream-manifest.json` 校验。需要恢复这些文件时可运行 `python scripts/fetch-license-supplements.py`。

对应源码、可复现构建说明、确切产物哈希和安装后资源检查应与每次分发一起记录。此项目目录已经提供 Jerrivell PDF 源码；公开源码与版本归档位于 [https://github.com/luxoep/JerrivellPDF](https://github.com/luxoep/JerrivellPDF)。公开发布时还需落实相应版本的源码取得方式、传递组件的适用义务及新增素材来源。本版分发材料见 [Release](https://github.com/luxoep/JerrivellPDF/releases/tag/v0.6.2) 与 `PUBLICATION.md`。

## 权威原文

- [GNU GPL v3](https://www.gnu.org/licenses/gpl-3.0.html)
- [pdfium-render 许可信息](https://github.com/ajrcarey/pdfium-render/blob/master/Cargo.toml)
- [PDFium LICENSE](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE)
- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.html)

本声明说明已识别的组件来源与交付工作，不构成对完整许可兼容性或任何司法辖区法律问题的保证。
