// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { constrainedMarkPoint, createMarkGeometry, lineDash, markPoint } from '../markGeometry';
import type { MarkGeometry, MarkPoint, MarkSettings } from '../markGeometry';
import { useI18n } from '../i18n';

export function MarkPreview({ mark, color, opacity }: { mark: MarkGeometry; color: string; opacity: number }) {
  const points = mark.points.map(point => ({ x: point.x * mark.pageWidth, y: point.y * mark.pageHeight }));
  const first = points[0], last = points[points.length - 1];
  const x = Math.min(first.x, last.x), y = Math.min(first.y, last.y), width = Math.abs(last.x - first.x), height = Math.abs(last.y - first.y);
  let shape;
  if (mark.tool === 'highlight' || mark.tool === 'block') shape = <rect x={x} y={y} width={width} height={height} fill={color} stroke="none"/>;
  else if (mark.tool === 'rectangle') shape = <rect x={x} y={y} width={width} height={height}/>;
  else if (mark.tool === 'ellipse') shape = <ellipse cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2}/>;
  else {
    const angle = Math.atan2(last.y - first.y, last.x - first.x), head = Math.max(7, mark.lineWidth * 4);
    shape = <><polyline points={points.map(point => `${point.x},${point.y}`).join(' ')}/>{mark.tool === 'arrow' && <polyline points={`${last.x - head * Math.cos(angle - Math.PI / 6)},${last.y - head * Math.sin(angle - Math.PI / 6)} ${last.x},${last.y} ${last.x - head * Math.cos(angle + Math.PI / 6)},${last.y - head * Math.sin(angle + Math.PI / 6)}`}/>}</>;
  }
  return <svg className="mark-preview" viewBox={`0 0 ${mark.pageWidth} ${mark.pageHeight}`} preserveAspectRatio="none" aria-hidden="true" style={{ opacity }}><g fill="none" stroke={color} strokeWidth={mark.lineWidth} strokeDasharray={lineDash(mark.lineStyle, mark.lineWidth).join(' ')} strokeLinecap="round" strokeLinejoin="round">{shape}</g></svg>;
}

export function MarkLayer({ settings, pageWidth, pageHeight, disabled, onBegin, onComplete }: {
  settings: MarkSettings; pageWidth: number; pageHeight: number; disabled: boolean;
  onBegin: () => void; onComplete: (mark: MarkGeometry, settings: MarkSettings) => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<MarkGeometry | null>(null);
  const gesture = useRef<{ pointer: number; points: MarkPoint[]; bounds: DOMRect; settings: MarkSettings } | null>(null);
  const reset = () => { gesture.current = null; setPreview(null); };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') reset(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  useEffect(() => { if (disabled) reset(); }, [disabled]);
  const point = (event: PointerEvent<HTMLDivElement>, bounds: DOMRect) => markPoint((event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const next = constrainedMarkPoint(active.points[0], point(event, active.bounds), active.settings.tool, event.shiftKey, pageWidth, pageHeight);
    if (active.settings.tool === 'pen') {
      const last = active.points.at(-1)!;
      if (active.points.length < 1999 && Math.hypot((next.x - last.x) * active.bounds.width, (next.y - last.y) * active.bounds.height) >= 1) active.points.push(next);
    } else active.points = [active.points[0], next];
    setPreview(createMarkGeometry(active.points, active.settings, pageWidth, pageHeight));
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    if (!cancel) move(event);
    const mark = createMarkGeometry(active.points, active.settings, pageWidth, pageHeight);
    reset(); event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancel && !disabled && mark) onComplete(mark, active.settings);
  };
  return <div className={`mark-drawing-layer ${disabled ? 'disabled' : ''}`} role="group" aria-label={t('在页面上拖动绘制标记；Esc 取消本次绘制', 'Drag on the page to draw a mark; Esc cancels the stroke')}
    onPointerDown={event => {
      if (disabled || event.button !== 0 || gesture.current || settings.tool === 'select') return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      event.preventDefault(); event.stopPropagation(); onBegin();
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { pointer: event.pointerId, points: [point(event, bounds)], bounds, settings: { ...settings } };
    }} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}>
    {preview && <MarkPreview mark={preview} color={settings.color} opacity={settings.opacity}/>}
  </div>;
}
