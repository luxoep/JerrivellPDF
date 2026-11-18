import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export type Language = 'zh-CN' | 'en-US';
const storageKey = 'rivuleaf.language';
function readLanguage(): Language {
  try { return localStorage.getItem(storageKey) === 'en-US' ? 'en-US' : 'zh-CN'; } catch { return 'zh-CN'; }
}
let activeLanguage: Language = readLanguage();

const english: Record<string, string> = {
  'PDF 文档': 'PDF documents', '取消打开': 'Cancel opening', '这份文档已加密': 'This document is encrypted',
  '输入打开密码，继续处理': 'Enter the opening password to continue with', '文档密码': 'Document password',
  '取消': 'Cancel', '打开文档': 'Open document', '请在 Jerrivell PDF 桌面应用中打开文档。': 'Open documents in the Jerrivell PDF desktop app.',
  'PDF 工作进程已重启，当前工作区已清空。未保存的页面调整需要重新操作；请重新打开 PDF。': 'The PDF worker restarted and this workspace was cleared. Reopen the PDF and repeat any unsaved changes.',
  '正在处理文档，请等待操作完成后退出。': 'A document operation is running. Wait for it to finish before exiting.',
  '请选择 PDF 格式的文档。': 'Choose a PDF document.', '正在添加文档…': 'Importing documents…', '正在打开文档…': 'Opening documents…',
  '密码不正确，请重试或取消此文件。': 'Incorrect password. Try again or cancel this file.',
  '文档包含处理提示，请查看顶部的文档提示。': 'Review the document notices before saving a copy.',
  '添加 PDF 到当前文档': 'Import and merge PDF pages', '打开 PDF 文档': 'Open PDF documents', '保存 PDF 副本': 'Save a PDF copy',
  '文档': 'Document', '请选择新的文件名保存副本，以保留正在使用的原始文档。': 'Choose a new file name to keep the open source documents intact.',
  '正在保存副本…': 'Saving a copy…', '导出当前页为 PNG': 'Export the current page as PNG', 'PNG 图片': 'PNG images',
  '正在导出当前页…': 'Exporting the current page…', '文档至少需要保留一页。': 'Keep at least one page in the document.',
  '主导航': 'Main navigation', 'Jerrivell PDF': 'Jerrivell PDF', '打开 PDF · Ctrl+O': 'Open PDF · Ctrl+O',
  '打开': 'Open', '页面工作台': 'Page workspace', '页面': 'Pages', '查找文字 · Ctrl+F': 'Find text · Ctrl+F',
  '查找': 'Find', '键盘快捷键': 'Keyboard shortcuts', '快捷键': 'Shortcuts', '你的 PDF 工作台': 'Your PDF workspace',
  '有未保存的修改': 'Unsaved changes', '副本已保存': 'Copy saved', '原始文档': 'Original document', '页': 'pages',
  '个来源': 'sources', 'Jerry 的本地 PDF 工作台': 'Your local PDF workspace', '添加 PDF · Ctrl+Shift+O': 'Import PDF · Ctrl+Shift+O',
  '添加 PDF': 'Import PDF', '保存副本 · Ctrl+S': 'Save copy · Ctrl+S', '保存副本': 'Save copy',
  '本地处理 · 文件不上传': 'Local processing · No uploads', 'PDF 引擎暂不可用。': 'The PDF engine is unavailable.',
  '重新检测': 'Check again', '为文档留一点呼吸的空间': 'A little room for your documents', '从一份 PDF 开始': 'START WITH A PDF',
  '每一页，': 'Every page,', '都在掌控之中': 'in your hands', '阅读、搜索、整理与合并。': 'Read, find, organize and merge.',
  '把繁琐留给工具，把专注留给自己。': 'Leave the routine to your tools. Keep your focus.', '打开 PDF': 'Open PDF',
  '或将文件拖到这里，也可以一次打开多份': 'Or drop files here. You can open several at once.', '让文档井然有序': 'Bring your documents into order',
  '工作台能力': 'Workspace features', '页面，自由组合': 'Pages, arranged your way', '拖动排序、旋转与删除，多份文档轻松合一。': 'Reorder, rotate and remove pages. Bring PDFs together.',
  '阅读，找到重点': 'Read and find what matters', '清晰预览、文字搜索，一步跳转到目标页面。': 'Clear previews and text search take you to the right page.',
  '文件，留在本地': 'Files stay on your device', '离线处理并保存副本，让原始文件安心保留。': 'Work locally and save a copy while keeping your originals.',
  '正在准备工作台…': 'Preparing your workspace…', '工作台已就绪': 'Workspace ready', '等待桌面环境': 'Desktop app required',
  '撤销 · Ctrl+Z': 'Undo · Ctrl+Z', '撤销': 'Undo', '重做 · Ctrl+Shift+Z': 'Redo · Ctrl+Shift+Z', '重做': 'Redo',
  '顺时针旋转 · R': 'Rotate clockwise · R', '旋转': 'Rotate', '删除选中页面 · Delete': 'Remove selected pages · Delete', '删除': 'Remove',
  '已选择': 'Selected', '清除选择': 'Clear selection', '将当前页面导出为 PNG 图片': 'Export the current page as PNG', '导出本页': 'Export page',
  '查看文档提示': 'View document notices', '取消全选': 'Deselect all', '选择全部': 'Select all',
  '前移选中页 · Alt+↑': 'Move selected pages earlier · Alt+↑', '前移选中页': 'Move earlier',
  '后移选中页 · Alt+↓': 'Move selected pages later · Alt+↓', '后移选中页': 'Move later', '拖动页面调整顺序': 'Drag pages to reorder',
  '查找文档中的文字': 'Find text in the document', '清空查找': 'Clear search', '正在查找…': 'Searching…', '找到你需要的内容': 'Find what you need',
  '搜索文档内的文字，点击结果跳转到对应页面。': 'Search the text layer, then select a result to open its page.',
  '扫描图片中的文字暂不支持识别': 'Scanned images need OCR, which is not available yet', '在': 'Found on', '页中找到': 'pages:', '处结果': 'matches',
  '第': 'Page', '处': 'matches', '没有找到匹配文字': 'No matching text', '试试更短的关键词，或检查文档是否为扫描图片。': 'Try a shorter query or check whether this PDF contains scanned images.',
  '这一页未能加载': 'This page could not be loaded', '正在呈现第': 'Rendering page', '上一页': 'Previous page', '上一页 · ←': 'Previous page · ←',
  '页码': 'Page number', '下一页': 'Next page', '下一页 · →': 'Next page · →', '缩小': 'Zoom out', '缩小 · Ctrl+-': 'Zoom out · Ctrl+-',
  '恢复 100%': 'Reset to 100%', '放大': 'Zoom in', '放大 · Ctrl++': 'Zoom in · Ctrl++', '适合宽度 · Ctrl+0': 'Fit width · Ctrl+0', '适宽': 'Fit width',
  '本地处理': 'Local processing', '修改尚未保存': 'Changes not saved', '就绪': 'Ready', 'R 旋转 · Delete 删除 · Ctrl+S 保存副本': 'R Rotate · Delete Remove · Ctrl+S Save copy',
  '松开，添加到当前文档': 'Drop to import into this document', '松开，打开你的 PDF': 'Drop to open your PDFs',
  '新页面将添加在文档末尾': 'New pages are appended to the document', '支持同时打开多份 PDF，按顺序合并': 'Open several PDFs and merge them in order',
  '关闭提示': 'Dismiss message', '退出前保存这次修改？': 'Save your changes before exiting?',
  '未保存的页面调整将在退出后丢失。原始 PDF 文件始终保留，你也可以先把调整保存为副本。': 'Unsaved changes will be lost when you exit. Your original files stay intact. Save a copy to keep this arrangement.',
  '保存副本并退出': 'Save copy and exit', '不保存，退出': 'Exit without saving', '继续编辑': 'Continue editing', '先保留这次修改？': 'Keep your changes first?',
  '当前文档有未保存的页面调整。打开新的文档前，可以先将它保存为副本。': 'This document has unsaved changes. Save a copy before opening a different workspace.',
  '保存副本并打开': 'Save copy and open', '不保存，继续打开': 'Open without saving', '返回文档': 'Back to document',
  '关闭快捷键': 'Close shortcuts', '让操作更顺手': 'Work a little faster', '几个熟悉的按键，让整理文档更从容。': 'Familiar shortcuts make organizing documents easier.',
  '查找文字': 'Find text', '撤销 / 重做': 'Undo / Redo', '选择全部页面': 'Select all pages', '旋转 / 删除页面': 'Rotate / Remove pages',
  '前移 / 后移页面': 'Move pages earlier / later', '上一页 / 下一页': 'Previous / Next page', '放大 / 缩小': 'Zoom in / out', '适合宽度': 'Fit width',
  '按住 Ctrl 点击缩略图可多选，按住 Shift 可连续选择。': 'Ctrl-click thumbnails to select several pages; Shift-click to select a range.',
  '关闭文档提示': 'Close document notices', '文档处理提示': 'Document notices', '保存副本前，请确认这些提示符合你的使用需求。': 'Review these limitations before saving a copy.',
  '我知道了': 'Got it',
  '页面另存为新 PDF；原文件保持不变。书签、附件、交互表单、加密和数字签名不保证保留。': 'Pages are saved as a new PDF. Source files stay intact. Bookmarks, attachments, interactive forms, encryption and digital signatures may not be preserved.',
  '此文件包含数字签名；页面编辑另存不能保留原签名有效性。': 'This file contains digital signatures. A reorganized copy cannot retain their original validity.',
  '操作未完成，请重试。': 'The operation did not finish. Try again.',
  'PDF 服务状态异常，请重启应用。': 'The PDF service is unavailable. Restart the app.',
  '页面索引超出来源文件范围。': 'The page number is outside the source document.',
  '请选择非空 PDF 文件；当前单个文件上限为 256 MiB。': 'Choose a nonempty PDF. The current per-file limit is 256 MiB.',
  '当前最多同时打开 32 个来源文件，请先关闭工作区。': 'A workspace can contain up to 32 source files. Open a new workspace first.',
  '已打开文件总大小超过 512 MiB，请先关闭工作区。': 'The source files exceed the 512 MiB workspace limit. Open a new workspace first.',
  '当前页面没有可导出的内容。': 'There is no page to export.',
};

export function translate(zh: string, en?: string): string {
  if (activeLanguage === 'zh-CN') return zh;
  if (en !== undefined) return en;
  if (english[zh] !== undefined) return english[zh];
  let m: RegExpMatchArray | null;
  if ((m = zh.match(/^取消选择第 (\d+) 页$/))) return `Deselect page ${m[1]}`;
  if ((m = zh.match(/^选择第 (\d+) 页$/))) return `Select page ${m[1]}`;
  if ((m = zh.match(/^转到第 (\d+) 页$/))) return `Go to page ${m[1]}`;
  if ((m = zh.match(/^第 (\d+) 页缩略图$/))) return `Page ${m[1]} thumbnail`;
  if ((m = zh.match(/^文档第 (\d+) 页$/))) return `Document page ${m[1]}`;
  if ((m = zh.match(/^正在打开文档 (\d+) \/ (\d+)…$/))) return `Opening document ${m[1]} / ${m[2]}…`;
  if ((m = zh.match(/^(.+) 没有可显示的页面。$/))) return `${m[1]} has no displayable pages.`;
  if ((m = zh.match(/^已添加 (\d+) 页，保存副本后合并为一个 PDF。$/))) return `Imported ${m[1]} pages. Save a copy to merge them into one PDF.`;
  if ((m = zh.match(/^已保存 (\d+) 页 · (.+)$/))) return `Saved ${m[1]} pages · ${m[2]}`;
  if ((m = zh.match(/^第 (\d+) 页已导出为 PNG。$/))) return `Page ${m[1]} exported as PNG.`;
  if ((m = zh.match(/^已删除 (\d+) 页，可撤销。$/))) return `Removed ${m[1]} pages. You can undo this.`;
  if ((m = zh.match(/^(\d+) 页已选中$/))) return `${m[1]} pages selected`;
  if ((m = zh.match(/^退出保护未能启用：(.+)$/))) return `Exit protection could not start: ${translate(m[1])}`;
  if ((m = zh.match(/^未能退出应用：(.+)$/))) return `Could not close the app: ${translate(m[1])}`;
  if ((m = zh.match(/^(.+)_已整理\.pdf$/))) return `${m[1]}_organized.pdf`;
  if ((m = zh.match(/^(.+)_第(\d+)页\.png$/))) return `${m[1]}_page-${m[2]}.png`;
  if (zh.startsWith('SESSION_INVALIDATED:')) return 'The PDF session is no longer available. Reopen the document.';
  if (zh.startsWith('PASSWORD_REQUIRED:')) return 'This PDF requires the correct opening password.';
  // Preserve engine-provided diagnostic details rather than guessing at their meaning.
  return zh;
}

type I18nValue = { language: Language; setLanguage: (language: Language) => void; t: typeof translate };
const I18nContext = createContext<I18nValue>({ language: activeLanguage, setLanguage: () => {}, t: translate });
export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, updateLanguage] = useState<Language>(activeLanguage);
  const setLanguage = (next: Language) => {
    activeLanguage = next;
    try { localStorage.setItem(storageKey, next); } catch { /* The current session can still change language. */ }
    updateLanguage(next);
  };
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  return <I18nContext.Provider value={{ language, setLanguage, t: translate }}>{children}</I18nContext.Provider>;
}
export function useI18n() { return useContext(I18nContext); }
