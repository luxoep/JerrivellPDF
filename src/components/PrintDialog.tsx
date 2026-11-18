// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, Printer, X } from 'lucide-react';
import { backend, errorMessage, pageReference, renderPage } from '../backend';
import { useI18n } from '../i18n';
import { selectPrintIndices, validPrintCopies } from '../printing';
import type { PrintOptions, PrintResult, PrintScope, PrintSubset } from '../printing';
import type { RenderedPage, WorkspacePage } from '../types';
import './print-dialog.css';

export function PrintDialog({ pages, activeIndex, selectedIds, title, onClose, onBusyChange, onNotify }: {
  pages: WorkspacePage[]; activeIndex: number; selectedIds: ReadonlySet<string>; title: string;
  onClose: () => void; onBusyChange: (busy: boolean) => void;
  onNotify: (message: string, tone: 'success' | 'info' | 'error') => void;
}) {
  const { t } = useI18n();
  const [scope, setScope] = useState<PrintScope>(selectedIds.size ? 'selected' : 'all');
  const [range, setRange] = useState('');
  const [subset, setSubset] = useState<PrintSubset>('all');
  const [reverse, setReverse] = useState(false);
  const [scale, setScale] = useState<PrintOptions['scale']>('fit');
  const [orientation, setOrientation] = useState<PrintOptions['orientation']>('auto');
  const [copies, setCopies] = useState('1');
  const [previewAt, setPreviewAt] = useState(0);
  const [image, setImage] = useState<RenderedPage | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const callbacks = useRef({ onBusyChange, onClose, onNotify });
  callbacks.current = { onBusyChange, onClose, onNotify };
  const selection = useMemo(() => {
    try { return { indices: selectPrintIndices(pages, activeIndex, selectedIds, scope, range, subset, reverse), invalid: false }; }
    catch { return { indices: [], invalid: true }; }
  }, [pages, activeIndex, selectedIds, scope, range, subset, reverse]);
  const count = selection.indices.length;
  const position = Math.min(previewAt, Math.max(0, count - 1));
  const pageIndex = selection.indices[position];
  const page = pageIndex === undefined ? undefined : pages[pageIndex];
  const copyCount = validPrintCopies(copies);
  const canPrint = count > 0 && count <= 5000 && copyCount !== null && count * copyCount <= 10000 && !working;

  useEffect(() => {
    alive.current = true;
    const previouslyFocused = document.activeElement;
    root.current?.querySelector<HTMLButtonElement>('[data-print-close]')?.focus();
    return () => { alive.current = false; if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setImage(null); setPreviewError('');
    if (page) void renderPage(page, 700).then(value => { if (!cancelled) setImage(value); })
      .catch(reason => { if (!cancelled) setPreviewError(errorMessage(reason)); });
    return () => { cancelled = true; };
  }, [page]);

  async function submit() {
    if (!canPrint || workingRef.current || copyCount === null) return;
    workingRef.current = true; setWorking(true); setError(''); callbacks.current.onBusyChange(true);
    let completed = false;
    try {
      const result = await backend<PrintResult>('print_document', {
        pages: selection.indices.map(index => pageReference(pages[index])),
        options: { scale, orientation, copies: copyCount }, jobName: title || 'Jerrivell PDF',
      }, 3);
      if (!alive.current) return;
      if (result.status === 'printed') {
        completed = true;
        const submitted = t(`已将 ${result.pageCount} 页、${result.copies} 份提交到 Windows 打印队列。`, `Submitted ${result.pageCount} pages × ${result.copies} copies to the Windows print queue.`);
        callbacks.current.onNotify(submitted + (result.warnings?.length ? '\n' + result.warnings.join('\n') : ''), result.warnings?.length ? 'info' : 'success');
      } else callbacks.current.onNotify(t('已取消打印，文档未改变。', 'Printing cancelled. The document is unchanged.'), 'info');
    } catch (reason) {
      if (alive.current) setError(errorMessage(reason));
    } finally {
      workingRef.current = false;
      callbacks.current.onBusyChange(false);
      if (alive.current) { setWorking(false); if (completed) callbacks.current.onClose(); }
    }
  }

  return <div className="modal-backdrop print-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !working) onClose(); }}>
    <div ref={root} className="print-dialog" role="dialog" aria-modal="true" aria-labelledby="print-title" onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); event.stopPropagation(); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!working) onClose(); }
      if (event.key === 'Tab') {
        const elements = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []);
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header className="print-heading"><div><Printer size={21}/><div><h2 id="print-title">{t('打印与预览', 'Print and preview')}</h2><p>{title}</p></div></div><button data-print-close className="icon-button" onClick={onClose} disabled={working} aria-label={t('关闭打印预览', 'Close print preview')}><X size={19}/></button></header>
      <div className="print-body">
        <div className="print-settings"><fieldset disabled={working}>
          <label>{t('打印范围', 'Pages')}<select value={scope} onChange={event => { setScope(event.target.value as PrintScope); setPreviewAt(0); }}>
            <option value="all">{t(`全部 ${pages.length} 页`, `All ${pages.length} pages`)}</option>
            <option value="current">{t(`当前第 ${activeIndex + 1} 页`, `Current page (${activeIndex + 1})`)}</option>
            <option value="selected" disabled={!selectedIds.size}>{t(`已选择的 ${selectedIds.size} 页`, `${selectedIds.size} selected pages`)}</option>
            <option value="range">{t('指定页码范围', 'Custom page range')}</option>
          </select></label>
          {scope === 'range' && <label>{t('页码范围', 'Page range')}<input autoFocus value={range} placeholder="1-3,5" onChange={event => { setRange(event.target.value); setPreviewAt(0); }} aria-invalid={selection.invalid}/></label>}
          {selection.invalid && <p className="print-error" role="alert">{t(`请输入 1～${pages.length} 内的页码，例如 1-3,5。`, `Enter page numbers between 1 and ${pages.length}, such as 1-3,5.`)}</p>}
          <label>{t('奇偶页', 'Page subset')}<select value={subset} onChange={event => { setSubset(event.target.value as PrintSubset); setPreviewAt(0); }}><option value="all">{t('全部', 'All')}</option><option value="odd">{t('仅奇数页', 'Odd pages only')}</option><option value="even">{t('仅偶数页', 'Even pages only')}</option></select></label>
          <label className="print-checkbox"><input type="checkbox" checked={reverse} onChange={event => { setReverse(event.target.checked); setPreviewAt(0); }}/>{t('倒序打印', 'Reverse page order')}</label>
          <label>{t('缩放方式', 'Scaling')}<select value={scale} onChange={event => setScale(event.target.value as PrintOptions['scale'])}><option value="fit">{t('适合可打印区域', 'Fit printable area')}</option><option value="actual">{t('实际尺寸（100%）', 'Actual size (100%)')}</option></select></label>
          {scale === 'actual' && <p className="print-hint">{t('页面超过纸张可打印区域时，边缘内容可能被裁切。', 'Page edges may be clipped if the page exceeds the printable area.')}</p>}
          <label>{t('纸张方向', 'Orientation')}<select value={orientation} onChange={event => setOrientation(event.target.value as PrintOptions['orientation'])}><option value="auto">{t('跟随每页方向', 'Match each page')}</option><option value="portrait">{t('纵向', 'Portrait')}</option><option value="landscape">{t('横向', 'Landscape')}</option></select></label>
          <label>{t('打印份数', 'Copies')}<input type="number" min="1" max="99" step="1" value={copies} onChange={event => setCopies(event.target.value)} aria-invalid={copyCount === null}/></label>
          {(copyCount === null || (copyCount !== null && count * copyCount > 10000)) && <p className="print-error">{t('份数须为 1～99，单次最多输出 10000 张。', 'Use 1–99 copies and at most 10,000 output pages per job.')}</p>}
          <p className="print-hint">{t('页码按当前工作区顺序计算；份数与逐份选项以系统打印窗口为准。打印包含尚未保存的新增内容。', 'Page numbers follow this workspace. The system print dialog determines copies and collation. Unsaved added content is included.')}</p>
        </fieldset></div>
        <section className="print-preview" aria-label={t('页面内容预览', 'Page content preview')}>
          <div className="print-preview-stage">{page ? image ? <img src={image.dataUrl} alt={t(`打印预览：工作区第 ${pageIndex + 1} 页`, `Print preview: workspace page ${pageIndex + 1}`)}/> : previewError ? <div className="print-preview-empty"><CircleAlert/><p>{previewError}</p></div> : <LoaderCircle className="spin"/> : <p>{t('没有符合条件的页面。', 'No pages match these settings.')}</p>}</div>
          <div className="print-preview-navigation"><button className="icon-button" disabled={working || position === 0} onClick={() => setPreviewAt(position - 1)} aria-label={t('预览上一张', 'Preview previous sheet')}><ChevronLeft size={17}/></button><span>{count ? `${position + 1} / ${count}` : '0 / 0'}{page && ` · ${t(`第 ${pageIndex + 1} 页`, `Page ${pageIndex + 1}`)}`}</span><button className="icon-button" disabled={working || position >= count - 1} onClick={() => setPreviewAt(position + 1)} aria-label={t('预览下一张', 'Preview next sheet')}><ChevronRight size={17}/></button></div>
          <p className="print-hint">{t('此处预览页面内容。纸张、双面与彩色等选项在系统打印机属性中设置，最终排版以所选打印机为准。', 'This previews page content. Set paper, duplex and color in system printer properties; final layout depends on the selected printer.')}</p>
        </section>
      </div>
      <footer className="print-footer"><div>{error ? <p className="print-error" role="alert">{error}</p> : working ? <p role="status"><LoaderCircle size={14} className="spin"/>{t('请在系统打印窗口中继续或取消…', 'Continue or cancel in the system print window…')}</p> : <p>{t(`已选 ${count} 页`, `${count} pages selected`)}</p>}</div><button className="button secondary" disabled={working} onClick={onClose}>{t('取消', 'Cancel')}</button><button className="button primary" disabled={!canPrint} onClick={() => void submit()}><Printer size={16}/>{t('选择打印机并打印', 'Choose printer and print')}</button></footer>
    </div>
  </div>;
}
