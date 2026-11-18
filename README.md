<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF

Jerry 的本地 PDF 工作台。一个面向 **Windows x64** 的独立开源桌面工具，使用 Rust、Tauri、React 与 PDFium，提供日常 PDF 阅读、页面整理、内容添加和机械图纸视觉对比。

An open-source, local PDF workspace for Windows, with document editing, page organization, and a separate drawing-comparison workspace.

## 下载与安装

**[下载最新版本](https://github.com/luxoep/JerrivellPDF/releases/latest)** · **[下载 0.12.0 Windows x64 安装包](https://github.com/luxoep/JerrivellPDF/releases/download/v0.12.0/Jerrivell%20PDF_0.12.0_x64-setup.exe)**

[历史 Jerrivell 版本](https://github.com/luxoep/JerrivellPDF/releases)也保留供下载；通常建议使用最新的 0.12.0。历史归档保留当时的许可：**0.4.1～0.7.0 自有代码为 GPL-3.0-or-later，0.8.0 起自有代码为 MIT OR Apache-2.0**。当前仓库许可不会追溯改写旧归档。

1. 准备 Windows x64 和 [Microsoft Edge WebView2 Evergreen Runtime（x64）](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)。安装包不附带、也不自动下载 WebView2。
2. 下载 Release 中的 `Jerrivell PDF_0.12.0_x64-setup.exe`，按向导安装。
3. 从开始菜单打开 **Jerrivell PDF**。普通使用不需要 Rust、Node.js、Visual Studio 或开发服务器。

当前为未配置代码签名证书的开发构建。请从本仓库 Release 获取文件，并核对随版本提供的 SHA-256。升级前保存 PDF 副本和可编辑项目，正常退出旧版后安装；安装器不自动替你修改 PDF 默认打开方式。

完整步骤见 [快速开始](docs/QUICK_START.zh-CN.md)。

## 主要功能

| 工作 | 已有能力 |
| --- | --- |
| 阅读与多文档 | 单窗口多选项卡、连续阅读、Ctrl+滚轮缩放、页面导航、可折叠侧栏、搜索，以及按 PDF 复制权限选择和复制文字 |
| 页面整理 | 拖动排序、旋转、删除、复制、空白页、合并/导入、提取与拆分、图片转 PDF、页码、水印和页面裁剪 |
| 添加与标记 | 鼠标拉出文字框并原位输入、图片、实心高亮、形状、线型、折线箭头和文字引导线；支持撤销/重做与可编辑项目 |
| 内容编辑 | 原有对象与文字行编辑、本机字体选择、局部图像裁切和擦除；具体可编辑程度取决于 PDF 的内部结构、文字层和字体 |
| 图章与片段 | 制作、导入、导出图章；从 PDF 多选区域制作独立图片片段，复用、拖放及叠加 |
| 打印与保存 | PDF 副本和可编辑项目分别保存；导出预检；打印纸张、彩色/黑白及自动/150/300/600 DPI 选择 |
| 图纸对比 | 独立工作区、单页和多页配对、150/300/600 DPI 视觉差分、区域与细点定位、自动/手动平移、忽略区、局部复核、PNG 与 CSV 报告 |
| 界面 | 简体中文与英文切换 |

## 0.12.0：统一图幅参与实际分析

对比窗口的 **“分析尺寸”默认“按统一图幅（推荐）”**：以 A 页为参考，将 B 页等比例适配并居中，然后再进行完整像素差分、配准、局部预览及多页处理。适用于数据库导出或打印来源不同、页面标称尺寸不同，但图纸位置和相对边距基本一致的 PDF。

- 长宽比不一致时保留比例、居中留白，不强行拉伸图纸。
- “各自适应窗口”只控制显示；“分析尺寸”决定实际比较方式。
- 如需把整体出图比例或纸张尺寸变化也作为差异，选择 **“按原始尺寸”**。
- 统一图幅中的“参考 mm”来自 A 页坐标，不能当作纸张或机械零件的真实尺寸测量。
- 此模式会归一整体打印比例变化；不同边距、扫描偏斜或被源文件裁掉的内容仍需另行处理。

完整步骤见 [快速开始中的图纸对比](docs/QUICK_START.zh-CN.md#图纸对比)。

## 本地处理与当前边界

完成安装和运行环境准备后，PDF 操作在本机执行；图纸对比不使用在线 OCR、云端 AI 或图纸上传服务，原始输入文件以只读快照参与对比。它使用独立进程与独立工作区，不复用主编辑器的页面编辑会话。

这不等同于整台电脑已经完成网络隔离或涉密系统认证。操作系统、云同步目录、打印机驱动和终端管理软件仍有各自行为；报告本身也可能含文档内容。

当前没有 OCR、扫描角度自动校正、CAD 对象拓扑或制造合格判定。自动配准目前只估计整体平移；文字与尺寸辅助只用于允许复制且能提取文字的页面。图章和手写签名图片不等同证书数字签名。不同字体、打印驱动、编码和采样密度会影响结果，请结合原图复核。

## 源码与构建

仓库包含应用源码、原创测试样本、构建脚本和第三方许可原文。安装包及可下载源码归档放在 [Releases](https://github.com/luxoep/JerrivellPDF/releases)。

开发需要 Windows MSVC/C++ 工具链、Windows SDK、Rust、Node.js/npm 和 WebView2。PDFium 由固定版本准备脚本下载并校验。详见 [从源码构建](docs/BUILDING.zh-CN.md)。

## 许可

Jerry 有权许可的原创代码、文档和合成样本使用 **MIT OR Apache-2.0**，可选择其一：

- [LICENSE](LICENSE)
- [MIT 全文](LICENSE-MIT)
- [Apache License 2.0 全文](LICENSE-APACHE)

第三方组件保留各自许可，参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [licenses/](licenses/)。Release 同时提供 [0.12.0 第三方对应源码补充](https://github.com/luxoep/JerrivellPDF/releases/download/v0.12.0/JerrivellPDF-0.12.0-third-party-sources.zip)；其中的 MPL 文件级组件、安装器组件和其他上游材料不改称项目自有许可。Windows、WebView2、用户文档和字体也有各自条款。

## 反馈

欢迎通过 [Issues](https://github.com/luxoep/JerrivellPDF/issues) 提供版本、系统环境和复现步骤。请使用原创合成或已获准公开的样本，避免提交业务图纸、私有文档、密钥或未经脱敏的诊断附件。
