# 第三方许可原文集合

这些第三方文件各自适用其原始许可。Jerrivell PDF 自有代码的许可见根目录的 [LICENSE](../LICENSE)。

- `npm/`：从本机已安装、与 `package-lock.json` 对应的 npm 包复制的 LICENSE、NOTICE、COPYING、THIRD-PARTY-LICENSE 等原文。包含部分开发工具，便于一并审阅；不代表这些工具都被链接到最终应用。
- `rust/`：从 Cargo 注册表源代码缓存、与 `src-tauri/Cargo.lock` 对应的 crate 复制的相应原文。包含构建工具、开发和平台条件依赖。
- `upstream/`：发布到注册表的少数包没有携带完整许可文件。按包内 `.cargo_vcs_info.json` 标明的固定上游提交补取；标准 MPL 2.0 文本从 Mozilla 的官方地址取得。两个 npm 原生构建工具子包的许可来自同版本父包。还保留 NSIS 3.13 官方工具归档中的 COPYING 和 nsis_tauri_utils 0.5.3 固定提交的许可原文。
- `upstream-manifest.json`：补取文件的来源、所适用的组件和 SHA-256。
- `inventory.json`：锁文件哈希、确切包版本、包元数据、源代码定位信息、复制文件的 SHA-256 和收集状态。

PDFium 原始预编译包的独立声明保存在 `src-tauri/resources/pdfium/LICENSE` 和 `src-tauri/resources/pdfium/licenses/`，来源和二进制哈希见同目录 `aurapdf-runtime.json`。这些文件与运行库一起打包。

更新依赖后，从项目根目录执行以下命令重新收集本地原文（Python 3.11 及以上，不访问网络）：

```powershell
python scripts/collect-licenses.py
```

恢复已记录但缺少的补充许可原文可执行 `python scripts/fetch-license-supplements.py`。脚本会校验既有文件；确实需要恢复时只从已记录的官方地址取得文本，或从校验通过的工具归档中读取指定的许可文件，不执行归档中的程序。

脚本不会更改原始 npm/Cargo 缓存，也不会删除已有文件。上游补充文件会校验哈希；更新组件版本时需要重新核对对应补充记录。`not-in-local-source-cache` 表示锁文件记录没有下载到本机，并不等于应用缺失运行库，也不证明它一定没有进入其他平台产物。应结合该次实际目标、启用特性和分发文件核查。

收集结果是可追溯的原文与组件清单，不是对所有代码版权、二进制来源、许可兼容性或对应源代码交付完成度的自动法律审定。分发说明见 [PUBLICATION.md](../PUBLICATION.md)。
