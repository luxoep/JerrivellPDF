// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Check, Eraser, LoaderCircle, RotateCcw, Scissors, Undo2, X } from 'lucide-react';
import { backend, errorMessage } from '../backend';
import type { ImageAsset } from '../types';
import { imagePoint, outlineString, selectionOutline, selectionRegions } from '../imageGeometry';
import type { EraseStroke, ImageSelection, SelectionShape } from '../imageGeometry';
import { useI18n } from '../i18n';
import { RegionSelection } from './RegionSelection';
import './image-workbench.css';

type Draft = { crop: ImageSelection | null; strokes: EraseStroke[] };
export function ImageEditDialog({ image, title, onApply, onClose, onBusyChange, notice, applyLabel }: {
  image: ImageAsset; title: string; onApply: (image: ImageAsset) => Promise<boolean | void> | boolean | void;
  onClose: () => void; onBusyChange?: (busy: boolean) => void;
  notice?: string; applyLabel?: string;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'crop' | 'erase'>('crop'), [shape, setShape] = useState<SelectionShape>('rectangle');
  const [history, setHistory] = useState<Draft[]>([{ crop: null, strokes: [] }]), [ghostCrop, setGhostCrop] = useState<ImageSelection | null>(null);
  const [stroke, setStroke] = useState<EraseStroke | null>(null), [brush, setBrush] = useState(24);
  const [eraseMode, setEraseMode] = useState<'repair' | 'transparent'>('repair');
  const [repairPreview, setRepairPreview] = useState<{ key: string; dataUrl: string } | null>(null), [previewRetry, setPreviewRetry] = useState(0);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null), [working, setWorking] = useState(false), [error, setError] = useState('');
  const modal = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null), [size, setSize] = useState({ width: 640, height: 550 });
  const pending = useRef(false), alive = useRef(true), active = useRef<{ pointer: number; bounds: DOMRect; stroke: EraseStroke } | null>(null);
  const [maskId] = useState(() => `pixel-${crypto.randomUUID()}`);
  const draft = history[history.length - 1], crop = ghostCrop ?? draft.crop;
  const strokes = stroke ? [...draft.strokes, stroke] : draft.strokes;
  const hasRepair = draft.strokes.some(value => value.mode === 'repair');
  const previewKey = useRef({ strokes: draft.strokes, key: JSON.stringify([image.id, draft.strokes]) });
  if (previewKey.current.strokes !== draft.strokes) previewKey.current = { strokes: draft.strokes, key: JSON.stringify([image.id, draft.strokes]) };
  const repairKey = previewKey.current.key, previewPending = hasRepair && repairPreview?.key !== repairKey;
  const frame = useRef<number | null>(null);
  const latestCursor = useRef<{ x: number; y: number } | null>(null);
  const change = (next: Draft) => { setHistory(previous => [...previous, next].slice(-65)); setError(''); };
  useEffect(() => { alive.current = true; modal.current?.focus(); return () => { alive.current = false; active.current = null; if (frame.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame.current); onBusyChange?.(false); }; }, []);
  useEffect(() => {
    if (!hasRepair) { setRepairPreview(null); return; }
    let disposed = false; const lease = { cancelled: false };
    const timer = window.setTimeout(() => {
      void backend<{ dataUrl: string; width: number; height: number }>('preview_image_edit', { assetId: image.id, crop: null, strokes: draft.strokes }, 2, { priority: 2, unleased: false, leases: new Set([lease]) })
        .then(result => { if (!disposed) { setRepairPreview({ key: repairKey, dataUrl: result.dataUrl }); setError(''); } })
        .catch(reason => { if (!disposed) setError(errorMessage(reason)); });
    }, 120);
    return () => { disposed = true; lease.cancelled = true; window.clearTimeout(timer); };
  }, [repairKey, hasRepair, previewRetry]);
  useEffect(() => {
    if (!stage.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => { const { width, height } = entries[0].contentRect; setSize({ width, height }); });
    observer.observe(stage.current); return () => observer.disconnect();
  }, []);
  const h = Math.max(40, Math.min(size.height - 72, (size.width - 28) * image.height / image.width)), w = h * image.width / image.height;
  const location = (event: PointerEvent, bounds: DOMRect) => imagePoint((event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = active.current?.bounds ?? event.currentTarget.getBoundingClientRect(), next = location(event, bounds);
    latestCursor.current = next;
    const gesture = active.current;
    const paint = () => { frame.current = null; setCursor(latestCursor.current); if (gesture && active.current === gesture) setStroke({ ...gesture.stroke, points: [...gesture.stroke.points] }); };
    if (frame.current === null) { if (typeof requestAnimationFrame === 'function') frame.current = requestAnimationFrame(paint); else paint(); }
    if (!gesture || gesture.pointer !== event.pointerId) return;
    event.preventDefault();
    const last = gesture.stroke.points.at(-1)!;
    if (Math.hypot((next.x - last.x) * image.width, (next.y - last.y) * image.height) >= 2 && gesture.stroke.points.length < 2048) gesture.stroke.points.push(next);
  };
  const finish = (event: PointerEvent<SVGSVGElement>, cancel = false) => {
    const gesture = active.current; if (!gesture || gesture.pointer !== event.pointerId) return;
    if (!cancel) move(event); active.current = null; setStroke(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancel || working) return;
    const points = gesture.stroke.points.length > 256 ? Array.from({ length: 256 }, (_, n) => gesture.stroke.points[Math.round(n * (gesture.stroke.points.length - 1) / 255)]) : gesture.stroke.points;
    if (draft.strokes.length >= 64 || draft.strokes.reduce((sum, value) => sum + value.points.length, points.length) > 4096) { setError(t('本次擦除较多，请先应用后继续编辑。', 'Apply these edits before adding more eraser strokes.')); return; }
    change({ ...draft, strokes: [...draft.strokes, { ...gesture.stroke, points }] });
  };
  const apply = async () => {
    if (pending.current || history.length <= 1 || previewPending || active.current) return;
    pending.current = true; setWorking(true); setError(''); onBusyChange?.(true);
    try {
      const result = await backend<ImageAsset>('edit_image_asset', { assetId: image.id, crop: draft.crop, strokes: draft.strokes }, 3);
      if (alive.current && await onApply(result) !== false) onClose();
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (alive.current) setWorking(false); onBusyChange?.(false); }
  };
  const pixels = (id: string, interactive = false) => <svg viewBox={`0 0 ${image.width} ${image.height}`} width="100%" height="100%" className={interactive ? 'pixel-erase-surface' : ''}
    onPointerDown={interactive ? event => { if (working || event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); const bounds = event.currentTarget.getBoundingClientRect(); const next = { points: [location(event, bounds)], width: brush, mode: eraseMode }; active.current = { pointer: event.pointerId, bounds, stroke: next }; setStroke(next); } : undefined}
    onPointerMove={interactive ? move : undefined} onPointerUp={interactive ? event => finish(event) : undefined} onPointerCancel={interactive ? event => finish(event, true) : undefined} onLostPointerCapture={interactive ? event => finish(event, true) : undefined} onPointerLeave={interactive ? () => { if (!active.current) setCursor(null); } : undefined}>
    <defs><mask id={`${id}-erase`} maskUnits="userSpaceOnUse" x={0} y={0} width={image.width} height={image.height}><rect width={image.width} height={image.height} fill="white"/>{(hasRepair && repairPreview ? stroke ? [stroke] : [] : strokes).filter(value => value.mode !== 'repair').map((value, n) => <polyline key={n} points={outlineString(value.points.length === 1 ? [value.points[0], value.points[0]] : value.points, image.width, image.height)} fill="none" stroke="black" strokeWidth={value.width} strokeLinecap="round" strokeLinejoin="round"/>)}</mask><clipPath id={`${id}-crop`}>{crop ? selectionRegions(crop).map((region,n) => <polygon key={n} points={outlineString(selectionOutline(region), image.width, image.height)} fillRule="evenodd" clipRule="evenodd"/>) : <rect width={image.width} height={image.height}/>}</clipPath></defs>
    <image href={hasRepair && repairPreview ? repairPreview.dataUrl : image.dataUrl} width={image.width} height={image.height} mask={`url(#${id}-erase)`} clipPath={`url(#${id}-crop)`}/>
    {interactive && stroke?.mode === 'repair' && <polyline points={outlineString(stroke.points.length === 1 ? [stroke.points[0],stroke.points[0]] : stroke.points,image.width,image.height)} fill="none" stroke="#db9a4b77" strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"/>}
    {interactive && cursor && <circle cx={cursor.x * image.width} cy={cursor.y * image.height} r={brush / 2} fill="#fff4" stroke="#456b89" strokeWidth={Math.max(1, image.width / w)} pointerEvents="none"/>}
  </svg>;
  return <div className="image-workbench-backdrop" onKeyDown={event => {
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && ['s', 'o', 'p'].includes(event.key.toLowerCase())) event.preventDefault();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (!working) setHistory(previous => previous.length > 1 ? previous.slice(0, -1) : previous); }
    if (event.key === 'Escape') { if (active.current) { active.current = null; setStroke(null); } else if (!working) onClose(); }
  }}><section ref={modal} tabIndex={-1} className="image-workbench" role="dialog" aria-modal="true" aria-label={t('图像裁切与橡皮擦', 'Image crop and eraser')}>
    <header><div><h2>{t('图像裁切与橡皮擦', 'Image crop and eraser')}</h2><p>{title} · {image.width} × {image.height} px</p></div><button disabled={working} onClick={onClose} aria-label={t('关闭图像编辑', 'Close image editor')}><X size={20}/></button></header>
    <div className="image-workbench-body"><aside className="image-workbench-options"><div className="image-mode-buttons"><button className={mode === 'crop' ? 'active' : ''} onClick={() => setMode('crop')} disabled={working}><Scissors size={17}/>{t('裁切', 'Crop')}</button><button className={mode === 'erase' ? 'active' : ''} onClick={() => setMode('erase')} disabled={working}><Eraser size={17}/>{t('橡皮擦', 'Eraser')}</button></div>
      {notice && <p className="dt-notice warning">{notice}</p>}
      {mode === 'crop' ? <label className="dt-field">{t('选区形状', 'Selection shape')}<select disabled={working} value={shape} onChange={event => setShape(event.target.value as SelectionShape)}>{(['rectangle','ellipse','polygon','lasso'] as const).map((value,n) => <option value={value} key={value}>{[t('矩形','Rectangle'),t('椭圆','Ellipse'),t('多边形','Polygon'),t('自由套索','Freehand lasso')][n]}</option>)}</select></label> : <><label className="dt-field">{t('擦除方式','Erase mode')}<select aria-label={t('擦除方式','Erase mode')} disabled={working || !!stroke} value={eraseMode} onChange={event => setEraseMode(event.target.value as typeof eraseMode)}><option value="repair">{t('修复背景（局部估计）','Repair background (local estimate)')}</option><option value="transparent">{t('擦成透明','Erase to transparency')}</option></select></label><label className="dt-field">{t(`橡皮擦直径 ${brush} px`, `Eraser diameter ${brush} px`)}<input aria-label={t('橡皮擦直径', 'Eraser diameter')} type="range" min={2} max={200} value={brush} disabled={working} onChange={event => setBrush(Number(event.target.value))}/></label><p className="oe-note">{t('修复背景会估计笔迹周围的底色，保留原透明度。适合纸张、纯色和缓变背景；复杂纹理不是语义 AI 重建。松手后更新真实结果。','Repair estimates nearby background colors and preserves alpha. Best for paper, flat colors and gentle gradients; it is not semantic AI reconstruction. The native result updates after each stroke.')}</p></>}
      <button className="oe-action wide" disabled={working || history.length <= 1} onClick={() => setHistory(previous => previous.slice(0,-1))}><Undo2 size={15}/>{t('撤销本次编辑', 'Undo edit')}</button><button className="oe-action wide" disabled={working || history.length <= 1} onClick={() => { setHistory([{crop:null,strokes:[]}]); setGhostCrop(null); }}><RotateCcw size={15}/>{t('恢复原图', 'Reset image')}</button>
      <p className="oe-note">{t('可叠加最多 16 个保留区域，区域间保持原相对位置。裁切区域外透明；擦除方式可选背景修复或透明。修改可撤销，其他页面保持原样。', 'Keep up to 16 regions in their original relative positions. Outside the union is transparent; erasing can repair the background or make pixels transparent. Edits are reversible and other pages stay unchanged.')}</p><p className="oe-note">{t('这是图像像素编辑，不是敏感信息安全涂黑或文档完整性认证。', 'This edits image pixels; it is not secure document redaction or integrity certification.')}</p>
    </aside><main ref={stage} className="image-workbench-stage"><div className="image-edit-paper oe-checker" style={{width:w,height:h}}>{mode === 'crop' ? <RegionSelection image={hasRepair && repairPreview ? {...image,dataUrl:repairPreview.dataUrl} : image} crop={draft.crop} shape={shape} allowMultiple onChange={next => change({...draft,crop:next})} onPreview={setGhostCrop} disabled={working}/> : pixels(maskId,true)}</div></main><aside className="image-workbench-result"><h3>{t('实时结果', 'Live result')}</h3><div className="image-result-checker oe-checker" style={{aspectRatio:`${image.width}/${image.height}`}}>{pixels(`${maskId}-result`)}</div>{previewPending && <p className="image-preview-pending" role="status"><LoaderCircle size={13} className="spin"/>{t('正在更新背景修复预览…','Updating background repair preview…')}</p>}<p>{t('棋盘格表示透明区域。拖动不会重新加载 PDF 页面。', 'The checkerboard shows transparency. Drawing does not reload the PDF page.')}</p>{error && hasRepair && <button disabled={working} onClick={() => setPreviewRetry(value => value + 1)}>{t('重试修复预览','Retry repair preview')}</button>}</aside></div>
    {error && <p className="dt-error" role="alert">{error}</p>}<footer><span>{t('应用后可在主工作区撤销', 'Undo remains available in the workspace')}</span><button className="button secondary" disabled={working} onClick={onClose}>{t('取消','Cancel')}</button><button className="button primary" disabled={working || previewPending || !!stroke || history.length <= 1} onClick={() => void apply()}>{working ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>} {applyLabel ?? t('应用修改','Apply edits')}</button></footer>
  </section></div>;
}
