// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import { Check, CircleAlert, FileText, GripVertical, LoaderCircle, Plus } from 'lucide-react';
import { usePageLayers } from '../usePageLayers';
import { LivePageImage } from './LivePageImage';
import { useI18n } from '../i18n';
import type { WorkspacePage } from '../types';

function Thumbnail({ page, index, active, checked, busy, dragged, onSelect, onToggle, gesture }: {
  page: WorkspacePage; index: number; active: boolean; checked: boolean; busy: boolean; dragged: boolean;
  onSelect: (event: MouseEvent) => void; onToggle: () => void;
  gesture: { begin: (event: PointerEvent<HTMLButtonElement>, id: string) => void; move: (event: PointerEvent<HTMLButtonElement>) => void; finish: (event: PointerEvent<HTMLButtonElement>, cancel?: boolean) => void; suppressClick: () => boolean };
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '240px' });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const { layers, loading, error } = usePageLayers(page, 154, visible, true);
  const landscape = page.rotation % 180 === 90 ? page.height > page.width : page.width > page.height;
  const pointerProps = { onPointerDown: (event: PointerEvent<HTMLButtonElement>) => gesture.begin(event, page.id), onPointerMove: gesture.move, onPointerUp: (event: PointerEvent<HTMLButtonElement>) => gesture.finish(event), onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => gesture.finish(event, true), onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => gesture.finish(event, true) };
  return <div ref={root} data-thumbnail-id={page.id} className={`thumbnail-item ${active ? 'is-active' : ''} ${checked ? 'is-selected' : ''} ${dragged ? 'is-being-dragged' : ''}`}>
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
  const gesture = useRef<{ source: string; pointer: number; startX: number; startY: number; x: number; y: number; active: boolean; target: string; side: 'before' | 'after' } | null>(null);
  const frame = useRef(0);
  const suppressUntil = useRef(0);
  const [drag, setDrag] = useState<{ source: string; target: string; side: 'before' | 'after'; y: number } | null>(null);
  const updateTarget = () => {
    const current = gesture.current, surface = list.current;
    if (!current?.active || !surface) return;
    const bounds = surface.getBoundingClientRect();
    const cards = [...surface.querySelectorAll<HTMLElement>('[data-thumbnail-id]')];
    const target = cards.reduce<HTMLElement | null>((nearest, card) => {
      const box = card.getBoundingClientRect();
      const distance = Math.abs(current.y - (box.top + box.height / 2));
      if (!nearest) return card;
      const other = nearest.getBoundingClientRect();
      return distance < Math.abs(current.y - (other.top + other.height / 2)) ? card : nearest;
    }, null);
    if (current.x < bounds.left - 45 || current.x > bounds.right + 70 || current.y < bounds.top - 45 || current.y > bounds.bottom + 45 || !target) {
      current.target = ''; setDrag({ source: current.source, target: '', side: 'before', y: 0 }); return;
    }
    const targetBounds = target.getBoundingClientRect();
    current.target = target.dataset.thumbnailId!;
    current.side = current.y < targetBounds.top + targetBounds.height / 2 ? 'before' : 'after';
    setDrag({ source: current.source, target: current.target, side: current.side, y: (current.side === 'before' ? targetBounds.top : targetBounds.bottom) - bounds.top + surface.scrollTop });
  };
  const autoScroll = () => {
    const current = gesture.current, surface = list.current;
    if (!current?.active || !surface) return;
    const bounds = surface.getBoundingClientRect();
    if (current.x >= bounds.left - 45 && current.x <= bounds.right + 70) {
      const speed = current.y < bounds.top + 48 ? -Math.min(18, (bounds.top + 48 - current.y) * .3) : current.y > bounds.bottom - 48 ? Math.min(18, (current.y - bounds.bottom + 48) * .3) : 0;
      if (speed) { surface.scrollTop += speed; updateTarget(); }
    }
    frame.current = requestAnimationFrame(autoScroll);
  };
  const cancel = () => { gesture.current = null; cancelAnimationFrame(frame.current); setDrag(null); };
  useEffect(() => { if (busy) cancel(); }, [busy]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && gesture.current) { suppressUntil.current = Date.now() + 400; cancel(); } };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); cancelAnimationFrame(frame.current); };
  }, []);
  useEffect(() => {
    if (gesture.current) return;
    const current = [...(list.current?.querySelectorAll<HTMLElement>('[data-thumbnail-id]') ?? [])].find(card => card.dataset.thumbnailId === activeId);
    if (!current || !list.current) return;
    const box = current.getBoundingClientRect(), bounds = list.current.getBoundingClientRect();
    if (box.top < bounds.top || box.bottom > bounds.bottom) list.current.scrollTop += box.top - bounds.top - Math.max(0, (bounds.height - box.height) / 2);
  }, [activeId]);
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
  return <div ref={list} className={`thumbnail-list sortable-thumbnail-list ${drag ? 'is-sorting' : ''}`}>
    {pages.map((page, index) => <Thumbnail key={page.id} page={page} index={index} active={page.id === activeId} checked={selection.has(page.id)} busy={busy} dragged={draggedIds.has(page.id)} gesture={handlers} onSelect={event => onSelect(event, page, index)} onToggle={() => onToggle(page.id)}/>)}
    {drag?.target && !draggedIds.has(drag.target) && <div className="page-insertion-line" style={{ top: drag.y }}><span>{t('放在这里', 'Drop here')}</span></div>}
    <button className="add-page-tile" onClick={onAdd} disabled={busy}><Plus size={19}/><span>{t('添加 PDF', 'Add PDF')}</span></button>
    <span className="sr-only" role="status">{drag ? t(`正在移动 ${draggedIds.size} 页`, `Moving ${draggedIds.size} pages`) : ''}</span>
  </div>;
}
