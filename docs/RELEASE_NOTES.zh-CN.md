<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF 0.14.1

本版恢复从「标记」工具栏直接圈选页面局部擦除，加入了更紧凑的顶部导航，并将「编辑原文」的本机字体替换设为默认勾选。也包含 0.13.0 之后的文字直接编辑与对象图层更新。

- **页面局部擦除。** 在页面预览中圈选一处或多处区域。应用后，选区内的图片和受支持的嵌套绘制内容从显示中移除。选区外维持原始图片清晰度，可编辑的顶层文字和矢量仍可单独选择。
- **对象与图片编辑。** 对象列表支持按文字、矢量、图片筛选，仍可直接删除单个对象。对支持的图片，可用像素橡皮擦进行底色修复或擦成透明。
- **文字操作。** 拖出文本框即可输入，修改已添加的文字会自动应用。原文单对象文字可在离开输入区域或按 `Ctrl+Enter` 时提交。新文字优先使用本机 Century Gothic。
- **原文使用本机字体。** 单对象和文字行编辑默认勾选替换为可嵌入的本机字体，可按对象取消。安装包使用系统已有的字体。
- **紧凑导航。** 顶部收为 56 像素高的单行，窄窗口保留带操作提示的图标。

局部擦除保留原始图片数据。若要永久去除敏感内容，请使用专门的脱敏工具。

## 下载

| 文件 | 用途 |
| --- | --- |
| Jerrivell.PDF_0.14.1_x64-setup.exe | Windows x64 安装包 |
| Jerrivell-PDF-0.14.1-source.zip | 版本源码、构建脚本与文档 |
| Jerrivell-PDF-0.14.1-user-guide.zip | 离线使用指南与许可说明 |
| JerrivellPDF-0.14.1-third-party-sources.zip | 已登记的第三方对应源码 |
| Jerrivell-PDF-0.14.1-manifest.json | Git 版本、附件与 SHA-256 |
| SHA256SUMS.txt | 发布文件的 SHA-256 校验值 |

运行需要 Microsoft Edge WebView2 x64 Evergreen Runtime。当前安装包未配置代码签名，安装前请核对 SHA-256。升级前先保存工作并退出旧程序。[WebView2 官方下载](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

项目自有代码和文档采用 MIT OR Apache-2.0。第三方组件保留各自许可。[版本许可索引](https://github.com/luxoep/JerrivellPDF/blob/v0.14.1/docs/RELEASES.zh-CN.md)

操作方法和验证范围见 [快速开始](https://github.com/luxoep/JerrivellPDF/blob/v0.14.1/docs/QUICK_START.zh-CN.md)、[局部擦除与文字编辑](https://github.com/luxoep/JerrivellPDF/blob/v0.14.1/docs/0.14.1-局部擦除与文字编辑.md) 和 [发布验证](https://github.com/luxoep/JerrivellPDF/blob/v0.14.1/docs/VALIDATION.zh-CN.md)。
