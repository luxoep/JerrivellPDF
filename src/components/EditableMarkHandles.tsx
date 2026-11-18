// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { constrainedMarkPoint, createMarkGeometry, isEditablePathTool, markPoint } from '../markGeometry';
import type { MarkPoint, MarkSource } from '../markGeometry';
import type { PageOverlay } from '../types';
import { overlayStep } from '../overlayGeometry';
import { useI18n } from '../i18n';
import './editable-mark-handles.css';

/** Retain all path nodes; inserting a node upgrades an ordinary straight line. */
export function editedMarkSource(source: MarkSource, points: MarkPoint[], pageWidth: number, pageHeight: number): MarkSource | null {
  const old = source.geometry;
  const tool = points.length > 2 && old.tool === 'line' ? 'polyline' : points.length > 2 && old.tool === 'arrow' ? 'polyarrow' : old.tool;
  const geometry = createMarkGeometry(points, { tool, color: source.color, opacity: 1, lineWidth: old.lineWidth, lineStyle: old.lineStyle, arrowHeads: old.arrowHeads }, pageWidth, pageHeight);
  return geometry ? { ...source, geometry } : null;
}

type Drag = { pointer: number; index: number; original: PageOverlay; preview: PageOverlay; bounds: DOMRect };
export function EditableMarkHandles({ item, pageWidth, pageHeight, onPreview, onChange, disabled = false }: {
  item: PageOverlay; pageWidth: number; pageHeight: number;
  onPreview: (item: PageOverlay | null) => void; onChange: (item: PageOverlay) => void; disabled?: boolean;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null), drag = useRef<Drag | null>(null);
  const [local, setLocal] = useState<PageOverlay | null>(null);
  const latest = useRef({ onPreview, onChange }); latest.current = { onPreview, onChange };
  useEffect(() => { drag.current = null; setLocal(null); latest.current.onPreview(null); }, [item.id, disabled]);
  useEffect(() => () => { if (drag.current) latest.current.onPreview(null); }, []);
  const shown = local?.id === item.id ? local : item, source = shown.markSource;
  if (!source || !isEditablePathTool(source.geometry.tool) || disabled || item.locked) return null;
  const points = source.geometry.points;
  const minPoints = item.leaderFor ? 3 : 2;
  const fixedEnd = (index: number) => Boolean(item.leaderFor) && index === points.length - 1;
  const withPoints = (original: PageOverlay, nextPoints: MarkPoint[]) => {
    const nextSource = editedMarkSource(original.markSource!, nextPoints, pageWidth, pageHeight);
    return nextSource ? { ...original, ...nextSource.geometry.bounds, rotation: 0, markSource: nextSource } : null;
  };
  const remove = (index: number) => {
    if (points.length <= minPoints || fixedEnd(index)) return;
    const next = withPoints(item, points.filter((_, at) => at !== index));
    if (next) { setLocal(null); onChange(next); }
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const originalPoints = active.original.markSource!.geometry.points;
    let point = markPoint((event.clientX - active.bounds.left) / active.bounds.width, (event.clientY - active.bounds.top) / active.bounds.height);
    if (event.shiftKey) {
      const anchor = originalPoints[active.index ? active.index - 1 : 1];
      point = constrainedMarkPoint(anchor, point, 'polyline', true, pageWidth, pageHeight);
    }
    if (active.original.leaderFor && active.index === originalPoints.length - 2) point.y = originalPoints.at(-1)!.y;
    const next = withPoints(active.original, originalPoints.map((value, index) => index === active.index ? point : value));
    if (next) { active.preview = next; setLocal(next); onPreview(next); }
  };
  const finish = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (!cancel) move(event);
    drag.current = null; setLocal(null); onPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancel && JSON.stringify(active.preview.markSource) !== JSON.stringify(active.original.markSource)) onChange(active.preview);
  };
  return <div ref={root} className="editable-mark-handles" role="group" aria-label={t('折线节点编辑', 'Edit path nodes')}>
    <svg className="editable-mark-segments" viewBox={`0 0 ${pageWidth} ${pageHeight}`} preserveAspectRatio="none" aria-hidden="true">
      {points.slice(1).map((end, index) => <line key={index} x1={points[index].x * pageWidth} y1={points[index].y * pageHeight} x2={end.x * pageWidth} y2={end.y * pageHeight}
        onPointerDown={event => { event.stopPropagation(); }} onDoubleClick={event => {
          event.preventDefault(); event.stopPropagation();
          if (!root.current || points.length >= 2000) return;
          const bounds = root.current.getBoundingClientRect();
          if (!bounds.width || !bounds.height) return;
          const raw = { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height }, start = points[index];
          // Project in physical page space, so portrait/landscape have identical behavior.
          const dx = (end.x - start.x) * pageWidth, dy = (end.y - start.y) * pageHeight, length2 = dx * dx + dy * dy;
          const ratio = length2 ? Math.max(.01, Math.min(.99, ((raw.x - start.x) * pageWidth * dx + (raw.y - start.y) * pageHeight * dy) / length2)) : .5;
          const added = markPoint(start.x + (end.x - start.x) * ratio, start.y + (end.y - start.y) * ratio);
          const next = withPoints(item, [...points.slice(0, index + 1), added, ...points.slice(index + 1)]);
          if (next) onChange(next);
        }}/>) }
    </svg>
    {points.map((point, index) => <button key={index} type="button" className={`editable-mark-node ${fixedEnd(index) ? 'fixed' : ''}`}
      style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
      title={fixedEnd(index) ? t('连接点：移动文字框改变位置', 'Connection: move the text box to reposition') : t(`节点 ${index + 1}：拖动调整；双击删除；Shift 约束为 45°`, `Node ${index + 1}: drag to adjust; double-click to remove; Shift snaps to 45°`)}
      aria-label={t(`折线节点 ${index + 1}`, `Path node ${index + 1}`)} aria-disabled={fixedEnd(index)}
      onPointerDown={event => {
        event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
        if (event.button !== 0 || fixedEnd(index) || !root.current) return;
        const bounds = root.current.getBoundingClientRect(); if (!bounds.width || !bounds.height) return;
        drag.current = { pointer: event.pointerId, index, original: item, preview: item, bounds };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); remove(index); }}
      onKeyDown={event => {
        if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); drag.current = null; setLocal(null); onPreview(null); return; }
        if (fixedEnd(index)) { if (['Delete', 'Backspace', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); } return; }
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); remove(index); return; }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const dx = event.key === 'ArrowLeft' ? -overlayStep(pageWidth, event.shiftKey) : event.key === 'ArrowRight' ? overlayStep(pageWidth, event.shiftKey) : 0;
        const dy = item.leaderFor && index === points.length - 2 ? 0 : event.key === 'ArrowUp' ? -overlayStep(pageHeight, event.shiftKey) : event.key === 'ArrowDown' ? overlayStep(pageHeight, event.shiftKey) : 0;
        const next = withPoints(item, points.map((value, at) => at === index ? markPoint(value.x + dx, value.y + dy) : value));
        if (next) onChange(next);
      }}/>) }
    <div className="editable-mark-hint">{t('拖动节点 · 双击线段加点 · 双击节点删点 · Shift 吸附', 'Drag nodes · Double-click segments to add nodes · Double-click nodes to remove · Shift snaps')}</div>
  </div>;
}
