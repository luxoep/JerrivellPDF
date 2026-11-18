// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { ImageAsset } from '../types';
import { imagePoint, outlineString, selectionFromPoints, selectionOutline } from '../imageGeometry';
import type { ImagePoint, ImageSelection, SelectionShape } from '../imageGeometry';
import { useI18n } from '../i18n';

export function RegionSelection({ image, crop, shape, onChange, onPreview, disabled }: {
  image: ImageAsset; crop: ImageSelection | null; shape: SelectionShape;
  onChange: (crop: ImageSelection | null) => void; onPreview?: (crop: ImageSelection | null) => void; disabled: boolean;
}) {
  const { t } = useI18n();
  const surface = useRef<HTMLDivElement>(null), gesture = useRef<{ id: number; bounds: DOMRect; points: ImagePoint[] } | null>(null);
  const polygon = useRef<ImagePoint[]>([]), [draft, setDraft] = useState<ImagePoint[]>([]), [ghost, setGhost] = useState<ImageSelection | null>(null);
  const reset = () => { gesture.current = null; polygon.current = []; setDraft([]); setGhost(null); onPreview?.(null); };
  useEffect(() => { reset(); }, [shape, image.id, disabled]);
  const point = (event: PointerEvent, bounds: DOMRect) => imagePoint((event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
  const finishPolygon = () => { const next = selectionFromPoints(polygon.current, 'polygon'); if (next && !disabled) onChange(next); reset(); };
  const selected = ghost ?? crop;
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    const end = point(event, active.bounds);
    const next = selectionFromPoints(shape === 'lasso' ? [...active.points, end] : [active.points[0], end], shape);
    gesture.current = null; setGhost(null); onPreview?.(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancel && !disabled && next) onChange(next);
  };
  return <div className="region-selection" onKeyDown={event => {
    if (event.key === 'Escape' && (gesture.current || polygon.current.length)) { event.preventDefault(); event.stopPropagation(); reset(); }
    if (event.key === 'Enter' && shape === 'polygon' && polygon.current.length >= 3) { event.preventDefault(); finishPolygon(); }
  }}>
    <div ref={surface} role="group" tabIndex={0} aria-label={t('在 PDF 整页预览上拖动框选内容片段，也可使用下方百分比输入框', 'Drag on this PDF page to select a fragment, or use the percentage fields below')} className="region-selection-surface oe-checker" style={{ aspectRatio: `${image.width}/${image.height}` }}
      onDoubleClick={event => { if (shape === 'polygon') { event.preventDefault(); finishPolygon(); } }}
      onPointerDown={event => {
        if (disabled || event.button !== 0 || gesture.current || !surface.current) return;
        const bounds = surface.current.getBoundingClientRect(); if (!bounds.width || !bounds.height) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); const start = point(event, bounds);
        if (shape === 'polygon') { polygon.current = [...polygon.current, start].slice(0, 256); setDraft(polygon.current); return; }
        gesture.current = { id: event.pointerId, bounds, points: [start] }; event.currentTarget.setPointerCapture(event.pointerId); setGhost(null);
      }} onPointerMove={event => {
        const active = gesture.current; if (!active || event.pointerId !== active.id || disabled) return;
        event.preventDefault(); const next = point(event, active.bounds);
        if (shape === 'lasso') { const last = active.points.at(-1)!; if (Math.hypot((next.x - last.x) * image.width, (next.y - last.y) * image.height) >= 2 && active.points.length < 2048) active.points.push(next); }
        else active.points = [active.points[0], next];
        const selection = selectionFromPoints(active.points, shape); setGhost(selection); onPreview?.(selection);
      }} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}>
      <img src={image.dataUrl} alt={t('PDF 整页预览，可框选区域', 'PDF page preview with selectable region')} draggable={false}/>
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
        {selected && <path d={`M0 0H1V1H0Z M${selectionOutline(selected).map(p => `${p.x} ${p.y}`).join('L')}Z`} fill="#241b414b" fillRule="evenodd"/>}
        {selected && <polygon points={outlineString(selectionOutline(selected))} fill="#9b7dcc1c" stroke="#8060bd" strokeWidth=".0025"/>}
        {draft.length > 0 && <><polyline points={outlineString(draft)} fill="none" stroke="#8060bd" strokeWidth=".003"/>{draft.map((p, n) => <ellipse key={n} cx={p.x} cy={p.y} rx=".004" ry=".004" fill="#7651b5"/>)}</>}
      </svg>
    </div>
    {shape === 'polygon' && <div className="region-polygon-actions"><span>{t('依次点击顶点，双击或按 Enter 闭合。', 'Click vertices; double-click or press Enter to close.')}</span><button disabled={disabled || draft.length < 3} onClick={finishPolygon}>{t('闭合选区', 'Close polygon')}</button><button disabled={disabled || !draft.length} onClick={() => { polygon.current = polygon.current.slice(0, -1); setDraft(polygon.current); }}>{t('撤回顶点', 'Undo vertex')}</button></div>}
  </div>;
}
