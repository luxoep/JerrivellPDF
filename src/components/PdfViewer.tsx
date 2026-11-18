// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import { usePageLayers } from '../usePageLayers';
import { LivePageImage } from './LivePageImage';
import { useI18n } from '../i18n';
import { buildDocumentLayout, captureViewAnchor, pageAtPosition, rasterTargetWidth, restoreViewAnchor, visibleRows, wheelZoom, relativeViewerZoom } from '../viewerGeometry';
import type { ViewAnchor, ViewerZoom, ViewportSize } from '../viewerGeometry';
import type { PageOverlay, WorkspacePage } from '../types';
import type { ReaderViewState } from '../documentTabs';
import './reader-experience.css';

function PageRaster({ page, width, index, total, controls, onActivate, visible, pixelRatio }: {
  page: WorkspacePage; width: number; index: number; total: number;
  controls: PageControls; onActivate: (id: string) => void;
  visible: boolean;
  pixelRatio: number;
}) {
  const { t } = useI18n();
  // Nearby wheel ticks share one raster resolution; CSS geometry remains exact.
  const targetWidth = rasterTargetWidth(visible ? width : Math.min(width, 384), visible ? pixelRatio : 1, page);
  const { layers, error, loading, refreshing } = usePageLayers(page, targetWidth, true, false, !visible);
  const [placement, setPlacement] = useState<PageOverlay | null>(null);
  return <><div className="pdf-sheet" aria-busy={loading || refreshing} onPointerDownCapture={() => onActivate(page.id)}>
    {layers ? <LivePageImage page={page} layers={layers} placement={placement} label={t(`文档第 ${index + 1} 页`, `Document page ${index + 1}`)}/> : error ? <div className="page-placeholder error"><CircleAlert size={28}/><h3>{t('这一页未能加载', 'This page could not be loaded')}</h3><p>{t(error)}</p></div> : <div className="page-placeholder"><LoaderCircle size={27} className="spin"/><p>{t(`正在呈现第 ${index + 1} 页`, `Rendering page ${index + 1}`)}</p></div>}
    {layers && error && <div className="page-refresh-status error" role="alert"><CircleAlert size={13}/>{t(error)}</div>}
    {layers && loading && !error && <div className="page-refresh-status" role="status"><LoaderCircle size={13} className="spin"/>{t('正在更新页面内容…', 'Updating page content…')}</div>}
    {controls(page, Boolean(layers) && !error, loading, setPlacement)}
  </div><div className="under-page-label">{String(index + 1).padStart(2, '0')} <span>/</span> {String(total).padStart(2, '0')}</div></>;
}

export interface PageNavigation { id: string; sequence: number }
type PageControls = (page: WorkspacePage, ready: boolean, loading: boolean, onPreview: (placement: PageOverlay | null) => void) => ReactNode;

/** Exact-size virtual pages preserve native wheel scrolling without rendering the entire PDF. */
export function PdfViewer({ pages, zoom, navigation, onZoom, onSize, onActiveChange, controls, interactionBlocked = false, pinnedPageId, captureView, viewRestore }: {
  pages: WorkspacePage[]; zoom: ViewerZoom; navigation: PageNavigation | null;
  onZoom: (zoom: ViewerZoom) => void; onSize: (size: ViewportSize) => void;
  onActiveChange: (id: string) => void; controls: PageControls;
  interactionBlocked?: boolean;
  pinnedPageId?: string;
  captureView?: { current: (() => ReaderViewState | null) | null };
  viewRestore?: { sequence: number; view: ReaderViewState | null } | null;
}) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<ViewportSize>({ width: 800, height: 600 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [pixelRatio, setPixelRatio] = useState(window.devicePixelRatio || 1);
  useEffect(() => {
    let media: MediaQueryList | undefined;
    const refresh = () => {
      const ratio = window.devicePixelRatio || 1;
      setPixelRatio(previous => previous === ratio ? previous : ratio);
      media?.removeEventListener('change', refresh);
      media = typeof window.matchMedia === 'function' ? window.matchMedia(`(resolution: ${ratio}dppx)`) : undefined;
      media?.addEventListener('change', refresh);
    };
    refresh(); window.addEventListener('resize', refresh);
    return () => { window.removeEventListener('resize', refresh); media?.removeEventListener('change', refresh); };
  }, []);
  const geometryKey = useMemo(() => JSON.stringify(pages.map(page => [page.id, page.width, page.height, page.rotation])), [pages]);
  const geometryPages = useMemo(() => pages, [geometryKey]);
  const layout = useMemo(() => buildDocumentLayout(geometryPages, size, zoom), [geometryPages, size, zoom]);
  const previous = useRef({ layout, size });
  const zoomAnchor = useRef<ViewAnchor | null>(null);
  const navigationSequence = useRef(-1);
  const navigationPosition = useRef<{ id: string; top: number } | null>(null);
  const restoredSequence = useRef(-1);
  const frame = useRef(0);
  const reportedId = useRef('');
  const latest = useRef({ pages, layout, zoom, onZoom, onActiveChange, interactionBlocked });
  latest.current = { pages, layout, zoom, onZoom, onActiveChange, interactionBlocked };
  if (captureView) captureView.current = () => {
    const surface = viewport.current;
    return surface ? { atStart: surface.scrollTop <= 1, anchor: captureViewAnchor(latest.current.layout, { left: surface.scrollLeft, top: surface.scrollTop }, { x: surface.clientWidth / 2, y: surface.clientHeight / 2 }) } : null;
  };
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
    if (viewRestore && viewRestore.sequence !== restoredSequence.current) {
      const position = viewRestore.view?.anchor && restoreViewAnchor(layout, { ...viewRestore.view.anchor, viewportX: size.width / 2, viewportY: size.height / 2 });
      surface.scrollLeft = position ? position.left : 0;
      surface.scrollTop = viewRestore.view?.atStart ? 0 : position ? position.top : 0;
      restoredSequence.current = viewRestore.sequence;
      navigationSequence.current = navigation?.sequence ?? -1;
      navigationPosition.current = null; reportedId.current = ''; zoomAnchor.current = null;
    } else if (nextNavigation) {
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
  }, [layout, size, navigation, viewRestore]);
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
      const source = latest.current.pages.find(page => page.id === anchor.id);
      if (!source) return;
      const current = relativeViewerZoom(source,previous.current.size,latest.current.zoom);
      const next = wheelZoom(current, event.deltaY, event.deltaMode);
      if (next !== current) { const value={fitPercent:next};zoomAnchor.current = anchor; latest.current.zoom = value; latest.current.onZoom(value); }
    };
    surface.addEventListener('wheel', handleWheel, { passive: false });
    return () => surface.removeEventListener('wheel', handleWheel);
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const mountedRows = visibleRows(layout.pages, scroll.top - 350, scroll.top + size.height + 350);
  const pinned = pinnedPageId && layout.pages.find(row => row.id === pinnedPageId);
  if (pinned && !mountedRows.some(row => row.id === pinned.id)) mountedRows.push(pinned);
  return <div ref={viewport} className="page-viewport continuous-viewport" role="region" aria-label={t('PDF 连续阅读视口，Ctrl 加滚轮缩放', 'Continuous PDF reader; Ctrl plus wheel zooms')} tabIndex={0}
    onPointerDownCapture={event => { if (event.target instanceof HTMLElement && !event.target.closest('button, input, select, textarea, [role="button"]')) event.currentTarget.focus({ preventScroll: true }); }}
    onKeyDown={event => {
      if (event.key === ' ' && event.target === event.currentTarget) { event.preventDefault(); event.currentTarget.scrollBy({ top: (event.shiftKey ? -1 : 1) * event.currentTarget.clientHeight * .85 }); }
    }}
    onScroll={() => { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(reportScroll); }}>
    <div className="continuous-stage" style={{ width: layout.width, height: layout.height }}>
      {mountedRows.map(row => <div key={row.id} className="continuous-page" data-reader-page={row.index + 1} data-workspace-page-id={row.id} style={{ left: row.left, top: row.top, width: row.width, height: row.height }}>
        <PageRaster page={pages[row.index]} width={row.width} index={row.index} total={pages.length} controls={controls} onActivate={onActiveChange} pixelRatio={pixelRatio} visible={row.top + row.height > scroll.top && row.top < scroll.top + size.height}/>
      </div>)}
    </div>
  </div>;
}
