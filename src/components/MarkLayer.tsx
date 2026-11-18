// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { constrainedMarkPoint, createMarkGeometry, isMultiPointTool, lineDash, markArrowPaths, markPoint } from '../markGeometry';
import type { MarkGeometry, MarkPoint, MarkSettings } from '../markGeometry';
import { useI18n } from '../i18n';

export function MarkShape({ mark, color }: { mark: MarkGeometry; color: string }) {
  const points = mark.points.map(point => ({ x: point.x * mark.pageWidth, y: point.y * mark.pageHeight }));
  if (points.length < 2) return null;
  const first = points[0], last = points[points.length - 1];
  const x = Math.min(first.x, last.x), y = Math.min(first.y, last.y), width = Math.abs(last.x - first.x), height = Math.abs(last.y - first.y);
  let shape;
  if (mark.tool === 'highlight' || mark.tool === 'block') shape = <rect x={x} y={y} width={width} height={height} fill={color} stroke="none"/>;
  else if (mark.tool === 'rectangle') shape = <rect x={x} y={y} width={width} height={height}/>;
  else if (mark.tool === 'ellipse') shape = <ellipse cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2}/>;
  else shape = <polyline points={points.map(point => `${point.x},${point.y}`).join(' ')}/>;
  return <g fill="none" stroke={color} strokeWidth={mark.lineWidth} strokeLinecap="round" strokeLinejoin="round">
      <g strokeDasharray={lineDash(mark.lineStyle, mark.lineWidth).join(' ')}>{shape}</g>
      {markArrowPaths(mark).map((path, index) => <polyline key={index} points={path.map(point => `${point.x},${point.y}`).join(' ')}/>)}
    </g>;
}

export function MarkPreview({ mark, color, opacity }: { mark: MarkGeometry; color: string; opacity: number }) {
  return <svg className="mark-preview" viewBox={`0 0 ${mark.pageWidth} ${mark.pageHeight}`} preserveAspectRatio="none" aria-hidden="true" style={{ opacity }}><MarkShape mark={mark} color={color}/></svg>;
}

interface PathGesture { points: MarkPoint[]; bounds: DOMRect; settings: MarkSettings }
export function MarkLayer({ settings, pageWidth, pageHeight, disabled, onBegin, onComplete }: {
  settings: MarkSettings; pageWidth: number; pageHeight: number; disabled: boolean;
  onBegin: () => void; onComplete: (mark: MarkGeometry, settings: MarkSettings) => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<MarkGeometry | null>(null);
  const gesture = useRef<(PathGesture & { pointer: number }) | null>(null);
  const path = useRef<PathGesture | null>(null);
  const latest = useRef({ disabled, pageWidth, pageHeight, onComplete });
  latest.current = { disabled, pageWidth, pageHeight, onComplete };
  const reset = () => { gesture.current = null; path.current = null; setPreview(null); };
  const finishPath = () => {
    const active = path.current;
    if (!active) return;
    const current = latest.current;
    const mark = createMarkGeometry(active.points, active.settings, current.pageWidth, current.pageHeight);
    reset();
    if (mark && !current.disabled) current.onComplete(mark, active.settings);
  };
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!gesture.current && !path.current) return;
      if ((event.target as HTMLElement)?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); reset(); }
      else if (path.current && event.key === 'Enter') { event.preventDefault?.(); event.stopPropagation?.(); finishPath(); }
      else if (path.current && event.key === 'Backspace') {
        event.preventDefault?.(); event.stopPropagation?.();
        path.current.points.pop();
        if (!path.current.points.length) reset();
        else setPreview(createMarkGeometry(path.current.points, path.current.settings, latest.current.pageWidth, latest.current.pageHeight));
      }
    };
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, []);
  useEffect(() => { reset(); }, [disabled, settings.tool, pageWidth, pageHeight]);
  const point = (event: { clientX: number; clientY: number }, bounds: DOMRect) => markPoint((event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
  const pathPoint = (event: { clientX: number; clientY: number; shiftKey: boolean }, active: PathGesture) => constrainedMarkPoint(active.points.at(-1)!, point(event, active.bounds), active.settings.tool, event.shiftKey, pageWidth, pageHeight);
  const appendPoint = (active: PathGesture, next: MarkPoint) => {
    const last = active.points.at(-1)!;
    if (active.points.length < 2000 && Math.hypot((next.x - last.x) * active.bounds.width, (next.y - last.y) * active.bounds.height) >= 1) active.points.push(next);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (path.current) {
      event.preventDefault(); event.stopPropagation();
      const active = path.current, next = pathPoint(event, active);
      setPreview(createMarkGeometry([...active.points, next], active.settings, pageWidth, pageHeight));
      return;
    }
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const next = constrainedMarkPoint(active.points[0], point(event, active.bounds), active.settings.tool, event.shiftKey, pageWidth, pageHeight);
    if (active.settings.tool === 'pen') appendPoint(active, next);
    else active.points = [active.points[0], next];
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
  const activeSettings = path.current?.settings ?? gesture.current?.settings ?? settings;
  return <div className={`mark-drawing-layer ${disabled ? 'disabled' : ''}`} role="group" aria-label={isMultiPointTool(settings.tool)
    ? t('逐点点击绘制折线；双击或 Enter 完成，Backspace 撤回节点，Esc 取消', 'Click nodes; double-click or Enter to finish, Backspace removes the last node, Esc cancels')
    : t('在页面上拖动绘制标记；Esc 取消本次绘制', 'Drag on the page to draw a mark; Esc cancels the stroke')}
    onPointerDown={event => {
      if (disabled || event.button !== 0 || gesture.current || settings.tool === 'select') return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      event.preventDefault(); event.stopPropagation();
      if (isMultiPointTool(settings.tool)) {
        if (event.detail >= 2) return;
        if (!path.current) { onBegin(); path.current = { points: [point(event, bounds)], bounds, settings: { ...settings } }; }
        else appendPoint(path.current, pathPoint(event, path.current));
        setPreview(createMarkGeometry(path.current.points, path.current.settings, pageWidth, pageHeight));
        return;
      }
      onBegin(); event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { pointer: event.pointerId, points: [point(event, bounds)], bounds, settings: { ...settings } };
    }}
    onDoubleClick={event => {
      if (!path.current || disabled) return;
      event.preventDefault(); event.stopPropagation();
      appendPoint(path.current, pathPoint(event, path.current)); finishPath();
    }}
    onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => { if (path.current) reset(); else finish(event, true); }} onLostPointerCapture={event => finish(event, true)}>
    {preview && <MarkPreview mark={preview} color={activeSettings.color} opacity={activeSettings.opacity}/>}
  </div>;
}
