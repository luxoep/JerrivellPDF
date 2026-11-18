// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo, useRef, useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { ArrowDown, ArrowUp, Check, Crop, FilePlus2, Files, ImagePlus, LoaderCircle, Scissors, Stamp, Type, X } from 'lucide-react';
import { backend, errorMessage, pageReference } from '../backend';
import { duplicatePage, numberedPages, splitPlan } from '../documentTools';
import type { ExportPart, GenerateRequest } from '../documentTools';
import type { DocumentInfo, WorkspacePage } from '../types';
import { parsePageRange } from '../pageRanges';
import { FontPicker } from './FontPicker';
import { DEFAULT_FONT_FAMILY } from './overlayCanvas';
import { PageToolPreview } from './PageToolPreview';
import { useI18n } from '../i18n';
import './document-tools.css';

type Tab = 'blank' | 'duplicate' | 'images' | 'split' | 'number' | 'watermark' | 'crop';
const PT_PER_MM = 72 / 25.4;
export function PageToolsDialog({ pages, activeIndex, selectedIds, title, onClose, onPlan, onGenerated, onExport, onBusyChange }: {
  pages: WorkspacePage[]; activeIndex: number; selectedIds: ReadonlySet<string>; title: string; onClose: () => void;
  onPlan: (pages: WorkspacePage[]) => void; onGenerated: (document: DocumentInfo, replaceIds: string[] | null, insertAt: number) => void;
  onExport: (parts: ExportPart[]) => void; onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const modal=useRef<HTMLDivElement>(null);
  useEffect(()=>{modal.current?.focus();},[]);
  const [tab, setTab] = useState<Tab>(pages.length ? 'blank' : 'images');
  const [scope, setScope] = useState<'current' | 'all' | 'selected' | 'range'>(selectedIds.size ? 'selected' : 'current');
  const [range, setRange] = useState(''), [position, setPosition] = useState('after');
  const [paper, setPaper] = useState('a4'), [width, setWidth] = useState('210'), [height, setHeight] = useState('297'), [count, setCount] = useState('1');
  const [imagePaths, setImagePaths] = useState<string[]>([]), [imagePaper, setImagePaper] = useState<'a4' | 'original'>('a4'), [margin, setMargin] = useState('10');
  const [copies, setCopies] = useState('1');
  const [splitMode, setSplitMode] = useState<'every' | 'each' | 'oddEven' | 'ranges'>('every'), [splitEvery, setSplitEvery] = useState('1'), [splitRanges, setSplitRanges] = useState(''), [prefix, setPrefix] = useState(title.replace(/\.pdf$/i, '') || 'document');
  const [numberText, setNumberText] = useState('{page} / {total}'), [watermarkText, setWatermarkText] = useState(t('内部资料', 'INTERNAL'));
  const [start, setStart] = useState('1'), [fontSize, setFontSize] = useState('12'), [markFontSize, setMarkFontSize] = useState('42');
  const [useLocalFont, setUseLocalFont] = useState(false), [font, setFont] = useState(DEFAULT_FONT_FAMILY);
  const [color, setColor] = useState('#667085'), [opacity, setOpacity] = useState(20), [angle, setAngle] = useState('-30'), [placement, setPlacement] = useState('bottom-center');
  const [crop, setCrop] = useState({ x: 0.05, y: 0.05, width: .9, height: .9 });
  const [previewReady,setPreviewReady]=useState(true);
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), alive = useRef(true), callbacks = useRef({ onPlan, onGenerated, onExport, onBusyChange }); callbacks.current = { onPlan, onGenerated, onExport, onBusyChange };
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onBusyChange(false); }; }, []);
  const targets = useMemo(() => {
    try {
      if (scope === 'all') return pages;
      if (scope === 'selected') return pages.filter(page => selectedIds.has(page.id));
      if (scope === 'range') return parsePageRange(range, pages.length).map(index => pages[index]);
      return pages[activeIndex] ? [pages[activeIndex]] : [];
    } catch { return []; }
  }, [pages, activeIndex, selectedIds, scope, range]);
  const watermark = tab === 'watermark';
  const draftPlan = useMemo(() => {
    if (tab !== 'number' && tab !== 'watermark') return { pages, valid: true };
    try {
      const size = Number(watermark ? markFontSize : fontSize), distance = Number(margin), first = Number(start), rotation = Number(angle);
      if (!Number.isFinite(size) || size < 1 || size > 512 || !Number.isFinite(distance) || distance < 0 || distance > 50 || !Number.isInteger(first) || first < 0 || first > 999999 || !Number.isFinite(rotation) || rotation < -180 || rotation > 180) throw new Error('PARAMS');
      return { pages: numberedPages(pages, new Set(targets.map(page => page.id)), { kind: watermark ? 'watermark' : 'number', template: watermark ? watermarkText : numberText, start: first, fontSize: size, fontFamily: watermark || useLocalFont ? font : null, color, opacity: watermark ? opacity / 100 : 1, angle: watermark ? rotation : 0, placement: watermark ? 'center' : placement, margin: distance * PT_PER_MM }, () => `decoration-preview-${watermark ? 'watermark' : 'number'}`), valid: true };
    } catch { return { pages, valid: false }; }
  }, [tab, pages, targets, numberText, watermarkText, start, fontSize, markFontSize, useLocalFont, font, color, opacity, angle, margin, placement]);
  const splitDraft = useMemo(() => {
    if (tab !== 'split') return { parts: [] as ExportPart[], error: '' };
    try { return { parts: splitPlan(targets, splitMode, splitEvery, splitRanges, prefix), error: '' }; }
    catch (reason) { return { parts: [] as ExportPart[], error: errorMessage(reason) }; }
  }, [tab, targets, splitMode, splitEvery, splitRanges, prefix]);
  const draftTargets = targets.map(page => draftPlan.pages.find(candidate => candidate.id === page.id) ?? page);
  const insertAt = position === 'end' ? pages.length : position === 'before' ? activeIndex : Math.min(pages.length, activeIndex + 1);
  const execute = async (task: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setWorking(true); setError(''); callbacks.current.onBusyChange(true);
    try { await task(); } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (alive.current) setWorking(false); callbacks.current.onBusyChange(false); }
  };
  const cropValid=[crop.x,crop.y,crop.width,crop.height].every(Number.isFinite)&&crop.x>=0&&crop.y>=0&&crop.width>0&&crop.height>0&&crop.x+crop.width<=1.000001&&crop.y+crop.height<=1.000001;
  const apply = () => void execute(async () => {
    if (tab === 'duplicate') {
      const n = Number(copies);
      if (!targets.length || !Number.isInteger(n) || n < 1 || n > 20 || pages.length + n * targets.length > 5000) throw new Error(t('请选择页面；复制份数为 1～20，结果最多 5000 页。', 'Choose pages and 1–20 copies; the workspace may contain up to 5000 pages.'));
      const duplicates: WorkspacePage[] = [];
      for (let i = 0; i < n; i++) duplicates.push(...targets.map(page => duplicatePage(page, crypto.randomUUID())));
      callbacks.current.onPlan([...pages.slice(0, insertAt), ...duplicates, ...pages.slice(insertAt)]); return;
    }
    if (tab === 'split') {
      const parts = splitPlan(targets, splitMode, splitEvery, splitRanges, prefix);
      callbacks.current.onBusyChange(false); callbacks.current.onExport(parts); return;
    }
    if (tab === 'number' || tab === 'watermark') {
      if (!targets.length || !draftPlan.valid) throw new Error(t('选页或页码/水印参数无效。', 'The page selection or decoration parameters are invalid.'));
      const plan = draftPlan.pages.map(page => ({ ...page, decorations: page.decorations?.map(item => item.id.startsWith('decoration-preview-') ? { ...item, id: crypto.randomUUID() } : item) }));
      await backend('validate_document', { pages: plan.map(pageReference) }, 3);
      if (alive.current) callbacks.current.onPlan(plan); return;
    }
    let request: GenerateRequest;
    if (tab === 'blank') {
      const w = Number(width), h = Number(height), n = Number(count);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 10 || h < 10 || w > 2000 || h > 2000 || !Number.isInteger(n) || n < 1 || n > 100 || pages.length + n > 5000) throw new Error(t('空白页宽高为 10～2000 mm，数量为 1～100，工作区最多 5000 页。', 'Blank pages use 10–2000 mm dimensions and 1–100 pages, up to 5000 workspace pages.'));
      request = { kind: 'blank', width: w * PT_PER_MM, height: h * PT_PER_MM, count: n };
    } else if (tab === 'images') {
      const mm = Number(margin);
      if (!imagePaths.length || imagePaths.length > 32 || pages.length + imagePaths.length > 5000 || !Number.isFinite(mm) || mm < 0 || mm > 50) throw new Error(t('选择 1～32 张 PNG/JPEG，页边距为 0～50 mm。', 'Choose 1–32 PNG/JPEG images and a 0–50 mm margin.'));
      request = { kind: 'images', paths: imagePaths, paper: imagePaper, margin: mm * PT_PER_MM };
    } else {
      if (!targets.length) throw new Error(t('请选择裁剪页面。', 'Choose pages to crop.'));
      request = { kind: 'crop', pages: targets.map(pageReference), bounds: crop };
    }
    const document = await backend<DocumentInfo>('generate_pages', { request }, 3);
    if (alive.current) callbacks.current.onGenerated(document, tab === 'crop' ? targets.map(page => page.id) : null, insertAt);
  });
  const chooseImages = async () => {
    try { const paths = await open({ multiple: true, filters: [{ name: 'PNG / JPEG', extensions: ['png', 'jpg', 'jpeg'] }], title: t('选择图片，按列表顺序转换', 'Choose images; list order determines page order') }); if (paths) setImagePaths(Array.isArray(paths) ? paths : [paths]); }
    catch (reason) { setError(errorMessage(reason)); }
  };
  const tabs = [
    { id: 'blank', label: t('空白页', 'Blank pages'), icon: FilePlus2 }, { id: 'duplicate', label: t('复制页', 'Duplicate'), icon: Files }, { id: 'images', label: t('图片转 PDF', 'Images to PDF'), icon: ImagePlus }, { id: 'split', label: t('批量拆分', 'Split PDFs'), icon: Scissors }, { id: 'number', label: t('页码', 'Page numbers'), icon: Type }, { id: 'watermark', label: t('水印', 'Watermark'), icon: Stamp }, { id: 'crop', label: t('裁剪', 'Crop'), icon: Crop },
  ] as const;
  return <div className="dt-backdrop" onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && ['s', 'o', 'p', 'f'].includes(event.key.toLowerCase())) event.preventDefault(); if (event.key === 'Escape' && !working) onClose(); }}><div ref={modal} tabIndex={-1} className="dt-modal page-tools-modal" role="dialog" aria-modal="true" aria-labelledby="page-tools-title">
    <header className="dt-header"><div><h2 id="page-tools-title">{t('页面与批量工具', 'Page and batch tools')}</h2><p>{t('页面修改可撤销；导出前会检查页序、大小与结构风险。', 'Page changes can be undone. Export includes order, size and structure review.')}</p></div><button onClick={onClose} disabled={working} aria-label={t('关闭页面工具', 'Close page tools')}><X size={19}/></button></header>
    <nav className="dt-tabs">{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} disabled={working || !pages.length && id !== 'blank' && id !== 'images'} onClick={() => { setTab(id); if (['split', 'number', 'watermark'].includes(id)) setScope(selectedIds.size ? 'selected' : 'all'); setError(''); }}><Icon size={16}/>{label}</button>)}</nav>
    <div className="page-tools-body"><section className="page-tools-fields">
      {!['blank', 'images'].includes(tab) && <><label className="dt-field">{t('处理页面', 'Pages to process')}<select value={scope} disabled={working} onChange={event => setScope(event.target.value as typeof scope)}><option value="current">{t('当前页', 'Current page')}</option><option value="all">{t('全部页面', 'All pages')}</option><option value="selected">{t(`已选中 ${selectedIds.size} 页`, `${selectedIds.size} selected pages`)}</option><option value="range">{t('指定页码', 'Page range')}</option></select></label>{scope === 'range' && <label className="dt-field">{t('页码范围', 'Page range')}<input value={range} placeholder="1-3,5" disabled={working} onChange={event => setRange(event.target.value)}/></label>}<p className="dt-muted">{t(`本次处理 ${targets.length} 页。`, `${targets.length} pages will be processed.`)}</p></>}
      {['blank', 'images', 'duplicate'].includes(tab) && <label className="dt-field">{t('插入位置', 'Insert position')}<select disabled={working} value={position} onChange={event => setPosition(event.target.value)}><option value="after">{t('当前页之后', 'After current page')}</option><option value="before">{t('当前页之前', 'Before current page')}</option><option value="end">{t('文档末尾', 'End of document')}</option></select></label>}
      {tab === 'blank' && <><label className="dt-field">{t('纸张', 'Paper')}<select value={paper} disabled={working} onChange={event => { setPaper(event.target.value); if (event.target.value === 'a4') { setWidth('210'); setHeight('297'); } if (event.target.value === 'a4-landscape') { setWidth('297'); setHeight('210'); } }}><option value="a4">A4 · 210 × 297 mm</option><option value="a4-landscape">A4 · 297 × 210 mm</option><option value="custom">{t('自定义', 'Custom')}</option></select></label><div className="dt-field-row"><label className="dt-field">{t('宽 mm', 'Width mm')}<input type="number" value={width} min={10} max={2000} disabled={working} onChange={event => { setWidth(event.target.value); setPaper('custom'); }}/></label><label className="dt-field">{t('高 mm', 'Height mm')}<input type="number" value={height} min={10} max={2000} disabled={working} onChange={event => { setHeight(event.target.value); setPaper('custom'); }}/></label></div><label className="dt-field">{t('页数', 'Page count')}<input type="number" min={1} max={100} value={count} disabled={working} onChange={event => setCount(event.target.value)}/></label></>}
      {tab === 'duplicate' && <label className="dt-field">{t('复制份数（所选页作为一组）', 'Copies of the selected page group')}<input type="number" min={1} max={20} value={copies} disabled={working} onChange={event => setCopies(event.target.value)}/></label>}
      {tab === 'images' && <><button className="button secondary" disabled={working} onClick={() => void chooseImages()}><ImagePlus size={15}/>{t('选择图片', 'Choose images')}</button><label className="dt-field">{t('输出纸张', 'Output paper')}<select value={imagePaper} disabled={working} onChange={event => setImagePaper(event.target.value as typeof imagePaper)}><option value="a4">{t('A4，按图片方向选择横纵', 'A4, orientation follows image')}</option><option value="original">{t('图片像素按 96 DPI 换算', 'Image pixels at 96 DPI')}</option></select></label><label className="dt-field">{t('页边距 mm', 'Margin mm')}<input type="number" min={0} max={50} value={margin} disabled={working} onChange={event => setMargin(event.target.value)}/></label><ol className="dt-image-list">{imagePaths.map((path, index) => <li key={`${path}-${index}`}><span>{index + 1}. {path.split(/[\\/]/).pop()}</span><button aria-label={t('图片前移', 'Move image up')} disabled={working || index === 0} onClick={() => setImagePaths(list => { const next = [...list]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}><ArrowUp size={13}/></button><button aria-label={t('图片后移', 'Move image down')} disabled={working || index === imagePaths.length - 1} onClick={() => setImagePaths(list => { const next = [...list]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; return next; })}><ArrowDown size={13}/></button></li>)}</ol></>}
      {tab === 'split' && <><label className="dt-field">{t('拆分规则', 'Split rule')}<select value={splitMode} disabled={working} onChange={event => setSplitMode(event.target.value as typeof splitMode)}><option value="every">{t('每 N 页一个文件', 'Every N pages')}</option><option value="each">{t('每页一个文件', 'One file per page')}</option><option value="oddEven">{t('奇数页 / 偶数页两组', 'Odd / even page groups')}</option><option value="ranges">{t('自定义多组范围', 'Custom range groups')}</option></select></label>{splitMode === 'every' && <label className="dt-field">N<input type="number" min={1} value={splitEvery} disabled={working} onChange={event => setSplitEvery(event.target.value)}/></label>}{splitMode === 'ranges' && <label className="dt-field">{t('以分号分隔输出组', 'Separate output groups with semicolons')}<input placeholder="1-3;4-6;7,9" value={splitRanges} disabled={working} onChange={event => setSplitRanges(event.target.value)}/></label>}<label className="dt-field">{t('文件名前缀', 'Filename prefix')}<input value={prefix} maxLength={100} disabled={working} onChange={event => setPrefix(event.target.value)}/></label><p className="dt-muted">{t('页码按本次处理的页面列表计算；最多 200 份、合计 5000 页。先预览每份页序及大小，再选择目录；不覆盖已有同名文件。', 'Ranges refer to the processed page list. Up to 200 files and 5000 pages. Review order and size before choosing a folder; existing filenames are not overwritten.')}</p></>}
      {(tab === 'number' || tab === 'watermark') && <><label className="dt-field">{watermark ? t('水印文字', 'Watermark text') : t('页码模板', 'Number template')}<input value={watermark ? watermarkText : numberText} maxLength={200} disabled={working} onChange={event => watermark ? setWatermarkText(event.target.value) : setNumberText(event.target.value)}/></label><p className="dt-muted">{'{page}'} = {t('工作区页码', 'workspace page')} · {'{total}'} = {t('总页数', 'total pages')} · {'{n}'} = {t('选页流水号', 'selection sequence')}</p>{!watermark && <><label className="dt-field">{t('流水号起始值', 'Sequence starts at')}<input type="number" value={start} min={0} max={999999} disabled={working} onChange={event => setStart(event.target.value)}/></label><label className="dt-field">{t('位置', 'Position')}<select value={placement} disabled={working} onChange={event => setPlacement(event.target.value)}>{[['top-left', t('左上', 'Top left')], ['top-center', t('顶部居中', 'Top center')], ['top-right', t('右上', 'Top right')], ['bottom-left', t('左下', 'Bottom left')], ['bottom-center', t('底部居中', 'Bottom center')], ['bottom-right', t('右下', 'Bottom right')]].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label className="dt-field">{t('页边距 mm', 'Margin mm')}<input type="number" min={0} max={50} value={margin} disabled={working} onChange={event => setMargin(event.target.value)}/></label></>}
        <div className="dt-field-row"><label className="dt-field">{t('字号 pt', 'Font size pt')}<input type="number" min={1} max={512} value={watermark ? markFontSize : fontSize} disabled={working} onChange={event => watermark ? setMarkFontSize(event.target.value) : setFontSize(event.target.value)}/></label><label className="dt-field">{t('颜色', 'Color')}<input type="color" value={color} disabled={working} onChange={event => setColor(event.target.value)}/></label></div>{watermark && <><label className="dt-field">{t('角度（顺时针）', 'Angle (clockwise)')}<input type="number" min={-180} max={180} value={angle} disabled={working} onChange={event => setAngle(event.target.value)}/></label><label className="dt-field">{t(`不透明度 ${opacity}%`, `Opacity ${opacity}%`)}<input type="range" min={5} max={100} value={opacity} disabled={working} onChange={event => setOpacity(Number(event.target.value))}/></label></>}
        {!watermark && <label className="dt-check"><input type="checkbox" checked={useLocalFont} disabled={working} onChange={event => setUseLocalFont(event.target.checked)}/>{t('使用本机字体（中文需要）', 'Use installed font (required for Chinese)')}</label>}{(watermark || useLocalFont) && <FontPicker value={font} onChange={setFont} disabled={working} embedForOriginal sample={watermark ? watermarkText : numberText}/>}
        <p className="dt-muted">{t('同类页码/水印在选页中替换，不叠加旧方案；使用真实 PDF 文字。水印显示在正文上方。', 'Replaces this decoration type on selected pages using real PDF text. Watermarks appear above page content.')}</p><button className="text-button" disabled={working || !targets.length} onClick={() => { const ids = selectedIdsFor(targets); callbacks.current.onPlan(pages.map(page => ids.has(page.id) ? { ...page, decorations: (page.decorations ?? []).filter(item => item.kind !== (watermark ? 'watermark' : 'number')) } : page)); }}>{watermark ? t('清除选页水印', 'Clear watermarks on selected pages') : t('清除选页页码', 'Clear numbers on selected pages')}</button></>}
      {tab === 'crop' && <><p className="dt-muted">{t('在右侧预览上拖动框选，或输入百分比。同一比例应用到全部处理页。', 'Drag on the preview or enter percentages. The same proportions apply to all processed pages.')}</p><div className="dt-field-row">{(['x', 'y', 'width', 'height'] as const).map((key, index) => <label className="dt-field" key={key}>{[t('左 %', 'Left %'), t('上 %', 'Top %'), t('宽 %', 'Width %'), t('高 %', 'Height %')][index]}<input type="number" min={0} max={100} step={.1} value={Math.round(crop[key] * 1000) / 10} disabled={working} onChange={event => setCrop(value => ({ ...value, [key]: Number(event.target.value) / 100 }))}/></label>)}</div><p className="dt-notice warning">{t('裁剪调整可见区域，不移除区域外的底层内容。应用会固化该页已有编辑，可撤销恢复；不能用作敏感信息清除。', 'Cropping changes the visible area and does not remove hidden content. Applying bakes current edits; undo restores them. This is not secure redaction.')}</p></>}
    </section><PageToolPreview onReady={setPreviewReady} tab={tab} pages={pages} targets={draftTargets} insertAt={insertAt} count={Number(count)} copies={Number(copies)} width={Number(width) * PT_PER_MM} height={Number(height) * PT_PER_MM} imagePaths={imagePaths} imagePaper={imagePaper} margin={Number(margin) * PT_PER_MM} parts={splitDraft.parts} splitError={splitDraft.error} crop={crop} onCrop={setCrop} working={working}/></div>
    {error && <p className="dt-error" role="alert">{error}</p>}<footer className="dt-footer"><button className="button secondary" disabled={working} onClick={onClose}>{t('取消', 'Cancel')}</button><button className="button primary" disabled={working || !previewReady || (tab==='crop'&&!cropValid) || (tab==='blank'&&(!Number.isInteger(Number(count))||Number(count)<1||Number(count)>100||Number(width)<10||Number(height)<10||Number(width)>2000||Number(height)>2000)) || (['duplicate','split','number','watermark','crop'].includes(tab) && !targets.length) || (tab==='split' && !splitDraft.parts.length) || ((tab==='number'||tab==='watermark')&&!draftPlan.valid)} onClick={apply}>{working ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>} {tab === 'split' ? t('预览拆分结果', 'Review split output') : t('应用到工作区', 'Apply to workspace')}</button></footer>
  </div></div>;
}

const selectedIdsFor = (pages: WorkspacePage[]) => new Set(pages.map(page => page.id));
