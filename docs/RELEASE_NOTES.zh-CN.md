<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF 0.13.0

本版新增 **图纸复核项目**。保存当前 A/B 页对的分析参数、忽略区、差异复核状态和备注，下次打开项目后继续核对。

## 本版重点

- 在对比工作区使用 **保存对比项目** 和 **打开对比项目**。.jvcmp 以本地文件引用、SHA-256 指纹、设置与复核记录保存当前页对。
- 重开时核验两张源图，再重新分析。软件恢复匹配的复核记录，定位下一处待复核差异。
- 原文件改名或移动时，可从本地重选字节相同的副本。发现内容变化时，旧复核信息只适用于原来的图纸，更新后的图纸可另建对比项目。
- 复核备注和标记随项目手动保存。图纸对比、项目读取和重算在本机执行。批量任务可继续使用批量 CSV。

## 下载

| 文件 | 用途 |
| --- | --- |
| Jerrivell.PDF_0.13.0_x64-setup.exe | Windows x64 安装包 |
| Jerrivell-PDF-0.13.0-source.zip | 项目源码与使用文档 |
| Jerrivell-PDF-0.13.0-user-guide.zip | 离线使用指南与许可说明 |
| JerrivellPDF-0.13.0-third-party-sources.zip | 已登记的第三方对应源码，保留各自许可 |
| Jerrivell-PDF-0.13.0-manifest.json | 版本来源、附件与 SHA-256 |
| SHA256SUMS.txt | 发布文件的 SHA-256 校验值 |

运行需要 [Microsoft Edge WebView2 x64 Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)。当前安装包未配置代码签名。安装前请核对 SHA-256；升级前保存工作并退出旧版本。

## 验证与许可

本机 Windows 前端检查、82 项 Rust 测试、18 个对比界面场景及最终构建后 10 组原生回归通过。复核项目的新场景包括重复分析保留备注、源文件更换保护和重开后续审。具体范围见 [发布验证](https://github.com/luxoep/JerrivellPDF/blob/v0.13.0/docs/VALIDATION.zh-CN.md)。

本版本原创代码和文档采用 MIT OR Apache-2.0。第三方材料保留各自许可。各历史发布版的适用许可见 [版本索引](https://github.com/luxoep/JerrivellPDF/blob/v0.13.0/docs/RELEASES.zh-CN.md)。

安装和操作见 [快速开始](https://github.com/luxoep/JerrivellPDF/blob/v0.13.0/docs/QUICK_START.zh-CN.md) 与 [图纸复核项目](https://github.com/luxoep/JerrivellPDF/blob/v0.13.0/docs/0.13.0-图纸复核项目.md)。
