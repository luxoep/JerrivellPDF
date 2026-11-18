<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# 从源码构建 Jerrivell PDF

目标平台为 Windows x64。以下命令在 PowerShell 的仓库根目录执行。普通用户直接安装 Release，无需准备开发工具。

## 环境

| 组件 | 要求与用途 |
| --- | --- |
| Git | 取得源码 |
| Node.js / npm | 锁定 Vite 工具链要求 Node 满足 `^20.19.0 || >=22.12.0`；用于前端依赖和本地 Tauri CLI |
| Rust / Cargo | 安装 MSVC 主机工具链；仓库 `rust-toolchain.toml` 固定为 Rust 1.99.1，并声明 rustfmt/clippy |
| MSVC C++ / Windows SDK | Visual Studio 或 Build Tools 的“使用 C++ 的桌面开发”组件，包含 x64 编译/链接工具和 Windows SDK |
| WebView2 Runtime x64 | 运行桌面界面；安装包配置不会自动补装它 |
| PDFium Windows x64 | 由项目准备脚本取得固定 `chromium/7881` 版本并检查 SHA-256 |
| Python 3.11+（维护用） | 收集许可、准备对应源码归档、校验发布包；普通安装运行不需要 |

Rust、Node、编译工具链和依赖首次准备通常需要联网。应用安装后的 PDF 本地处理，与“在完全未准备的机器上离线构建”是两回事。

## 首次准备

```powershell
git clone https://github.com/luxoep/JerrivellPDF.git
Set-Location JerrivellPDF
npm ci
npm run setup:pdfium
cargo fetch --locked --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml
```

`npm ci` 使用 `package-lock.json`，Cargo 使用 `src-tauri/Cargo.lock`。PDFium 准备脚本从固定来源下载归档，核对 SHA-256，并在 `src-tauri/resources/pdfium/` 保留运行库与上游许可。不要随意换成其他 ABI、架构或未知来源 DLL。

许可门禁使用离线 Cargo 依赖图，因此首次运行完整门禁前先执行 `cargo fetch`。构建环境若需要完全离线，应提前缓存 npm、Cargo、PDFium、Tauri/NSIS 构建材料，并安装系统工具与 WebView2；缺少的材料不会自动从本地源码产生。

## 开发启动

```powershell
npm run tauri dev
```

该命令自动启动 Vite、编译 Rust 并打开桌面窗口。开发服务绑定本机 `127.0.0.1:1420`。结束前保存修改，在终端按 `Ctrl+C` 停止。

```powershell
npm run dev
```

单独启动 Vite 只能检查网页界面；普通浏览器没有 PDF 原生后端和 Windows 文件对话框能力。开发和调试应使用原创或获准公开的样本。

## 检查与打包

```powershell
npm run check
npm run test:frontend
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run build:desktop
```

`npm run build:desktop` 是完整桌面发布门禁：许可策略检查、前端行为检查、Rust 测试、前端生产构建、Tauri/NSIS 打包，以及构建后的真实原生联动。全部通过后在 `test-results/<版本>/release-gate.json` 写入结果与摘要。

产物位置：

| 路径 | 内容 |
| --- | --- |
| `src-tauri/target/release/bundle/nsis/` | Windows x64 安装包 |
| `src-tauri/target/release/jerrivell-pdf.exe` | 原生程序；跨电脑部署仍应使用完整安装包 |
| `dist/` | 前端生产构建，不能替代桌面安装包 |
| `test-results/<版本>/` | 构建与测试结果，不应提交用户图纸或私有测试资料 |

`npm run build` 只构建前端。首次 Rust release 优化可能耗时较长，请等待当前任务完成，避免反复启动并行构建。

## 许可与分发材料

已有 `licenses/`、`THIRD_PARTY_NOTICES.md` 和锁文件属于分发材料。修改依赖、锁文件或 PDFium 版本后，需要重新检查实际 Windows 依赖闭包、许可原文和来源，而不只是改包版本。

可用的维护脚本：

```powershell
python scripts/collect-licenses.py
node scripts/check-license-policy.mjs
python scripts/package-copyleft-sources.py --download-missing
```

`collect-licenses.py` 从本机依赖缓存收集实际原文；首次维护前应已准备 npm/Cargo 缓存。第三方源码准备脚本按固定版本和校验值处理已登记的 MPL 文件级组件及 NSIS 来源。`--download-missing` 在缺少精确归档时需要网络。

原有 `scripts/package-release.ps1` 受发布门禁约束，用于整理安装包、源码和清单；`scripts/verify-release.py` 还会核对本机安装副本，不能在没有相应安装目录时把它当作单纯源码检查。公开发布前需要单独核对待上传文件、校验值及私有材料排除情况。

## 测试范围

标准门禁的原生联动不提交实体打印任务。打印光栅可显式检查：

```powershell
node tests/native-printing.mjs --raster-only
```

浏览器交互和独立 PDF 输出检查位于 `tests/`，部分需要额外配置开发用 Python、浏览器、pypdf、Pillow 或 Poppler。这些不是桌面应用运行依赖；公开仓库不包含开发机的环境缓存或私有测试结果。发布说明中的本机测试数字不代表已经配置 GitHub Actions。

## 排错

- `npm` / `cargo` 不存在：安装相应工具并重开终端检查 PATH。
- linker 或 SDK 缺失：检查 MSVC x64 与 Windows SDK 组件。
- 1420 端口占用：关闭已有开发任务，再重启；不要只改 Vite 或 Tauri 配置中的一处。
- PDFium 资源缺失：重新运行 `npm run setup:pdfium` 并核对脚本结果。
- 许可门禁报告锁文件摘要不符：先核实依赖变更和许可来源，再重新收集清单，不要跳过门禁。
