// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Download, GripVertical, Plus, Stamp, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n';
import type { FragmentDrop, PdfFragmentItem } from '../pdfFragments';
import { MAX_FRAGMENT_ITEMS, moveFragment } from '../pdfFragments';
import './fragment-tray.css';

interface Props {
  items: PdfFragmentItem[];
  disabled: boolean;
  onChange: (items: PdfFragmentItem[]) => void;
  onPlace: (items: PdfFragmentItem[], drop?: FragmentDrop) => void;
  onSave: (item: PdfFragmentItem) => void;
  onExport: (item: PdfFragmentItem) => void;
}
type Drag = { id: string; pointer: number; startX: number; startY: number; moved: boolean };

export function FragmentTray({ items, disabled, onChange, onPlace, onSave, onExport }: Props) {
  const { t } = useI18n();
  const drag = useRef<Drag | null>(null), suppressClick = useRef(false), frame = useRef(0);
  const [floating, setFloating] = useState<{ item: PdfFragmentItem; x: number; y: number } | null>(null);
  const latest = useRef({ items, disabled, onChange, onPlace }); latest.current = { items, disabled, onChange, onPlace };
  useEffect(() => () => { cancelAnimationFrame(frame.current); drag.current = null; }, []);
  const begin = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault(); suppressClick.current = false;
    drag.current = { id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    if (!active.moved && Math.hypot(event.clientX - active.startX, event.clientY - active.startY) < 5) return;
    active.moved = true; const item = latest.current.items.find(item => item.id === active.id);
    if (!item) return;
    const x = event.clientX, y = event.clientY;
    cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(() => setFloating({ item, x, y }));
  };
  const finish = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    drag.current = null; cancelAnimationFrame(frame.current); setFloating(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    suppressClick.current = active.moved;
    if (cancelled || !active.moved || latest.current.disabled) return;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const page = hit?.closest<HTMLElement>('[data-workspace-page-id]');
    const item = latest.current.items.find(item => item.id === active.id);
    if (page && item) {
      const bounds = page.getBoundingClientRect(), x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height;
      if (x >= 0 && y >= 0 && x <= 1 && y <= 1) latest.current.onPlace([item], { pageId: page.dataset.workspacePageId!, x, y });
      return;
    }
    const row = hit?.closest<HTMLElement>('[data-fragment-row]');
    if (row) latest.current.onChange(moveFragment(latest.current.items, active.id, row.dataset.fragmentRow!, event.clientY > row.getBoundingClientRect().top + row.clientHeight / 2));
  };
  const gestures = (id: string) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => begin(event, id), onPointerMove: move,
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => finish(event),
    onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => finish(event, true),
    onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => finish(event, true),
  });
  const shift = (id: string, offset: number) => {
    const index = items.findIndex(item => item.id === id), target = items[index + offset];
    if (target) onChange(moveFragment(items, id, target.id, offset > 0));
  };
  return <section className="fragment-tray" aria-label={t('PDF 片段列表', 'PDF fragment list')} onKeyDown={event => {
    if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); drag.current = null; suppressClick.current = true; cancelAnimationFrame(frame.current); setFloating(null); }
  }}>
    <header><h3>{t('片段列表', 'Fragments')}</h3><span>{items.length} / {MAX_FRAGMENT_ITEMS}</span></header>
    <p>{t('拖动缩略图到 PDF 放置；拖动手柄调整列表顺序。此列表在本次运行中保留，长期使用请保存到本机库。', 'Drag a thumbnail onto a PDF to place it; drag its handle to reorder. This list lasts for this app session. Save to Library for later sessions.')}</p>
    {!items.length && <div className="fragment-tray-empty">{t('框选后生成片段，每个选区会成为独立项目。', 'Generate fragments after selecting regions. Each region becomes a separate item.')}</div>}
    <ol>{items.map((item, index) => <li key={item.id} data-fragment-row={item.id}>
      <div className="fragment-tray-main"><button className="fragment-grip" {...gestures(item.id)} disabled={disabled}
        aria-label={t(`拖动片段 ${index + 1} 排序`, `Reorder fragment ${index + 1}`)}
        onKeyDown={event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); shift(item.id, event.key === 'ArrowUp' ? -1 : 1); } }}><GripVertical size={15}/></button>
        <button className="fragment-thumbnail oe-checker" {...gestures(item.id)} disabled={disabled} title={t('拖到 PDF，或点击插入当前页', 'Drag onto PDF, or click to place on current page')}
          aria-label={t(`放置片段：${item.name}`, `Place fragment: ${item.name}`)} onClick={() => { if (!suppressClick.current) onPlace([item]); suppressClick.current = false; }}><img src={item.image.dataUrl} alt="" draggable={false}/></button>
        <label><span className="sr-only">{t('片段名称', 'Fragment name')}</span><input maxLength={80} value={item.name} disabled={disabled}
          onChange={event => onChange(items.map(value => value.id === item.id ? { ...value, name: event.target.value } : value))}
          onBlur={() => { if (!item.name.trim()) onChange(items.map(value => value.id === item.id ? { ...value, name: `PDF · ${index + 1}` } : value)); }}/>
          <small>{item.image.width} × {item.image.height} · {item.blendMode === 'multiply' ? t('正片叠底', 'Multiply') : t('正常', 'Normal')}</small></label>
        <button className="fragment-remove" disabled={disabled} aria-label={t(`删除片段：${item.name}`, `Delete fragment: ${item.name}`)} title={t('从列表移除；已放入页面的对象保留', 'Remove from list; objects already placed stay on the page')} onClick={() => onChange(items.filter(value => value.id !== item.id))}><Trash2 size={14}/></button></div>
      <div className="fragment-row-actions"><button disabled={disabled} onClick={() => onPlace([item])}><Plus size={12}/>{t('放置', 'Place')}</button><button disabled={disabled} onClick={() => onSave(item)}><Stamp size={12}/>{t('存入库', 'Save')}</button><button disabled={disabled} onClick={() => onExport(item)}><Download size={12}/>PNG</button><span/><button disabled={disabled || index === 0} aria-label={t('上移片段', 'Move fragment up')} onClick={() => shift(item.id, -1)}><ArrowUp size={12}/></button><button disabled={disabled || index === items.length - 1} aria-label={t('下移片段', 'Move fragment down')} onClick={() => shift(item.id, 1)}><ArrowDown size={12}/></button></div>
    </li>)}</ol>
    {items.length > 1 && <button className="oe-action wide" disabled={disabled} onClick={() => onPlace(items)}><Plus size={14}/>{t(`全部分别插入（${items.length}）`, `Insert all separately (${items.length})`)}</button>}
    {floating && createPortal(<div className="fragment-drag-preview oe-checker" style={{ left: floating.x + 12, top: floating.y + 12 }}><img src={floating.item.image.dataUrl} alt=""/><span>{t('松开放置或排序', 'Release to place or reorder')}</span></div>, document.body)}
  </section>;
}
