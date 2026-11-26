<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF 0.15.1

[English](RELEASE_NOTES.md) · [GitHub 发布页](https://github.com/luxoep/JerrivellPDF/releases/tag/v0.15.1)

## 修复日志

- **剪切原文特征后保存。** 修复放置片段后因 `featureSource` 参数报错而无法预览、导出 PDF 或导出 PNG 的问题。保存为 `.jvp` 后，重新打开项目仍可继续编辑片段。
- **原文编辑保留线型。** 修复受支持的多内容流 PDF 页面在编辑对象时，邻近实线错误继承点划线样式的问题。拖动预览及导出后均保留原有线型。含顶层渐变或内嵌图像的页面采用兼容路径保留图形，这类页面仍可能出现线型变化。

剪切特征会覆盖原位置，源数据可能仍留在导出的 PDF 中。[特征编辑指南](0.15.0-分屏查找与图纸编辑.md#提取或剪切图纸特征)

## 下载

| 文件 | 用途 |
| --- | --- |
| [Jerrivell.PDF_0.15.1_x64-setup.exe](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell.PDF_0.15.1_x64-setup.exe) | Windows x64 安装包 |
| [Jerrivell-PDF-0.15.1-source.zip](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell-PDF-0.15.1-source.zip) | 该版本的项目源码、锁文件、构建脚本和文档 |
| [Jerrivell-PDF-0.15.1-user-guide.zip](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell-PDF-0.15.1-user-guide.zip) | 随该版本归档的离线使用指南和许可说明 |
| [JerrivellPDF-0.15.1-third-party-sources.zip](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/JerrivellPDF-0.15.1-third-party-sources.zip) | 已登记的相关第三方组件对应源码 |
| [Jerrivell-PDF-0.15.1-manifest.json](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell-PDF-0.15.1-manifest.json) | Git 提交、附件名称和 SHA-256 校验值 |
| [SHA256SUMS.txt](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/SHA256SUMS.txt) | 发布文件的 SHA-256 校验清单 |

运行需要 Microsoft Edge WebView2 x64 Evergreen Runtime。当前安装包未配置代码签名，安装前请核对 SHA-256。升级前先保存工作并退出旧程序。[WebView2 官方下载](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

本版项目自有代码和文档采用 **MIT OR Apache-2.0**。第三方组件沿用各自许可。[版本许可索引](RELEASES.zh-CN.md)

[快速开始](QUICK_START.zh-CN.md) · [分屏查找与图纸编辑](0.15.0-分屏查找与图纸编辑.md) · [发布验证](VALIDATION.zh-CN.md) · [分发与来源说明](../PUBLICATION.md)
