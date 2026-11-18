// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import { Check, CircleAlert, FileText, GripVertical, LoaderCircle, Plus } from 'lucide-react';
import { usePageLayers } from '../usePageLayers';
import { LivePageImage } from './LivePageImage';
import { useI18n } from '../i18n';
import { buildThumbnailLayout, visibleRows } from '../viewerGeometry';
import type { WorkspacePage } from '../types';

function Thumbnail({ page, index, top, height, active, checked, busy, dragged, onSelect, onToggle, gesture }: {
  page: WorkspacePage; index: number; active: boolean; checked: boolean; busy: boolean; dragged: boolean;
  top: number; height: number;
  onSelect: (event: MouseEvent) => void; onToggle: () => void;
  gesture: { begin: (event: PointerEvent<HTMLButtonElement>, id: string) => void; move: (event: PointerEvent<HTMLButtonElement>) => void; finish: (event: PointerEvent<HTMLButtonElement>, cancel?: boolean) => void; suppressClick: () => boolean };
}) {
  const { t } = useI18n();
  const { layers, loading, error } = usePageLayers(page, 154, true, true);
  const landscape = page.rotation % 180 === 90 ? page.height > page.width : page.width > page.height;
  const pointerProps = { onPointerDown: (event: PointerEvent<HTMLButtonElement>) => gesture.begin(event, page.id), onPointerMove: gesture.move, onPointerUp: (event: PointerEvent<HTMLButtonElement>) => gesture.finish(event), onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => gesture.finish(event, true), onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => gesture.finish(event, true) };
  return <div data-thumbnail-id={page.id} style={{ position: 'absolute', top, height, marginBottom: 0 }} className={`thumbnail-item ${active ? 'is-active' : ''} ${checked ? 'is-selected' : ''} ${dragged ? 'is-being-dragged' : ''}`}>
    <button className={`thumbnail-check ${checked ? 'checked' : ''}`} title={checked ? t(`取消选择第 ${index + 1} 页`, `Deselect page ${index + 1}`) : t(`选择第 ${index + 1} 页`, `Select page ${index + 1}`)} aria-label={checked ? t(`取消选择第 ${index + 1} 页`, `Deselect page ${index + 1}`) : t(`选择第 ${index + 1} 页`, `Select page ${index + 1}`)} aria-pressed={checked} onClick={onToggle} disabled={busy}>{checked && <Check size={11} strokeWidth={3}/>}</button>
    <button className="thumbnail-button" {...pointerProps} onClick={event => { if (!gesture.suppressClick()) onSelect(event); }} aria-label={t(`转到第 ${index + 1} 页`, `Go to page ${index + 1}`)} aria-current={active ? 'page' : undefined} disabled={busy}>
      <div className={`thumbnail-sheet ${landscape ? 'landscape' : ''}`}>{layers ? <LivePageImage page={page} layers={layers} label={t(`第 ${index + 1} 页缩略图`, `Page ${index + 1} thumbnail`)}/> : error ? <CircleAlert size={18}/> : loading ? <LoaderCircle className="spin" size={18}/> : <FileText size={22} strokeWidth={1}/>}</div>
      <span className="thumbnail-number">{String(index + 1).padStart(2, '0')}<span className="thumbnail-current-dot"/></span>
    </button>
    <button className="thumbnail-grip" {...pointerProps} aria-label={t(`拖动第 ${index + 1} 页调整顺序`, `Drag page ${index + 1} to reorder`)} title={t('拖动排序；多选后可一起移动，也可使用 Alt + 方向键', 'Drag to reorder; selected pages move together. Alt + arrows also reorders.')} disabled={busy} onClick={() => gesture.suppressClick()}><GripVertical size={14}/></button>
  </div>;
}

/** Pointer-based sorting works alongside Tauri's native OS file drop handler on Windows. */
export function PageThumbnails({ pages, activeId, selection, busy, onSelect, onToggle, onReorder, onAdd }: {
  pages: WorkspacePage[]; activeId: string; selection: ReadonlySet<string>; busy: boolean;
  onSelect: (event: MouseEvent, page: WorkspacePage, index: number) => void; onToggle: (id: string) => void;
  onReorder: (source: string, target: string, side: 'before' | 'after') => void; onAdd: () => void;
}) {
  const { t } = useI18n();
  const list = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const geometryKey = useMemo(() => JSON.stringify(pages.map(page => [page.id, page.width, page.height, page.rotation])), [pages]);
  const layout = useMemo(() => buildThumbnailLayout(pages), [geometryKey]);
  const rowById = useMemo(() => new Map(layout.rows.map(row => [row.id, row])), [layout]);
  const gesture = useRef<{ source: string; pointer: number; startX: number; startY: number; x: number; y: number; active: boolean; target: string; side: 'before' | 'after' } | null>(null);
  const frame = useRef(0);
  const scrollFrame = useRef(0);
  const suppressUntil = useRef(0);
  const [drag, setDrag] = useState<{ source: string; target: string; side: 'before' | 'after'; y: number } | null>(null);
  const updateTarget = () => {
    const current = gesture.current, surface = list.current;
    if (!current?.active || !surface) return;
    const bounds = surface.getBoundingClientRect();
    const y = current.y - bounds.top + surface.scrollTop;
    // Binary lookup works even while dragging towards an unmounted page.
    const nearby = visibleRows(layout.rows, y - 220, y + 220);
    const target = nearby.reduce<(typeof layout.rows)[number] | null>((nearest, row) => !nearest || Math.abs(y - row.top - row.height / 2) < Math.abs(y - nearest.top - nearest.height / 2) ? row : nearest, null);
    if (current.x < bounds.left - 45 || current.x > bounds.right + 70 || current.y < bounds.top - 45 || current.y > bounds.bottom + 45 || !target) {
      current.target = ''; setDrag({ source: current.source, target: '', side: 'before', y: 0 }); return;
    }
    current.target = target.id;
    current.side = y < target.top + target.height / 2 ? 'before' : 'after';
    const next = { source: current.source, target: current.target, side: current.side, y: current.side === 'before' ? target.top : target.top + target.height };
    setDrag(old => old?.source === next.source && old.target === next.target && old.side === next.side && old.y === next.y ? old : next);
  };
  const autoScroll = () => {
    const current = gesture.current, surface = list.current;
    if (!current?.active || !surface) return;
    const bounds = surface.getBoundingClientRect();
    if (current.x >= bounds.left - 45 && current.x <= bounds.right + 70) {
      const speed = current.y < bounds.top + 48 ? -Math.min(18, (bounds.top + 48 - current.y) * .3) : current.y > bounds.bottom - 48 ? Math.min(18, (current.y - bounds.bottom + 48) * .3) : 0;
      if (speed) { surface.scrollTop += speed; setView(old => ({ ...old, top: surface.scrollTop })); }
    }
    updateTarget();
    frame.current = requestAnimationFrame(autoScroll);
  };
  const cancel = () => { gesture.current = null; cancelAnimationFrame(frame.current); setDrag(null); };
  useEffect(() => { if (busy) cancel(); }, [busy]);
  useEffect(() => {
    const surface = list.current;
    if (!surface || typeof ResizeObserver === 'undefined') return;
    const update = () => setView(old => ({ top: surface.scrollTop, height: surface.clientHeight || old.height }));
    const observer = new ResizeObserver(update); observer.observe(surface); update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && gesture.current) { suppressUntil.current = Date.now() + 400; cancel(); } };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); cancelAnimationFrame(frame.current); cancelAnimationFrame(scrollFrame.current); };
  }, []);
  useEffect(() => {
    if (gesture.current) return;
    const row = rowById.get(activeId), surface = list.current;
    if (!row || !surface) return;
    const height = surface.clientHeight || view.height;
    if (row.top < surface.scrollTop || row.top + row.height > surface.scrollTop + height) {
      surface.scrollTop = Math.max(0, row.top - Math.max(0, (height - row.height) / 2));
      setView(old => ({ ...old, top: surface.scrollTop }));
    }
  }, [activeId, rowById]);
  const handlers = {
    begin: (event: PointerEvent<HTMLButtonElement>, id: string) => {
      if (busy || event.button !== 0 || gesture.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { source: id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, target: '', side: 'before' };
    },
    move: (event: PointerEvent<HTMLButtonElement>) => {
      const current = gesture.current;
      if (!current || current.pointer !== event.pointerId) return;
      current.x = event.clientX; current.y = event.clientY;
      if (!current.active && Math.hypot(current.x - current.startX, current.y - current.startY) >= 7) { current.active = true; frame.current = requestAnimationFrame(autoScroll); }
      if (current.active) { event.preventDefault(); updateTarget(); }
    },
    finish: (event: PointerEvent<HTMLButtonElement>, aborted = false) => {
      const current = gesture.current;
      if (!current || current.pointer !== event.pointerId) return;
      if (current.active) { suppressUntil.current = Date.now() + 400; event.preventDefault(); }
      cancel();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (current.active && !aborted && !busy && current.target) onReorder(current.source, current.target, current.side);
    },
    suppressClick: () => Date.now() < suppressUntil.current,
  };
  const draggedIds = drag ? selection.has(drag.source) ? selection : new Set([drag.source]) : new Set<string>();
  const mounted = visibleRows(layout.rows, view.top - 260, view.top + view.height + 260);
  // Keep a captured pointer's source mounted until release, even when it has
  // scrolled outside the window; otherwise Windows would cancel the drag.
  const sourceRow = gesture.current ? rowById.get(gesture.current.source) : undefined;
  if (sourceRow && !mounted.includes(sourceRow)) mounted.push(sourceRow);
  return <div ref={list} className={`thumbnail-list sortable-thumbnail-list ${drag ? 'is-sorting' : ''}`} onScroll={() => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => { scrollFrame.current = 0; const surface = list.current; if (surface) setView({ top: surface.scrollTop, height: surface.clientHeight || view.height }); });
  }}>
    <div className="thumbnail-virtual-stage" style={{ position: 'relative', height: layout.height }}>
    {mounted.map(row => { const page = pages[row.index]; return <Thumbnail key={page.id} page={page} index={row.index} top={row.top} height={row.height} active={page.id === activeId} checked={selection.has(page.id)} busy={busy} dragged={draggedIds.has(page.id)} gesture={handlers} onSelect={event => onSelect(event, page, row.index)} onToggle={() => onToggle(page.id)}/>; })}
    {drag?.target && !draggedIds.has(drag.target) && <div className="page-insertion-line" style={{ top: drag.y }}><span>{t('放在这里', 'Drop here')}</span></div>}
    </div>
    <button className="add-page-tile" onClick={onAdd} disabled={busy}><Plus size={19}/><span>{t('添加 PDF', 'Add PDF')}</span></button>
    <span className="sr-only" role="status">{drag ? t(`正在移动 ${draggedIds.size} 页`, `Moving ${draggedIds.size} pages`) : ''}</span>
  </div>;
}
