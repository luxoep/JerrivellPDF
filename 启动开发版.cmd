@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请安装后重新打开此窗口。
  pause
  exit /b 1
)
where cargo >nul 2>nul
if errorlevel 1 (
  echo 未找到 Cargo。请安装 Rust MSVC 工具链后重新打开此窗口。
  pause
  exit /b 1
)
if not exist node_modules\@tauri-apps\cli\tauri.js (
  echo 请先在项目目录执行 npm ci 安装前端开发依赖。
  pause
  exit /b 1
)
if not exist src-tauri\resources\pdfium\bin\pdfium.dll (
  echo 请先执行 npm run setup:pdfium 准备 PDF 引擎。
  pause
  exit /b 1
)
echo 正在启动 Jerrivell PDF桌面开发版，首次编译可能需要较长时间。
echo 关闭本窗口或按 Ctrl+C 将停止开发服务。
call npm run tauri dev
if errorlevel 1 pause
