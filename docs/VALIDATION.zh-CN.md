<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF 0.15.1 发布验证

[English](VALIDATION.md)

本记录对应 Windows x64 的 [v0.15.1 发布](https://github.com/luxoep/JerrivellPDF/releases/tag/v0.15.1)，适用于该标签和安装包。发布后 `main` 上的文档可以继续更新。

本机 Windows 发布检查通过 **33 组前端检查、89 项 Rust 测试和 10 组原生联动测试**。检查同时覆盖 Windows 依赖许可、生产构建、NSIS 打包和产物校验值。复现命令见[构建说明](BUILDING.zh-CN.md)。

## 核验范围

| 核验项 | 检查内容 |
| --- | --- |
| 片段导出 | 剪切特征、换色并移动。预览、导出并重新打开完整的三页 PDF，核对 PNG 导出与预览一致。 |
| 原文编辑线型 | 使用多内容流的合成图纸，核对拖动预览、编辑文字和保存重开后的实线与点划线。导出剪切片段后，检查选区外的线型。 |
| 图形兼容性 | 编辑相邻文字，保存重开后核对位于其他内容流中的渐变与内嵌图像。 |
| 可编辑项目 | 重开 `.jvp`，继续编辑并保存原有片段。核对原 PDF 的文件内容未受影响。 |
| 公开归档 | 源码归档、安装包、指南、第三方对应源码和 SHA-256。 |

公开源码归档包含原创合成测试样本及生成线型样本的测试代码。[下载安装包、源码、指南、第三方对应源码和校验文件](https://github.com/luxoep/JerrivellPDF/releases/tag/v0.15.1)
