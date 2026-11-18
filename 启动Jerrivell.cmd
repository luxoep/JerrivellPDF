@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0release\jerrivell-app\jerrivell-pdf.exe" (
  start "" "%~dp0release\jerrivell-app\jerrivell-pdf.exe"
  exit /b 0
)
if exist "%~dp0src-tauri\target\release\jerrivell-pdf.exe" (
  start "" "%~dp0src-tauri\target\release\jerrivell-pdf.exe"
  exit /b 0
)
echo 尚未找到编译后的 Jerrivell PDF。
echo 请先安装 release 中的新安装包，或在本目录执行 npm run build:desktop。
echo 开发调试请双击“启动开发版.cmd”。
echo 详细说明见 docs\QUICK_START.zh-CN.md。
pause
exit /b 1
