// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import { usePageImage } from '../usePageImage';
import { useI18n } from '../i18n';
import { buildDocumentLayout, captureViewAnchor, pageAtPosition, restoreViewAnchor, visiblePageSize, wheelZoom } from '../viewerGeometry';
import type { ViewAnchor, ViewerZoom, ViewportSize } from '../viewerGeometry';
import type { WorkspacePage } from '../types';
import './reader-experience.css';

function PageRaster({ page, width, index, total, controls, onActivate }: {
  page: WorkspacePage; width: number; index: number; total: number;
  controls: (page: WorkspacePage, ready: boolean, loading: boolean) => ReactNode; onActivate: (id: string) => void;
}) {
  const { t } = useI18n();
  const targetWidth = Math.min(2400, Math.round(width * Math.min(window.devicePixelRatio || 1, 1.5)));
  const { image, error, loading } = usePageImage(page, targetWidth, true);
  return <><div className={`pdf-sheet ${loading ? 'is-loading' : ''}`} onPointerDownCapture={() => onActivate(page.id)}>
    {image ? <img className="pdf-page-image" src={image.dataUrl} alt={t(`文档第 ${index + 1} 页`, `Document page ${index + 1}`)} draggable={false}/> : error ? <div className="page-placeholder error"><CircleAlert size={28}/><h3>{t('这一页未能加载', 'This page could not be loaded')}</h3><p>{t(error)}</p></div> : <div className="page-placeholder"><LoaderCircle size={27} className="spin"/><p>{t(`正在呈现第 ${index + 1} 页`, `Rendering page ${index + 1}`)}</p></div>}
    {controls(page, Boolean(image) && !error, loading)}
  </div><div className="under-page-label">{String(index + 1).padStart(2, '0')} <span>/</span> {String(total).padStart(2, '0')}</div></>;
}

export interface PageNavigation { id: string; sequence: number }

/** Exact-size virtual pages preserve native wheel scrolling without rendering the entire PDF. */
export function PdfViewer({ pages, zoom, navigation, onZoom, onSize, onActiveChange, controls, interactionBlocked = false }: {
  pages: WorkspacePage[]; zoom: ViewerZoom; navigation: PageNavigation | null;
  onZoom: (zoom: ViewerZoom) => void; onSize: (size: ViewportSize) => void;
  onActiveChange: (id: string) => void; controls: (page: WorkspacePage, ready: boolean, loading: boolean) => ReactNode;
  interactionBlocked?: boolean;
}) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<ViewportSize>({ width: 800, height: 600 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const layout = useMemo(() => buildDocumentLayout(pages, size, zoom), [pages, size, zoom]);
  const previous = useRef({ layout, size });
  const zoomAnchor = useRef<ViewAnchor | null>(null);
  const navigationSequence = useRef(-1);
  const navigationPosition = useRef<{ id: string; top: number } | null>(null);
  const frame = useRef(0);
  const reportedId = useRef('');
  const latest = useRef({ layout, zoom, onZoom, onActiveChange, interactionBlocked });
  latest.current = { layout, zoom, onZoom, onActiveChange, interactionBlocked };
  const reportScroll = () => {
    const surface = viewport.current;
    if (!surface) return;
    const next = { left: surface.scrollLeft, top: surface.scrollTop };
    setScroll(next);
    const pinned = navigationPosition.current;
    if (pinned && Math.abs(pinned.top - next.top) > 1) navigationPosition.current = null;
    const row = navigationPosition.current ? latest.current.layout.pages.find(page => page.id === navigationPosition.current!.id) : pageAtPosition(latest.current.layout.pages, next.top + Math.min(surface.clientHeight * .35, 280));
    if (row && !latest.current.interactionBlocked && row.id !== reportedId.current) {
      reportedId.current = row.id; latest.current.onActiveChange(row.id);
    }
  };
  useEffect(() => {
    const surface = viewport.current;
    if (!surface) return;
    const observer = new ResizeObserver(() => {
      const next = { width: surface.clientWidth, height: surface.clientHeight };
      if (next.width > 0 && next.height > 0) { setSize(old => old.width === next.width && old.height === next.height ? old : next); onSize(next); }
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, [onSize]);
  useLayoutEffect(() => {
    const surface = viewport.current;
    if (!surface) return;
    const old = previous.current;
    const nextNavigation = navigation && navigation.sequence !== navigationSequence.current;
    if (nextNavigation) {
      const row = layout.pages.find(page => page.id === navigation.id);
      if (row) {
        surface.scrollTop = Math.max(0, row.top - 24);
        surface.scrollLeft = Math.max(0, row.left + row.width / 2 - size.width / 2);
        navigationSequence.current = navigation.sequence; reportedId.current = row.id;
        navigationPosition.current = { id: row.id, top: surface.scrollTop };
      }
      zoomAnchor.current = null;
    } else if (old.layout !== layout) {
      const resized = old.size.width !== size.width || old.size.height !== size.height;
      const keepDocumentStart = resized && surface.scrollTop <= 1 && !zoomAnchor.current;
      const anchor = zoomAnchor.current ?? captureViewAnchor(old.layout, { left: surface.scrollLeft, top: surface.scrollTop }, { x: old.size.width / 2, y: old.size.height / 2 });
      if (anchor) {
        if (resized) { anchor.viewportX = size.width / 2; anchor.viewportY = size.height / 2; }
        const restored = restoreViewAnchor(layout, anchor);
        if (restored) { surface.scrollLeft = restored.left; surface.scrollTop = keepDocumentStart ? 0 : restored.top; }
      }
      zoomAnchor.current = null;
    }
    previous.current = { layout, size };
    reportScroll();
  }, [layout, size, navigation]);
  useEffect(() => {
    const surface = viewport.current;
    if (!surface) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault(); // Prevent WebView's own whole-interface zoom.
      if (!event.deltaY || event.buttons || latest.current.interactionBlocked) return;
      const bounds = surface.getBoundingClientRect();
      const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const anchor = captureViewAnchor(latest.current.layout, { left: surface.scrollLeft, top: surface.scrollTop }, point);
      if (!anchor) return;
      const row = latest.current.layout.pages.find(page => page.id === anchor.id)!;
      const source = pages.find(page => page.id === anchor.id);
      if (!source) return;
      const current = typeof latest.current.zoom === 'number' ? latest.current.zoom : row.width / visiblePageSize(source).width * 100;
      const next = wheelZoom(current, event.deltaY, event.deltaMode);
      if (next !== latest.current.zoom) { zoomAnchor.current = anchor; latest.current.zoom = next; latest.current.onZoom(next); }
    };
    surface.addEventListener('wheel', handleWheel, { passive: false });
    return () => surface.removeEventListener('wheel', handleWheel);
  }, [pages]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const visibleRows = layout.pages.filter(row => row.top + row.height >= scroll.top - 650 && row.top <= scroll.top + size.height + 650);
  return <div ref={viewport} className="page-viewport continuous-viewport" role="region" aria-label={t('PDF 连续阅读视口，Ctrl 加滚轮缩放', 'Continuous PDF reader; Ctrl plus wheel zooms')} tabIndex={0}
    onPointerDownCapture={event => { if (event.target instanceof HTMLElement && !event.target.closest('button, input, select, textarea, [role="button"]')) event.currentTarget.focus({ preventScroll: true }); }}
    onKeyDown={event => {
      if (event.key === ' ' && event.target === event.currentTarget) { event.preventDefault(); event.currentTarget.scrollBy({ top: (event.shiftKey ? -1 : 1) * event.currentTarget.clientHeight * .85 }); }
    }}
    onScroll={() => { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(reportScroll); }}>
    <div className="continuous-stage" style={{ width: layout.width, height: layout.height }}>
      {visibleRows.map(row => <div key={row.id} className="continuous-page" data-reader-page={row.index + 1} style={{ left: row.left, top: row.top, width: row.width, height: row.height }}>
        <PageRaster page={pages[row.index]} width={row.width} index={row.index} total={pages.length} controls={controls} onActivate={onActiveChange}/>
      </div>)}
    </div>
  </div>;
}
