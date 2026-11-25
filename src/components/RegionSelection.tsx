// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { ImageAsset } from '../types';
import { imagePoint, outlineString, selectionFromPoints, selectionOutline, selectionRegions, selectionUnion, MAX_IMAGE_REGIONS } from '../imageGeometry';
import type { ImagePoint, ImageSelection, SelectionShape } from '../imageGeometry';
import { useI18n } from '../i18n';
import { PreviewZoom } from './PreviewZoom';

let selectionSequence = 0;
export function RegionSelection({ image, crop, shape, onChange, onPreview, disabled, allowMultiple = false, zoomable = false }: {
  image: ImageAsset; crop: ImageSelection | null; shape: SelectionShape;
  onChange: (crop: ImageSelection | null) => void; onPreview?: (crop: ImageSelection | null) => void; disabled: boolean;
  allowMultiple?: boolean; zoomable?: boolean;
}) {
  const { t } = useI18n();
  const surface = useRef<HTMLDivElement>(null), gesture = useRef<{ id: number; bounds: DOMRect; points: ImagePoint[] } | null>(null);
  const polygon = useRef<ImagePoint[]>([]), [draft, setDraft] = useState<ImagePoint[]>([]), [ghost, setGhost] = useState<ImageSelection | null>(null);
  const [add, setAdd] = useState(true), [maskId] = useState(() => `regions-${++selectionSequence}`), [limit, setLimit] = useState(false);
  const previewFrame = useRef<number | null>(null), pendingPreview = useRef<ImageSelection | null>(null);
  const regions = selectionRegions(crop), adding = allowMultiple && add;
  const merge = (next: ImageSelection) => adding ? selectionUnion([...regions, next]) : next;
  const commit = (next: ImageSelection) => { if (adding && regions.length >= MAX_IMAGE_REGIONS) { setLimit(true); return; } setLimit(false); onChange(merge(next)); };
  const cancelPreview = () => { if (previewFrame.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(previewFrame.current); previewFrame.current = null; pendingPreview.current = null; };
  const reset = () => { cancelPreview(); gesture.current = null; polygon.current = []; setDraft([]); setGhost(null); onPreview?.(null); };
  useEffect(() => { reset(); }, [shape, image.id, disabled]);
  useEffect(() => () => cancelPreview(), []);
  const preview = (selection: ImageSelection | null) => {
    pendingPreview.current = selection;
    if (previewFrame.current !== null) return;
    const paint = () => { previewFrame.current = null; const next = pendingPreview.current; setGhost(next); onPreview?.(next ? adding && regions.length < MAX_IMAGE_REGIONS ? merge(next) : next : null); };
    if (typeof requestAnimationFrame === 'function') previewFrame.current = requestAnimationFrame(paint); else paint();
  };
  const point = (event: PointerEvent, bounds: DOMRect) => imagePoint((event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
  const waitsForClosure = shape === 'polygon' || shape === 'curve';
  const finishOutline = () => { const next = selectionFromPoints(polygon.current, shape); if (next && !disabled) { commit(next); reset(); } };
  const selected = ghost ? adding && regions.length < MAX_IMAGE_REGIONS ? merge(ghost) : ghost : crop;
  const selectedRegions = selectionRegions(selected);
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    const end = point(event, active.bounds);
    const points = [...active.points, end];
    cancelPreview(); gesture.current = null; setGhost(null); onPreview?.(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancel || disabled) { setDraft(polygon.current); return; }
    if (shape === 'curve') {
      polygon.current = [...polygon.current, ...points].slice(0, 2048);
      setDraft(polygon.current);
    } else {
      const next = selectionFromPoints(shape === 'lasso' ? points : [active.points[0], end], shape);
      if (next) commit(next);
    }
  };
  const canvas = <div ref={surface} role="group" tabIndex={0} aria-label={t('在 PDF 整页预览上拖动框选内容片段，也可使用下方百分比输入框', 'Drag on this PDF page to select a fragment, or use the percentage fields below')} className="region-selection-surface oe-checker" style={{ aspectRatio: `${image.width}/${image.height}` }}
      onDoubleClick={event => { if (waitsForClosure) { event.preventDefault(); finishOutline(); } }}
      onPointerDown={event => {
        if (disabled || event.button !== 0 || gesture.current || !surface.current) return;
        const bounds = surface.current.getBoundingClientRect(); if (!bounds.width || !bounds.height) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); const start = point(event, bounds);
        if (shape === 'polygon') { polygon.current = [...polygon.current, start].slice(0, 256); setDraft(polygon.current); return; }
        gesture.current = { id: event.pointerId, bounds, points: [start] }; event.currentTarget.setPointerCapture(event.pointerId); setGhost(null);
      }} onPointerMove={event => {
        const active = gesture.current; if (!active || event.pointerId !== active.id || disabled) return;
        event.preventDefault(); const next = point(event, active.bounds);
        if (shape === 'lasso' || shape === 'curve') { const last = active.points.at(-1)!; if (Math.hypot((next.x - last.x) * image.width, (next.y - last.y) * image.height) >= 2 && active.points.length + polygon.current.length < 2048) active.points.push(next); }
        else active.points = [active.points[0], next];
        if (shape === 'curve') setDraft([...polygon.current, ...active.points]);
        else preview(selectionFromPoints(active.points, shape));
      }} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}>
      <img src={image.dataUrl} alt={t('PDF 整页预览，可框选区域', 'PDF page preview with selectable region')} draggable={false}/>
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
        <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="1" height="1"><rect width="1" height="1" fill="white"/>{selectedRegions.map((region,n) => <polygon key={n} points={outlineString(selectionOutline(region))} fill="black" fillRule="evenodd"/>)}</mask></defs>
        {selected && <rect width="1" height="1" fill="#243e4e4b" mask={`url(#${maskId})`}/>}
        {selectedRegions.map((region,n) => <polygon key={n} points={outlineString(selectionOutline(region))} fill="#829aaf1c" stroke="#456b89" strokeWidth=".0025"/>)}
        {draft.length > 0 && <><polyline points={outlineString(draft)} fill="none" stroke="#456b89" strokeWidth=".003"/>{shape === 'polygon' && draft.map((p, n) => <ellipse key={n} cx={p.x} cy={p.y} rx=".004" ry=".004" fill="#9a603d"/>)}</>}
      </svg>
    </div>;
  return <div className={`region-selection${zoomable ? ' is-zoomable' : ''}`} onKeyDown={event => {
    if (event.key === 'Escape' && (gesture.current || polygon.current.length)) { event.preventDefault(); event.stopPropagation(); reset(); }
    if (event.key === 'Enter' && waitsForClosure && polygon.current.length >= 3 && event.target === surface.current) { event.preventDefault(); finishOutline(); }
  }}>
    {allowMultiple && <div className="region-selection-controls"><label><input type="checkbox" checked={add} disabled={disabled} onChange={event => { reset(); setAdd(event.target.checked); setLimit(false); }}/>{t('叠加选区', 'Add regions')}</label><span>{regions.length} / {MAX_IMAGE_REGIONS}</span><button disabled={disabled || !regions.length} onClick={() => { reset(); setLimit(false); onChange(selectionUnion(regions.slice(0, -1))); }}>{t('撤回区域', 'Undo region')}</button><button disabled={disabled || !crop} onClick={() => { reset(); setLimit(false); onChange(null); }}>{t('清空选区', 'Clear regions')}</button>{limit && <span role="status">{t('已达 16 区上限，请撤回或清空。', '16-region limit. Undo or clear regions.')}</span>}</div>}
    {zoomable ? <PreviewZoom width={image.width} height={image.height} resetKey={image.id} label={t('可缩放的区域选择预览', 'Zoomable region selection preview')} disabled={disabled}>{canvas}</PreviewZoom> : canvas}
    {waitsForClosure && <div className="region-polygon-actions"><span>{shape === 'curve' ? t('拖画曲线，松手后可继续。完成时选择闭合。', 'Draw a curve. Release to pause, then close when ready.') : t('依次点击顶点，双击或按 Enter 闭合。', 'Click vertices; double-click or press Enter to close.')}</span><button disabled={disabled || draft.length < 3} onClick={finishOutline}>{shape === 'curve' ? t('闭合曲线', 'Close curve') : t('闭合选区', 'Close polygon')}</button><button disabled={disabled || !draft.length} onClick={() => { polygon.current = shape === 'curve' ? [] : polygon.current.slice(0, -1); setDraft(polygon.current); }}>{shape === 'curve' ? t('清除曲线草稿', 'Clear curve draft') : t('撤回顶点', 'Undo vertex')}</button></div>}
  </div>;
}
