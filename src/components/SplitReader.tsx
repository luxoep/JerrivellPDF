// SPDX-License-Identifier: MIT OR Apache-2.0
import { useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { Columns2, Maximize, MoveHorizontal, PanelsTopLeft, Rows2 } from 'lucide-react';
import { useI18n } from '../i18n';
import type { SplitDirection } from '../readerSplit';
import './split-reader.css';

const clamp = (value: number) => Math.min(76, Math.max(24, Math.round(value)));

export function ReaderSplitButtons({ direction, disabled, change }: {
  direction?: SplitDirection; disabled: boolean; change: (direction: SplitDirection) => void;
}) {
  const { t } = useI18n();
  const layouts = [
    { mode: 'left-right', label: t('左右分屏', 'Split left and right'), Icon: Columns2 },
    { mode: 'top-bottom', label: t('上下分屏', 'Split top and bottom'), Icon: Rows2 },
  ] as const;
  return <div className="reader-split-buttons" role="group" aria-label={t('阅读分屏', 'Reader split')}>
    {layouts.map(({ mode, label, Icon }) => <button className="document-tab-new" type="button" key={mode}
      disabled={disabled} aria-label={label} title={direction === mode ? t('关闭分屏', 'Close split') : label}
      aria-pressed={direction === mode} onClick={() => change(mode)}><Icon size={16}/></button>)}
  </div>;
}

export function SplitPaneHeader({ title, page, total, active, fittedPage, alternatives, tabId, disabled, activate, fit, choose }: {
  title: string; page: number; total: number; active: boolean; tabId: string; disabled: boolean;
  fittedPage: boolean;
  alternatives: { id: string; title: string }[]; activate: () => void; fit: () => void; choose: (id: string) => void;
}) {
  const { t } = useI18n();
  const fitLabel = fittedPage ? t('此窗格适合宽度', 'Fit this pane to width') : t('此窗格适合整页', 'Fit this pane to page');
  return <header className={`split-pane-header${active ? ' is-active' : ''}`}>
    <button type="button" className="split-pane-title" disabled={disabled || active} title={title} aria-current={active || undefined}
      aria-label={active ? title : t(`编辑 ${title}`, `Edit ${title}`)} onClick={activate}>
      <PanelsTopLeft size={13}/><span>{title}</span>
    </button>
    {active && <span className="split-pane-active">{t('当前', 'Active')}</span>}
    <span className="split-pane-page" aria-label={t(`第 ${page} 页，共 ${total} 页`, `Page ${page} of ${total}`)}>{page} / {total}</span>
    <button type="button" className="split-pane-fit" onClick={fit} disabled={disabled} aria-label={fitLabel} title={fitLabel}>
      {fittedPage ? <MoveHorizontal size={14}/> : <Maximize size={14}/>}
    </button>
    {!active && alternatives.length > 1 && <select className="split-pane-picker" value={tabId} disabled={disabled}
      aria-label={t('更换分屏中的 PDF', 'Change PDF in split')} title={t('更换分屏中的 PDF', 'Change PDF in split')} onChange={event => choose(event.target.value)}>
      {alternatives.map(tab => <option key={tab.id} value={tab.id}>{tab.title}</option>)}
    </select>}
  </header>;
}

export function SplitReaderLayout({ direction, children }: { direction?: SplitDirection; children: ReactNode }) {
  const { t } = useI18n();
  const [ratio, setRatio] = useState({ 'left-right': 50, 'top-bottom': 50 });
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; direction: SplitDirection; value: number } | null>(null);
  const verticalDivider = direction === 'left-right';
  const value = direction ? ratio[direction] : 50;
  const update = (position: number) => { if (direction) setRatio(previous => ({ ...previous, [direction]: clamp(position) })); };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = host.current?.getBoundingClientRect(), gesture = drag.current;
    if (!bounds || !gesture || gesture.id !== event.pointerId || !bounds.width || !bounds.height) return;
    gesture.value = clamp(100 * (verticalDivider ? (event.clientX - bounds.left) / bounds.width : (event.clientY - bounds.top) / bounds.height));
    host.current?.style.setProperty('--reader-divider-preview', `${gesture.value}%`);
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancel: boolean) => {
    if (drag.current?.id !== event.pointerId) return;
    const gesture = drag.current;
    drag.current = null;
    host.current?.style.removeProperty('--reader-divider-preview');
    if (!cancel && gesture.direction === direction) update(gesture.value);
  };
  return <div ref={host} className={`reader-panes${direction ? ` split-${direction}` : ''}`} style={{ '--reader-split': `${value}%` } as CSSProperties}>
    {children}
    {direction && <div className="reader-split-divider" role="separator" tabIndex={0} aria-orientation={verticalDivider ? 'vertical' : 'horizontal'}
      aria-label={t('调节分屏大小', 'Resize the split')} aria-valuemin={24} aria-valuemax={76} aria-valuenow={value}
      title={t('拖动调节空间，双击等分', 'Drag to resize; double-click to reset')} onDoubleClick={() => update(50)}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { id: event.pointerId, direction, value };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={move} onPointerUp={event => { move(event); finish(event, false); }}
      onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
      onKeyDown={event => {
        const backward = verticalDivider ? 'ArrowLeft' : 'ArrowUp';
        const forward = verticalDivider ? 'ArrowRight' : 'ArrowDown';
        if (![backward, forward, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        update(event.key === 'Home' ? 24 : event.key === 'End' ? 76 : value + (event.key === backward ? -5 : 5));
      }}><span/></div>}
  </div>;
}
