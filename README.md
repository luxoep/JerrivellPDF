<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF

A local, open-source Windows PDF workspace for everyday documents and mechanical drawings.

一个面向日常文档和机械图纸的 Windows 开源 PDF 工作台。阅读、编辑、打印和图纸对比都在本机执行。

[English](#english) · [简体中文](#简体中文) · [Latest release / 最新版](https://github.com/luxoep/JerrivellPDF/releases/latest)

## English

### Download and open

1. Install the [Microsoft Edge WebView2 Evergreen Runtime (x64)](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) if it is missing. The installer expects the runtime to be present.
2. Download and run the Windows x64 installer. Check its SHA-256 against the file on the release page. The 0.15.1 installer is unsigned. [Download 0.15.1 for Windows x64](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell.PDF_0.15.1_x64-setup.exe)
3. Open **Jerrivell PDF** from the Windows Start menu. The installed app runs independently of the development toolchain.

### Work with PDFs

| Task | What you can do |
| --- | --- |
| Read and find | Open several PDFs in tabs, view two side by side or stacked, zoom each pane independently, and highlight matches in searchable text. |
| Organize and print | Rearrange, rotate, insert, merge, split or crop pages. Add page numbers or watermarks, review export details, and choose paper, color and print resolution. |
| Edit and reuse | Add text, images, marks and stamps. Edit supported original text and images. Select a drawing feature with a closed curve and reuse it in another PDF. |
| Place a signature | Draw, type or import a visual signature. Placement records the device's date, time and UTC offset. |
| Compare drawings | Open the separate comparison workspace, pair A/B pages, review highlighted differences, and export PNG or CSV reports. |

Use **Save project** for an editable `.jvp` and **Save copy** for a PDF to share. Use `.jvcmp` to resume drawing review with the original source PDFs.

Search works on readable text layers. OCR is planned. Curve cuts and erasure can leave source data in the PDF. The time on a visual signature comes from the device clock. Drawing differences are visual review aids.

### Documentation

- [Quick start](docs/QUICK_START.md) · [Build from source](docs/BUILDING.md) · [Roadmap](docs/ROADMAP.md)
- [Release history](docs/RELEASES.md) · [0.15.1 release notes](docs/RELEASE_NOTES.md) · [Release validation](docs/VALIDATION.md)
- [Publication and asset provenance](PUBLICATION.md) · [Licenses and notices](THIRD_PARTY_NOTICES.md)

Report problems with the app version, Windows version and steps to reproduce. Use synthetic or authorized public samples. [GitHub Issues](https://github.com/luxoep/JerrivellPDF/issues)

## 简体中文

### 下载并打开

1. 如本机缺少运行环境，先安装 [Microsoft Edge WebView2 Evergreen Runtime（x64）](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)。安装器使用系统已有的运行环境。
2. 下载并运行 Windows x64 安装包。可用发布页提供的 SHA-256 核对文件。0.15.1 安装包尚未签名。[下载 0.15.1 Windows x64 安装包](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell.PDF_0.15.1_x64-setup.exe)
3. 从 Windows 开始菜单打开 **Jerrivell PDF**。安装后的程序可独立运行，无需配置开发工具链。

### 常用操作

| 工作 | 可以做什么 |
| --- | --- |
| 阅读与查找 | 在选项卡打开多份 PDF，切换左右或上下分屏，各窗格独立缩放，在可检索正文上高亮命中。 |
| 整理与打印 | 调整页序、旋转、插入、合并、拆分和裁剪。添加页码或水印，检查导出内容，选择纸张、颜色和打印 DPI。 |
| 编辑与复用 | 新增文字、图片、标记和图章。修改受支持的原文字与图片，用闭合曲线提取图纸特征，在其他 PDF 复用。 |
| 制作签名 | 手写、键入或导入可视签名。放置时记录本机日期、时间和 UTC 偏移。 |
| 图纸对比 | 在独立工作区配对 A/B 页面，查看高亮差异，导出 PNG 或 CSV 报告。 |

用「保存项目」生成可继续编辑的 `.jvp`，用「保存副本」生成可分发的 PDF。保存 `.jvcmp` 可配合原始 PDF 继续图纸复核。

查找依赖已有文字层，离线 OCR 在规划中。曲线剪切和局部擦除可能保留底层数据。签名旁的时间来自本机时钟。图纸差异供人工复核。

### 文档入口

- [快速开始](docs/QUICK_START.zh-CN.md) · [从源码构建](docs/BUILDING.zh-CN.md) · [路线图](docs/ROADMAP.zh-CN.md)
- [版本索引](docs/RELEASES.zh-CN.md) · [0.15.1 发布说明](docs/RELEASE_NOTES.zh-CN.md) · [发布验证](docs/VALIDATION.zh-CN.md)
- [发布材料与来源](PUBLICATION.md) · [第三方声明](THIRD_PARTY_NOTICES.md)

反馈时请附软件版本、Windows 版本和复现步骤。示例请使用合成文件或获准公开的样本。[GitHub Issues](https://github.com/luxoep/JerrivellPDF/issues)

## License / 许可

Current project code, documentation and original synthetic fixtures use **MIT OR Apache-2.0**. Third-party components retain their own terms. Historical releases retain the license shipped with each version.

当前项目代码、文档与原创合成样本采用 **MIT OR Apache-2.0**。第三方组件适用各自许可，历史发布以该版本附带的许可为准。

[Project license / 项目许可](LICENSE) · [MIT](LICENSE-MIT) · [Apache-2.0](LICENSE-APACHE) · [Third-party licenses / 第三方许可](licenses/)
