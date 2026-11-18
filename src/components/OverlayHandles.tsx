import { useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { useI18n } from '../i18n';
import { overlayStep } from '../overlayGeometry';
import './overlay-handles.css';

interface Placement {
  id: string;
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  blendMode?: 'normal' | 'multiply';
  rotation?: number;
  locked?: boolean;
}
type Gesture = { id: string; kind: 'move' | 'resize'; startX: number; startY: number; original: Placement; preview: Placement; bounds: DOMRect; pointerId: number };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Placement gestures commit once on release so one drag is one undo action. */
export function OverlayHandles({ overlays, onChange, disabled = false, pageWidth, pageHeight, selectedId, onSelect, freeResize = false, onPreview }: {
  overlays: Placement[];
  onChange: (next: Placement[]) => void;
  onPreview?: (placement: Placement | null) => void;
  disabled?: boolean;
  pageWidth?: number;
  pageHeight?: number;
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** Directly drawn marks can be stretched; Shift retains their proportions. */
  freeResize?: boolean;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [localSelected, setLocalSelected] = useState('');
  const selected = selectedId ?? localSelected;
  const setSelected = (id: string) => { setLocalSelected(id); onSelect?.(id); };
  const [preview, setPreview] = useState<Placement | null>(null);

  const begin = (event: PointerEvent<HTMLDivElement>, item: Placement, kind: Gesture['kind']) => {
    if (event.button !== 0 || !root.current) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    setSelected(item.id);
    if (disabled || item.locked) return;
    const bounds = root.current.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    gesture.current = { id: item.id, kind, original: item, preview: item, startX: event.clientX, startY: event.clientY, bounds, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPreview(item);
    onPreview?.(item);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const dx = (event.clientX - current.startX) / current.bounds.width;
    const dy = (event.clientY - current.startY) / current.bounds.height;
    const item = current.original;
    let next: Placement;
    if (current.kind === 'move') {
      next = { ...item, x: clamp(item.x + dx, 0, 1 - item.width), y: clamp(item.y + dy, 0, 1 - item.height) };
    } else if (freeResize && !event.shiftKey) {
      next = { ...item, width: clamp(item.width + dx, 0.001, 1 - item.x), height: clamp(item.height + dy, 0.001, 1 - item.y) };
    } else {
      const scaleX = (item.width + dx) / item.width;
      const scaleY = (item.height + dy) / item.height;
      const requested = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
      const maximum = Math.min((1 - item.x) / item.width, (1 - item.y) / item.height);
      const minimum = Math.min(maximum, Math.max(0.015 / item.width, 0.015 / item.height));
      const scale = clamp(requested, minimum, maximum);
      next = { ...item, width: item.width * scale, height: item.height * scale };
    }
    current.preview = next;
    setPreview(next);
    onPreview?.(next);
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    gesture.current = null;
    setPreview(null);
    onPreview?.(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancel && !disabled && overlays.some(item => item.id === current.id && !item.locked)) {
      const next = current.preview;
      if (next.x !== current.original.x || next.y !== current.original.y || next.width !== current.original.width || next.height !== current.original.height) {
        onChange(overlays.map(item => item.id === current.id ? next : item));
      }
    }
  };
  return <div ref={root} className="overlay-interaction-layer" aria-label={t('添加内容的位置控制', 'Added content placement controls')}>
    {overlays.map((item, index) => {
      const placed = preview?.id === item.id ? preview : item;
      return <div key={item.id} role="button" tabIndex={disabled ? -1 : 0}
        aria-label={item.locked ? t(`第 ${index + 1} 个添加内容已锁定`, `Added item ${index + 1} is locked`) : t(`移动第 ${index + 1} 个添加内容`, `Move added item ${index + 1}`)}
        aria-disabled={disabled || item.locked}
        className={`overlay-placement-handle ${selected === item.id ? 'selected' : ''} ${preview?.id === item.id ? 'dragging' : ''} ${item.locked ? 'overlay-object-locked' : ''}`}
        style={{ left: `${placed.x * 100}%`, top: `${placed.y * 100}%`, width: `${placed.width * 100}%`, height: `${placed.height * 100}%` }}
        onFocus={() => setSelected(item.id)}
        onPointerDown={event => begin(event, item, 'move')}
        onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
        onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation();
            if (disabled || item.locked) return;
            const dx = overlayStep(pageWidth ?? 0, event.shiftKey), dy = overlayStep(pageHeight ?? 0, event.shiftKey);
            const x = clamp(item.x + (event.key === 'ArrowLeft' ? -dx : event.key === 'ArrowRight' ? dx : 0), 0, 1 - item.width);
            const y = clamp(item.y + (event.key === 'ArrowUp' ? -dy : event.key === 'ArrowDown' ? dy : 0), 0, 1 - item.height);
            if (x !== item.x || y !== item.y) onChange(overlays.map(value => value.id === item.id ? { ...value, x, y } : value));
          } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault(); event.stopPropagation();
            if (disabled || item.locked) return;
            onChange(overlays.filter(value => value.id !== item.id));
          }
        }}>
        <span className="overlay-item-number">{index + 1}</span>
        {!disabled && !item.locked && <div className="overlay-resize-handle" tabIndex={0} title={freeResize ? t('拖动调整宽高，Shift 保持比例', 'Drag to resize; Shift keeps proportions') : t('拖动等比调整大小', 'Drag to resize proportionally')}
          onPointerDown={event => begin(event, item, 'resize')} onPointerMove={move}
          onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} />}
      </div>;
    })}
  </div>;
}
