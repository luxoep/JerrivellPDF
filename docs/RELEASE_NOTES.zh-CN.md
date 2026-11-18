<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF 0.12.0

Windows x64 的本地开源 PDF 工作台。本次发布将“统一图幅”用于实际差异分析，适配数据库导出或打印来源不同、页面标称尺寸不一致而内容相对位置和边距基本一致的图纸。

## 本版重点

- 对比默认 **按统一图幅（推荐）**：以 A 为参考，将 B 等比例适配并居中后进行完整像素差分。
- 同一变换贯穿全图预览、局部详情、高亮、自动平移的粗/精细阶段、多页处理和报告。
- 多页对比按每组对应 A 页分别计算倍率；从批量结果进入单页时恢复该组自己的模式。
- 长宽比不同会保持比例、居中留白，不强行拉伸。
- 保留 **按原始尺寸**，模式变化使旧分析结果过期并阻止误导出。
- 统一图幅报告记录模式、B 倍率和参考单位；右下角导出按钮继续保持独立整行与间距。

整体出图比例变化会被归一化；需要检查它时选择原始尺寸模式。“参考 mm”不代表实际纸张或零件尺寸。自动配准目前仅处理整体平移，没有 OCR、图框内容识别、扫描歪斜校正或 CAD 制造合格判定。

## 下载文件

| 文件 | 用途 |
| --- | --- |
| `Jerrivell PDF_0.12.0_x64-setup.exe` | Windows x64 完整安装包 |
| `Jerrivell-PDF-0.12.0-source.zip` | 本版本项目源码与文档归档 |
| `JerrivellPDF-0.12.0-third-party-sources.zip` | 已登记的第三方对应源码补充，保留上游各自条款 |

请核对 Release 同附的 SHA-256 或清单。目标电脑需事先安装 [WebView2 Evergreen Runtime x64](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)；安装包不会自动下载它。升级前保存修改并正常退出旧版。

当前安装包未配置代码签名证书。PDFium 与相应法律资源随完整安装包交付，不需要另外复制 DLL。普通运行不需要 Rust、Node.js、Visual Studio 或开发服务器。

## 已完成的验证

本版本在发布者本机 Windows 环境完成 **33 组前端检查、80 项 Rust 测试、17 个对比 React 场景，以及构建后和安装后各 10 组原生流程**；另完成既有 5 组独立 PDF 输出检查和新旧报告检查。这些是本机发布验证，不是 GitHub Actions 或所有 Windows/打印机组合的认证。

原创合成样本中：同一图纸采用不同页面尺寸，在统一图幅模式的 150/300/600 DPI 下均为零差异；原始尺寸模式仍检出差异；已知新增细点保留 4 个变化像素。旋转、CropBox、逐页倍率、图像页、自动平移、取消保护、报告参考单位及模式恢复均有覆盖。没有上传用户图纸或把私有测试资料加入公开分发包。

## 许可与说明

原创代码、文档和合成样本采用 **MIT OR Apache-2.0**。第三方组件、Windows/WebView2 和字体分别保留其条款；请同时保留仓库中的许可原文和需要的第三方源码补充。

[历史 Jerrivell Releases](https://github.com/luxoep/JerrivellPDF/releases) 保留各自版本与原许可。0.4.1～0.7.0 自有代码采用 GPL-3.0-or-later；0.8.0 起采用 MIT OR Apache-2.0，不能用当前许可替换旧归档的条款。

安装和操作见 [快速开始](https://github.com/luxoep/JerrivellPDF/blob/main/docs/QUICK_START.zh-CN.md)，开发见 [从源码构建](https://github.com/luxoep/JerrivellPDF/blob/main/docs/BUILDING.zh-CN.md)。
