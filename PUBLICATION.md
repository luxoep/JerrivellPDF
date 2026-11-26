<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Jerrivell PDF publication / 发布

[English](#english) · [简体中文](#简体中文) · [GitHub 0.15.1 release / 0.15.1 发布页](https://github.com/luxoep/JerrivellPDF/releases/tag/v0.15.1)

## English

Download the installer for Windows x64. Use the project source archive to build the tagged version and the user guide ZIP for the offline documentation captured at release. GitHub also provides its automatic source archive links. The versioned source package in the table below is the one covered by the release manifest and checksum list.

The Windows installer bundles the matching PDFium runtime and license notices. The source archive includes the app source, original synthetic test fixtures, lockfiles, build scripts, notices and public documentation. The build scripts fetch and verify the pinned PDFium runtime. The separate third-party source supplement provides the recorded corresponding source archives and upstream licenses for the covered components. [Build guide](docs/BUILDING.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

Compare a downloaded file's SHA-256 with `SHA256SUMS.txt`. The release manifest records the public Git revision and the checksums of the versioned artifacts. This PowerShell command checks the installer from the download folder.

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'Jerrivell.PDF_0.15.1_x64-setup.exe'
```

The 0.15.1 project's own code, documentation and original synthetic fixtures use **MIT OR Apache-2.0**. Third-party components keep their own terms. Earlier releases retain their original licenses. [License](LICENSE) · [MIT](LICENSE-MIT) · [Apache-2.0](LICENSE-APACHE) · [Release history](docs/RELEASES.md) · [Validation](docs/VALIDATION.md)

## 简体中文

Windows x64 用户可下载安装包。需要从发布标签构建时，下载版本源码包。需要离线阅读时，下载随该版本归档的使用指南。GitHub 发布页也会自动生成源码链接。下表的版本源码包对应本版的发布清单和校验清单。

安装包内含匹配的 PDFium 运行库和许可声明。源码包包含应用代码、原创合成测试样本、锁文件、构建脚本、许可声明和公开文档。构建脚本会获取并核验固定版本的 PDFium。第三方源码补充包单独提供已登记的对应源码归档和上游许可。[构建说明](docs/BUILDING.zh-CN.md) · [第三方声明](THIRD_PARTY_NOTICES.md)

下载后，将文件的 SHA-256 与 `SHA256SUMS.txt` 比对。发布清单记录公开 Git 提交及各版本文件的校验值。可以在下载目录按上面的 PowerShell 命令核对安装包。

0.15.1 的项目自有代码、文档和原创合成样本采用 **MIT OR Apache-2.0**。第三方组件沿用各自许可，历史版本沿用发布时附带的许可。[项目许可](LICENSE) · [MIT](LICENSE-MIT) · [Apache-2.0](LICENSE-APACHE) · [版本索引](docs/RELEASES.zh-CN.md) · [发布验证](docs/VALIDATION.zh-CN.md)

## 0.15.1 downloads / 下载文件

| File / 文件 | Use / 用途 |
| --- | --- |
| [Jerrivell.PDF_0.15.1_x64-setup.exe](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell.PDF_0.15.1_x64-setup.exe) | Windows x64 installer · Windows x64 安装包 |
| [Jerrivell-PDF-0.15.1-source.zip](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell-PDF-0.15.1-source.zip) | Versioned project source, lockfiles, build scripts and docs · 该版本的项目源码、锁文件、构建脚本和文档 |
| [Jerrivell-PDF-0.15.1-user-guide.zip](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell-PDF-0.15.1-user-guide.zip) | Offline user guide and license information for this release · 随该版本归档的离线使用指南和许可说明 |
| [JerrivellPDF-0.15.1-third-party-sources.zip](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/JerrivellPDF-0.15.1-third-party-sources.zip) | Recorded corresponding source for covered third-party components · 已登记的相关第三方组件对应源码 |
| [Jerrivell-PDF-0.15.1-manifest.json](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/Jerrivell-PDF-0.15.1-manifest.json) | Git revision, asset names and SHA-256 digests · Git 提交、附件名称和 SHA-256 校验值 |
| [SHA256SUMS.txt](https://github.com/luxoep/JerrivellPDF/releases/download/v0.15.1/SHA256SUMS.txt) | SHA-256 checksums for release files · 发布文件的 SHA-256 校验清单 |
