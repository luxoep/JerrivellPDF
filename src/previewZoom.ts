// SPDX-License-Identifier: MIT OR Apache-2.0
// Local preview geometry only: zooming never requests another PDF/image raster.
export const MIN_PREVIEW_ZOOM = .25;
export const MAX_PREVIEW_ZOOM = 8;
const PADDING = 12;
export interface PreviewLayout {
  scale: number; viewportWidth: number; viewportHeight: number;
  fitWidth: number; fitHeight: number;
  paperWidth: number; paperHeight: number; left: number; top: number;
  extentWidth: number; extentHeight: number; scrollLeft: number; scrollTop: number;
}
const positive = (value: number) => Number.isFinite(value) && value > 0 ? value : 1;
export const clampPreviewZoom = (value: number) => Math.max(MIN_PREVIEW_ZOOM, Math.min(MAX_PREVIEW_ZOOM, Number.isFinite(value) ? value : 1));
export function previewLayout(width: number, height: number, viewportWidth: number, viewportHeight: number, scale = 1, fitWidth = viewportWidth, fitHeight = viewportHeight): PreviewLayout {
  width = positive(width); height = positive(height);
  viewportWidth = positive(viewportWidth); viewportHeight = positive(viewportHeight); scale = clampPreviewZoom(scale);
  fitWidth = positive(fitWidth); fitHeight = positive(fitHeight);
  const fit = Math.min(Math.max(1, fitWidth - PADDING * 2) / width, Math.max(1, fitHeight - PADDING * 2) / height);
  const paperWidth = width * fit * scale, paperHeight = height * fit * scale;
  return { scale, viewportWidth, viewportHeight, fitWidth, fitHeight, paperWidth, paperHeight,
    left: Math.max(PADDING, (viewportWidth - paperWidth) / 2), top: Math.max(PADDING, (viewportHeight - paperHeight) / 2),
    extentWidth: Math.max(viewportWidth, paperWidth + PADDING * 2), extentHeight: Math.max(viewportHeight, paperHeight + PADDING * 2), scrollLeft: 0, scrollTop: 0 };
}
export function zoomPreviewAt(previous: PreviewLayout, width: number, height: number, scale: number, x: number, y: number,
  viewportWidth = previous.viewportWidth, viewportHeight = previous.viewportHeight,
  fitWidth = viewportWidth, fitHeight = viewportHeight): PreviewLayout {
  const next = previewLayout(width, height, viewportWidth, viewportHeight, scale, fitWidth, fitHeight);
  const horizontal = (previous.scrollLeft + x - previous.left) / previous.paperWidth;
  const vertical = (previous.scrollTop + y - previous.top) / previous.paperHeight;
  next.scrollLeft = Math.max(0, Math.min(next.extentWidth - next.viewportWidth, next.left + horizontal * next.paperWidth - x));
  next.scrollTop = Math.max(0, Math.min(next.extentHeight - next.viewportHeight, next.top + vertical * next.paperHeight - y));
  return next;
}
export function previewWheelScale(scale: number, delta: number, mode: number, viewportHeight: number): number {
  if (!Number.isFinite(delta)) return clampPreviewZoom(scale);
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? positive(viewportHeight) : 1);
  return clampPreviewZoom(scale * Math.exp(-Math.max(-320, Math.min(320, pixels)) * .0018));
}

export function createPreviewZoomController(viewport: HTMLDivElement, extent: HTMLDivElement, paper: HTMLDivElement,
  width: number, height: number, onScale: (scale: number) => void, disabled = false) {
  // The outer box is independent of native scrollbar gutters. clientWidth /
  // clientHeight round fractional CSS pixels and shrink when bars appear;
  // using those as the fit basis caused a resize -> fit -> scrollbar 2-cycle.
  const measure = () => {
    const box = viewport.getBoundingClientRect();
    return { width: viewport.clientWidth, height: viewport.clientHeight,
      fitWidth: Math.max(1, Math.floor(box.width)), fitHeight: Math.max(1, Math.floor(box.height)) };
  };
  const initial = measure();
  let current = previewLayout(width, height, initial.width, initial.height, 1, initial.fitWidth, initial.fitHeight), pending: PreviewLayout | null = null;
  let frame: number | null = null, disposed = false, blocked = disabled, resizePending = false;
  let reportedScale: number | undefined;
  const pointers = new Set<number>();
  // Read-only preview images do not capture the pointer. A release outside the
  // viewport must still unlock zoom; drawing canvases keep their own capture.
  const releaseTarget = viewport.ownerDocument?.defaultView ?? viewport;
  const snapshot = () => pending ?? { ...current, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
  const paint = () => {
    frame = null; if (disposed || !pending) return;
    current = pending; pending = null;
    const write = (element: HTMLElement, name: 'width' | 'height' | 'left' | 'top' | 'overflow', value: string) => { if (element.style[name] !== value) element.style[name] = value; };
    const fitted = current.scale <= 1;
    write(viewport, 'overflow', fitted ? 'hidden' : 'auto');
    // CSS min-size fills the fractional scrollport exactly. Never expand it
    // to a rounded clientWidth/Height, which can itself introduce scrollbars.
    write(extent, 'width', fitted ? '100%' : `${current.paperWidth + PADDING * 2}px`);
    write(extent, 'height', fitted ? '100%' : `${current.paperHeight + PADDING * 2}px`);
    write(paper, 'width', `${current.paperWidth}px`); write(paper, 'height', `${current.paperHeight}px`);
    write(paper, 'left', `${current.left}px`); write(paper, 'top', `${current.top}px`);
    viewport.scrollLeft = current.scrollLeft; viewport.scrollTop = current.scrollTop;
    if (reportedScale !== current.scale) { reportedScale = current.scale; onScale(current.scale); }
  };
  const schedule = (next: PreviewLayout) => { pending = next; if (frame === null) frame = requestAnimationFrame(paint); };
  const resize = () => {
    if (disposed) return;
    if (pointers.size) { resizePending = true; return; }
    const before = snapshot();
    const size = measure();
    if (size.width === before.viewportWidth && size.height === before.viewportHeight && size.fitWidth === before.fitWidth && size.fitHeight === before.fitHeight) return;
    schedule(zoomPreviewAt(before, width, height, before.scale, before.viewportWidth / 2, before.viewportHeight / 2,
      size.width, size.height, size.fitWidth, size.fitHeight));
  };
  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) {
      // A drawing gesture stores its page bounds. Keep that surface stationary
      // until release, including normal wheel input during pointer capture.
      if (pointers.size) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    event.preventDefault(); event.stopPropagation();
    if (blocked || pointers.size) return;
    const before = snapshot(), bounds = viewport.getBoundingClientRect();
    schedule(zoomPreviewAt(before, width, height, previewWheelScale(before.scale, event.deltaY || event.deltaX, event.deltaMode, before.viewportHeight),
      event.clientX - bounds.left - viewport.clientLeft, event.clientY - bounds.top - viewport.clientTop,
      before.viewportWidth, before.viewportHeight, before.fitWidth, before.fitHeight));
  };
  const start = (event: PointerEvent) => {
    if (event.button !== 0) return;
    // Apply a queued zoom before child handlers capture getBoundingClientRect().
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; paint(); }
    pointers.add(event.pointerId);
  };
  const finish = (event: PointerEvent) => { pointers.delete(event.pointerId); if (!pointers.size && resizePending) { resizePending = false; resize(); } };
  viewport.addEventListener('wheel', wheel, { passive: false });
  viewport.addEventListener('pointerdown', start, true);
  for (const type of ['pointerup', 'pointercancel']) releaseTarget.addEventListener(type, finish as EventListener, true);
  viewport.addEventListener('lostpointercapture', finish as EventListener, true);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  observer?.observe(viewport); schedule(current);
  return {
    zoomBy(factor: number) { if (blocked || pointers.size) return; const before = snapshot(); schedule(zoomPreviewAt(before, width, height, before.scale * factor, before.viewportWidth / 2, before.viewportHeight / 2, before.viewportWidth, before.viewportHeight, before.fitWidth, before.fitHeight)); },
    reset() { if (!pointers.size) { const size = measure(); schedule(previewLayout(width, height, size.width, size.height, 1, size.fitWidth, size.fitHeight)); } },
    setDisabled(value: boolean) { blocked = value; },
    destroy() {
      disposed = true; if (frame !== null) cancelAnimationFrame(frame); observer?.disconnect(); pointers.clear();
      viewport.removeEventListener('wheel', wheel); viewport.removeEventListener('pointerdown', start, true);
      for (const type of ['pointerup', 'pointercancel']) releaseTarget.removeEventListener(type, finish as EventListener, true);
      viewport.removeEventListener('lostpointercapture', finish as EventListener, true);
    },
  };
}
