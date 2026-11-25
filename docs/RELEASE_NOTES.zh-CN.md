<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF 0.15.0

- **左右和上下分屏。** 同时打开两份 PDF 时，从选项卡右侧切换布局。两个窗格各自保留页码、滚动位置和缩放。点击窗格可切换编辑目标。
- **搜索结果高亮。** `Ctrl+F` 查找可检索正文，点击结果可跳到命中位置。高亮跟随缩放与页面旋转。
- **签名与时间。** 支持手写、键入姓名、导入图片和保存本机模板。每次放置签名时显示本机日期、时间与 UTC 偏移。
- **曲线剪切和复用。** 在「编辑原文 → 提取或剪切特征」绘制并手动闭合曲线。片段保留轮廓内的纸底，可拖动、缩放、旋转 90°、换色并在其他 PDF 中复用。剪切时用白色纸底覆盖原位置。页面局部擦除也支持手动闭合曲线。
- **项目保存。** 用「保存项目」或 `Ctrl+Shift+S` 保存 `.jvp`。保存与重开使用同一套资源检查，超限时保留已有项目。导出 PDF 副本后，未保存的可编辑内容仍会提示保存项目。

本机时间是可见记录。剪切和局部擦除处理内容的显示，隐藏的源数据可能仍在导出的 PDF 中。

## 下载

| 文件 | 用途 |
| --- | --- |
| Jerrivell.PDF_0.15.0_x64-setup.exe | Windows x64 安装包 |
| Jerrivell-PDF-0.15.0-source.zip | 版本源码、构建脚本与文档 |
| Jerrivell-PDF-0.15.0-user-guide.zip | 离线使用指南与许可说明 |
| JerrivellPDF-0.15.0-third-party-sources.zip | 已登记的第三方对应源码 |
| Jerrivell-PDF-0.15.0-manifest.json | Git 版本、附件与 SHA-256 |
| SHA256SUMS.txt | 发布文件的 SHA-256 校验值 |

运行需要 Microsoft Edge WebView2 x64 Evergreen Runtime。当前安装包未配置代码签名，安装前请核对 SHA-256。升级前先保存工作并退出旧程序。[WebView2 官方下载](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

项目自有代码和文档采用 MIT OR Apache-2.0。第三方组件保留各自许可。[版本许可索引](https://github.com/luxoep/JerrivellPDF/blob/v0.15.0/docs/RELEASES.zh-CN.md)

[快速开始](https://github.com/luxoep/JerrivellPDF/blob/v0.15.0/docs/QUICK_START.zh-CN.md) · [分屏查找与图纸编辑](https://github.com/luxoep/JerrivellPDF/blob/v0.15.0/docs/0.15.0-分屏查找与图纸编辑.md) · [发布验证](https://github.com/luxoep/JerrivellPDF/blob/v0.15.0/docs/VALIDATION.zh-CN.md)
