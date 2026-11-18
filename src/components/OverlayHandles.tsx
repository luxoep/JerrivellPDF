// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { useI18n } from '../i18n';
import { overlayStep } from '../overlayGeometry';
import { resizedPlacement } from '../placementGeometry';
import type { ResizeHandle } from '../placementGeometry';
import { measureTextFrame, resizeTextFrame } from '../textFrame';
import type { OverlayChangeOptions } from '../editableOverlays';
import type { PageOverlay } from '../types';
import './overlay-handles.css';

type Gesture = { id: string; kind: 'move' | ResizeHandle; startX: number; startY: number; original: PageOverlay; preview: PageOverlay;
  bounds: DOMRect; pointerId: number; moveLinked: boolean; invalid: boolean };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const directions: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Gestures preview locally; one release produces one history entry. */
export function OverlayHandles({ overlays, onChange, disabled = false, pageWidth = 595, pageHeight = 842, selectedId, onSelect,
  freeResize = false, onPreview, onError, onEditingChange }: {
  overlays: PageOverlay[]; onChange: (next: PageOverlay[], options?: OverlayChangeOptions) => void;
  onPreview?: (placement: PageOverlay | null) => void; disabled?: boolean; pageWidth?: number; pageHeight?: number;
  selectedId?: string; onSelect?: (id: string) => void; freeResize?: boolean; onError?: (message: string) => void;
  onEditingChange?: (active: boolean) => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null), gesture = useRef<Gesture | null>(null), frame = useRef(0);
  const [localSelected, setLocalSelected] = useState(''), [preview, setPreview] = useState<PageOverlay | null>(null);
  const [overflow, setOverflow] = useState(false), [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const latest = useRef({ overlays, disabled }); latest.current = { overlays, disabled };
  const editingActive = useRef(false);
  const selected = selectedId ?? localSelected;
  const select = (id: string) => { setLocalSelected(id); onSelect?.(id); };
  const clear = () => { cancelAnimationFrame(frame.current); frame.current = 0; setPreview(null); setOverflow(false); onPreview?.(null); };
  const show = (item: PageOverlay, invalid: boolean) => { setPreview(item); setOverflow(invalid); const shown = { ...item, previewMoveLinked: gesture.current?.moveLinked }; onPreview?.(shown); };
  useEffect(() => () => { cancelAnimationFrame(frame.current); onPreview?.(null); if (editingActive.current) onEditingChange?.(false); }, []);
  useEffect(() => { if (disabled) { gesture.current = null; if (editingActive.current) { editingActive.current = false; onEditingChange?.(false); } setEditing(null); clear(); } }, [disabled]);
  const startEditing = (item: PageOverlay) => { editingActive.current = true; onEditingChange?.(true); setEditing({ id: item.id, content: item.textSource!.content }); };
  const begin = (event: PointerEvent<HTMLDivElement>, item: PageOverlay, kind: Gesture['kind']) => {
    if (event.button !== 0 || !root.current || editing) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }); select(item.id);
    if (disabled || item.locked) return;
    const bounds = root.current.getBoundingClientRect(); if (!bounds.width || !bounds.height) return;
    gesture.current = { id: item.id, kind, original: item, preview: item, startX: event.clientX, startY: event.clientY,
      bounds, pointerId: event.pointerId, moveLinked: event.altKey, invalid: false };
    event.currentTarget.setPointerCapture(event.pointerId); show(item, false);
  };
  const move = (event: PointerEvent<HTMLDivElement>, immediate = false) => {
    const current = gesture.current; if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (!immediate && current.original.textSource && current.kind !== 'move') {
      // Coalesce high-frequency pointer events before measuring line wrapping.
      // Capture primitives: React clears currentTarget after the event returns.
      const sample = { clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, shiftKey: event.shiftKey,
        preventDefault() {}, stopPropagation() {} } as PointerEvent<HTMLDivElement>;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => { frame.current = 0; if (gesture.current === current) move(sample, true); });
      return;
    }
    const dx = (event.clientX - current.startX) / current.bounds.width, dy = (event.clientY - current.startY) / current.bounds.height;
    const item = current.original; let next: PageOverlay = item, invalid = false;
    if (current.kind === 'move') {
      let left = 0, top = 0, right = 1 - item.width, bottom = 1 - item.height;
      if (current.moveLinked) for (const line of overlays.filter(line => line.leaderFor === item.id)) {
        left = Math.max(left, item.x - line.x); top = Math.max(top, item.y - line.y);
        right = Math.min(right, item.x + 1 - line.x - line.width); bottom = Math.min(bottom, item.y + 1 - line.y - line.height);
      }
      next = { ...item, x: clamp(item.x + dx, left, right), y: clamp(item.y + dy, top, bottom) };
    } else if (item.textSource) {
      try {
        const measured = measureTextFrame(resizeTextFrame(item, resizedPlacement(item, current.kind, dx, dy, pageWidth, pageHeight), pageWidth, pageHeight), pageWidth, pageHeight);
        next = measured.overlay; invalid = measured.overflow;
      } catch { next = resizedPlacement(item, current.kind, dx, dy, pageWidth, pageHeight); invalid = true; }
    } else if (freeResize && !event.shiftKey) next = { ...item, width: clamp(item.width + dx, .001, 1 - item.x), height: clamp(item.height + dy, .001, 1 - item.y) };
    else {
      const sx = (item.width + dx) / item.width, sy = (item.height + dy) / item.height;
      const requested = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
      const max = Math.min((1 - item.x) / item.width, (1 - item.y) / item.height), min = Math.min(max, Math.max(.015 / item.width, .015 / item.height));
      const scale = clamp(requested, min, max); next = { ...item, width: item.width * scale, height: item.height * scale };
    }
    current.preview = next; current.invalid = invalid;
    cancelAnimationFrame(frame.current);
    if (immediate) show(next, invalid);
    else frame.current = requestAnimationFrame(() => { frame.current = 0; if (gesture.current === current) show(current.preview, current.invalid); });
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const current = gesture.current; if (!current || current.pointerId !== event.pointerId) return;
    if (!cancel) move(event, true);
    event.stopPropagation(); gesture.current = null; clear();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancel || latest.current.disabled || !latest.current.overlays.some(item => item.id === current.id && !item.locked)) return;
    if (current.invalid) { onError?.(t('文字框空间不足。请加宽或加高，文字字号保持不变。', 'The text does not fit. Widen or heighten the frame; its font size stays unchanged.')); return; }
    if (JSON.stringify(current.preview) !== JSON.stringify(current.original)) onChange(latest.current.overlays.map(item => item.id === current.id ? current.preview : item), { moveLinked: current.moveLinked });
  };
  const finishEditing = (cancel = false, autoHeight = false) => {
    const edit = editing; if (!edit) return;
    const item = latest.current.overlays.find(item => item.id === edit.id);
    let next = item;
    if (!cancel && !disabled && item?.textSource && !item.locked && (item.textSource.content !== edit.content || autoHeight)) {
      if (!edit.content.trim()) { onError?.(t('文字不能为空；删除对象请使用 Delete。', 'Text cannot be empty. Use Delete to remove the object.')); return; }
      next = { ...item, textSource: { ...item.textSource, content: edit.content, ...(autoHeight && item.textSource.frame ? { frame: { ...item.textSource.frame, autoHeight: true } } : {}) } };
      try { if (measureTextFrame(next, pageWidth, pageHeight).overflow) throw new Error(); }
      catch { onError?.(t('文字溢出，输入内容已保留。可选择“自动加高并完成”，或减少文字。', 'Text overflows; your draft is retained. Choose Auto-height and finish, or reduce the text.')); return; }
    }
    editingActive.current = false; onEditingChange?.(false); setEditing(null); clear();
    if (!cancel && !disabled && next && next !== item) onChange(latest.current.overlays.map(value => value.id === next!.id ? next! : value));
  };
  return <div ref={root} className="overlay-interaction-layer" aria-label={t('添加内容的位置控制', 'Added content placement controls')}>
    {overlays.map((item, index) => {
      const placed = preview?.id === item.id ? preview : item, isEditing = editing?.id === item.id;
      return <div key={item.id} role="button" tabIndex={disabled ? -1 : 0} aria-label={item.locked ? t(`第 ${index + 1} 个添加内容已锁定`, `Added item ${index + 1} is locked`) : t(`移动第 ${index + 1} 个添加内容`, `Move added item ${index + 1}`)}
        aria-disabled={disabled || item.locked} className={`overlay-placement-handle ${selected === item.id ? 'selected' : ''} ${preview?.id === item.id ? 'dragging' : ''} ${item.locked ? 'overlay-object-locked' : ''} ${overflow && preview?.id === item.id ? 'text-frame-overflow' : ''}`}
        style={{ left: `${placed.x * 100}%`, top: `${placed.y * 100}%`, width: `${placed.width * 100}%`, height: `${placed.height * 100}%` }}
        onFocus={() => select(item.id)} onPointerDown={event => begin(event, item, 'move')} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
        onDoubleClick={event => { if (!item.textSource || item.locked || disabled) return; event.preventDefault(); event.stopPropagation(); gesture.current = null; clear(); startEditing(item); }}
        onKeyDown={event => {
          if (isEditing) return;
          if (event.key === 'Escape') { gesture.current = null; clear(); event.stopPropagation(); return; }
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation(); if (disabled || item.locked) return;
            const dx = overlayStep(pageWidth, event.shiftKey), dy = overlayStep(pageHeight, event.shiftKey);
            const x = clamp(item.x + (event.key === 'ArrowLeft' ? -dx : event.key === 'ArrowRight' ? dx : 0), 0, 1 - item.width);
            const y = clamp(item.y + (event.key === 'ArrowUp' ? -dy : event.key === 'ArrowDown' ? dy : 0), 0, 1 - item.height);
            if (x !== item.x || y !== item.y) onChange(overlays.map(value => value.id === item.id ? { ...value, x, y } : value));
          } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault(); event.stopPropagation(); if (!disabled && !item.locked) onChange(overlays.filter(value => value.id !== item.id));
          } else if (event.key === 'Enter' && item.textSource && !disabled && !item.locked) { event.preventDefault(); event.stopPropagation(); startEditing(item); }
        }}>
        <span className="overlay-item-number">{item.textSource ? t('文字', 'Text') : index + 1}</span>
        {overflow && preview?.id === item.id && <span className="text-frame-warning" role="status">{t('文字溢出，请扩大文字框', 'Text overflows; enlarge the frame')}</span>}
        {!disabled && !item.locked && !isEditing && (item.textSource ? directions : ['se'] as ResizeHandle[]).map(direction => <div key={direction} role="button" aria-label={t(`调整${direction}方向文字框`, `Resize ${direction} frame`)} className={`overlay-resize-handle handle-${direction}`} tabIndex={0}
          title={item.textSource ? t('调整文字框，字号不变；双击文字编辑；Alt 拖动整体移动引线', 'Resize without changing font size; double-click edits; Alt-drag moves the leader too') : freeResize ? t('拖动调整宽高，Shift 保持比例', 'Drag to resize; Shift keeps proportions') : t('拖动等比调整大小', 'Drag to resize proportionally')}
          onPointerDown={event => begin(event, item, direction)} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)} />)}
        {isEditing && <div className="inline-text-editor" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
          <textarea autoFocus aria-label={t('直接编辑文字', 'Edit text in place')} maxLength={4000} value={editing.content} onChange={event => setEditing({ ...editing, content: event.target.value })} onBlur={() => finishEditing()}
            onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); finishEditing(true); } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); finishEditing(); } }}/>
          <span>{t('Ctrl+Enter 完成 · Esc 取消', 'Ctrl+Enter finishes · Esc cancels')}</span><button type="button" onPointerDown={event => event.preventDefault()} onClick={() => finishEditing(false, true)}>{t('自动加高并完成', 'Auto-height and finish')}</button>
        </div>}
      </div>;
    })}
  </div>;
}
