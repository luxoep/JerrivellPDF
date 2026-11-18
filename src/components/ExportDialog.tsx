// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Check, ChevronLeft, ChevronRight, CircleAlert, Download, LoaderCircle, X } from 'lucide-react';
import { backend, errorMessage, pageReference, renderPage } from '../backend';
import { safePdfName } from '../documentTools';
import type { ExportPart, ExportReport, ExportResult } from '../documentTools';
import type { RenderedPage } from '../types';
import { useI18n } from '../i18n';
import './document-tools.css';

export function ExportDialog({ parts, onClose, onSaved, onBusyChange }: {
  parts: ExportPart[]; onClose: () => void; onSaved: (result: ExportResult) => void; onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const [report, setReport] = useState<ExportReport | null>(null);
  const [error, setError] = useState('');
  const [preparing, setPreparing] = useState(true);
  const [writing, setWriting] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [partIndex, setPartIndex] = useState(0), [pageIndex, setPageIndex] = useState(0);
  const [image, setImage] = useState<RenderedPage | null>(null), [imageError, setImageError] = useState('');
  const alive = useRef(true), pending = useRef(false), token = useRef('');
  const callbacks = useRef({ onClose, onSaved, onBusyChange }); callbacks.current = { onClose, onSaved, onBusyChange };
  const root = useRef<HTMLDivElement>(null);
  const planKey = JSON.stringify(parts.map(part => ({ name: part.name, pages: part.pages.map(pageReference) })));
  const currentPart = parts[partIndex] ?? parts[0];
  const index = Math.min(pageIndex, Math.max(0, currentPart.pages.length - 1));
  const page = currentPart.pages[index];
  useEffect(() => {
    alive.current = true; root.current?.querySelector<HTMLButtonElement>('[data-export-close]')?.focus();
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    let disposed = false; setPreparing(true); setReport(null); setError(''); callbacks.current.onBusyChange(true);
    void backend<ExportReport>('prepare_export', { parts: parts.map(part => ({ name: part.name, pages: part.pages.map(pageReference) })) }, 3).then(value => {
      if (disposed) { void backend('discard_export', { token: value.token }, 3).catch(() => {}); return; }
      token.current = value.token; setReport(value);
    }).catch(reason => { if (!disposed) setError(errorMessage(reason)); }).finally(() => { if (!disposed) { setPreparing(false); callbacks.current.onBusyChange(false); } });
    return () => { disposed = true; callbacks.current.onBusyChange(false); if (token.current) { void backend('discard_export', { token: token.current }, 3).catch(() => {}); token.current = ''; } };
  }, [planKey]);
  useEffect(() => {
    let disposed = false; setImage(null); setImageError('');
    if (page) void renderPage(page, 840).then(value => { if (!disposed) setImage(value); }).catch(reason => { if (!disposed) setImageError(errorMessage(reason)); });
    return () => { disposed = true; };
  }, [page]);
  const size = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  const close = () => { if (!pending.current) callbacks.current.onClose(); };
  const write = async () => {
    if (!report || preparing || pending.current || result) return;
    pending.current = true; setWriting(true); setError(''); callbacks.current.onBusyChange(true);
    try {
      let paths: string[];
      if (parts.length === 1) {
        const path = await save({ title: t('确认导出 PDF', 'Export reviewed PDF'), defaultPath: safePdfName(parts[0].name), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        if (!path) return; paths = [path];
      } else {
        const folder = await open({ directory: true, multiple: false, title: t('选择批量导出目录（已有同名文件不会覆盖）', 'Choose export folder (existing files are not overwritten)') });
        if (!folder || Array.isArray(folder)) return;
        paths = parts.map(part => `${folder.replace(/[\\/]$/, '')}\\${safePdfName(part.name)}`);
      }
      const value = await backend<ExportResult>('save_prepared_export', { token: report.token, paths }, 3);
      if (!alive.current) return;
      if (!value.failed) { token.current = ''; callbacks.current.onSaved(value); }
      else { setResult(value); setError(t(`已成功 ${value.succeeded} 个，失败 ${value.failed} 个；请查看每个输出结果。`, `${value.succeeded} files succeeded and ${value.failed} failed. Review the per-file results.`)); }
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (alive.current) setWriting(false); callbacks.current.onBusyChange(false); }
  };
  const riskLabels = report ? [
    t('页面重组会生成新 PDF；元数据、标签结构、内部链接和其他文档级结构不保证保留。', 'Page assembly creates a new PDF. Metadata, tags, internal link targets and document-level structures may change.'),
    ...(report.structures.annotationsAndLinks ? [t('来源选页包含批注或链接，请核对外观与交互。', 'Selected source pages contain annotations or links; review appearance and behavior.')] : []),
    ...(report.structures.bookmarks ? [t('来源包含书签，当前输出不保证保留目录。', 'Source bookmarks may not be retained.')] : []),
    ...(report.structures.attachments ? [t('来源包含附件，当前输出不保证保留附件。', 'Source attachments may not be retained.')] : []),
    ...(report.structures.forms ? [t('来源包含表单，字段、计算和填写行为不保证保留。', 'Form fields, calculations and interaction may not be retained.')] : []),
    ...(report.structures.signatures ? [t('来源含数字签名；原签名有效性不能随新输出保留。', 'Original digital signature validity cannot be retained in the new output.')] : []),
    ...(report.structures.protected ? [t('来源的加密设置不会继承到新输出。', 'Source encryption settings are not inherited.')] : []),
  ] : [];
  return <div className="dt-backdrop" onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && ['s', 'o', 'p', 'f'].includes(event.key.toLowerCase())) event.preventDefault(); if (event.key === 'Escape') close(); }}><div className="dt-modal export-review" ref={root} role="dialog" aria-modal="true" aria-labelledby="export-review-title">
    <header className="dt-header"><div><h2 id="export-review-title">{t('导出前预览与检查', 'Review before exporting')}</h2><p>{t('核对页数、顺序、文件大小与结构风险后保存。', 'Review page count, order, file size and structure risks before saving.')}</p></div><button data-export-close aria-label={t('关闭导出预览', 'Close export review')} onClick={close} disabled={writing}><X size={19}/></button></header>
    <div className="export-summary"><span>{t('文件', 'Files')}<b>{parts.length}</b></span><span>{t('总页数', 'Total pages')}<b>{parts.reduce((count, part) => count + part.pages.length, 0)}</b></span><span>{t('预计总大小', 'Estimated total size')}<b>{report ? size(report.totalBytes) : '—'}</b></span><p>{preparing ? <><LoaderCircle size={14} className="spin"/>{t('正在生成临时输出并检查…', 'Generating and checking temporary output…')}</> : t('大小来自当前方案的实际序列化；确认后写入这一份结果。', 'Size comes from the actual serialized plan. Confirmation writes these exact bytes.')}</p></div>
    <div className="export-body"><aside className="export-order"><label>{t('输出文件', 'Output file')}<select value={partIndex} disabled={writing} onChange={event => { setPartIndex(Number(event.target.value)); setPageIndex(0); }}>{parts.map((part, index) => <option key={index} value={index}>{index + 1}. {part.name} ({part.pages.length})</option>)}</select></label>
      {report && <p className="dt-muted">{t('当前文件', 'This file')} · {size(report.outputs[partIndex]?.bytes ?? 0)}</p>}
      <ol aria-label={t('输出页序', 'Output page order')}>{currentPart.pages.map((item, index) => <li key={`${item.id}-${index}`}><button className={index === pageIndex ? 'active' : ''} onClick={() => setPageIndex(index)}><b>{index + 1}</b><span>{item.sourceName}<small>{t(`来源第 ${item.pageIndex + 1} 页 · 旋转 ${item.rotation}°`, `Source page ${item.pageIndex + 1} · rotation ${item.rotation}°`)}</small></span></button></li>)}</ol>
    </aside><section className="export-preview"><div className="dt-preview-image">{image ? <img src={image.dataUrl} alt={t('当前导出页面预览', 'Export page preview')}/> : imageError ? <p className="dt-error">{imageError}</p> : <LoaderCircle size={25} className="spin"/>}</div><div className="dt-page-nav"><button disabled={index === 0} onClick={() => setPageIndex(index - 1)} aria-label={t('预览上一页', 'Preview previous page')}><ChevronLeft size={16}/></button><span>{index + 1} / {currentPart.pages.length}</span><button disabled={index >= currentPart.pages.length - 1} onClick={() => setPageIndex(index + 1)} aria-label={t('预览下一页', 'Preview next page')}><ChevronRight size={16}/></button></div></section>
    <aside className="export-risks"><h3><CircleAlert size={16}/>{t('可能丢失或改变的结构', 'Structures that may change')}</h3>{report && <p className="dt-muted">{t(`来源 ${report.structures.sourceCount} 份，书签 ${report.structures.bookmarks}，附件 ${report.structures.attachments}，签名 ${report.structures.signatures}，所选页批注/链接 ${report.structures.annotationsAndLinks}。`, `${report.structures.sourceCount} sources; ${report.structures.bookmarks} bookmarks; ${report.structures.attachments} attachments; ${report.structures.signatures} signatures; ${report.structures.annotationsAndLinks} page annotations/links.`)}</p>}<ul>{riskLabels.map((risk, index) => <li key={index}>{risk}</li>)}</ul><p className="dt-muted">{t('检查计数用于风险提示，不是 PDF 完整性认证。原文件保持不变。', 'Counts help identify risks and do not certify complete PDF preservation. Source files remain unchanged.')}</p></aside></div>
    {error && <div className="dt-error" role="alert">{error}</div>}{result && <ul className="dt-results">{result.results.map(item => <li key={item.path}>{item.success ? <Check size={13}/> : <CircleAlert size={13}/>}<span>{item.path}{item.error && ` · ${item.error}`}</span></li>)}</ul>}
    <footer className="dt-footer"><button className="button secondary" onClick={close} disabled={writing}>{t('返回编辑', 'Back to editing')}</button><button className="button primary" disabled={!report || preparing || writing || Boolean(result)} onClick={() => void write()}>{writing ? <LoaderCircle size={15} className="spin"/> : <Download size={15}/>} {t('确认导出', 'Confirm export')}</button></footer>
  </div></div>;
}
