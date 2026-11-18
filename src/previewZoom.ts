// SPDX-License-Identifier: MIT OR Apache-2.0
// Local preview geometry only: zooming never requests another PDF/image raster.
export const MIN_PREVIEW_ZOOM = .25;
export const MAX_PREVIEW_ZOOM = 8;
const PADDING = 12;
export interface PreviewLayout {
  scale: number; viewportWidth: number; viewportHeight: number;
  paperWidth: number; paperHeight: number; left: number; top: number;
  extentWidth: number; extentHeight: number; scrollLeft: number; scrollTop: number;
}
const positive = (value: number) => Number.isFinite(value) && value > 0 ? value : 1;
export const clampPreviewZoom = (value: number) => Math.max(MIN_PREVIEW_ZOOM, Math.min(MAX_PREVIEW_ZOOM, Number.isFinite(value) ? value : 1));
export function previewLayout(width: number, height: number, viewportWidth: number, viewportHeight: number, scale = 1): PreviewLayout {
  width = positive(width); height = positive(height);
  viewportWidth = positive(viewportWidth); viewportHeight = positive(viewportHeight); scale = clampPreviewZoom(scale);
  const fit = Math.min(Math.max(1, viewportWidth - PADDING * 2) / width, Math.max(1, viewportHeight - PADDING * 2) / height);
  const paperWidth = width * fit * scale, paperHeight = height * fit * scale;
  return { scale, viewportWidth, viewportHeight, paperWidth, paperHeight,
    left: Math.max(PADDING, (viewportWidth - paperWidth) / 2), top: Math.max(PADDING, (viewportHeight - paperHeight) / 2),
    extentWidth: Math.max(viewportWidth, paperWidth + PADDING * 2), extentHeight: Math.max(viewportHeight, paperHeight + PADDING * 2), scrollLeft: 0, scrollTop: 0 };
}
export function zoomPreviewAt(previous: PreviewLayout, width: number, height: number, scale: number, x: number, y: number,
  viewportWidth = previous.viewportWidth, viewportHeight = previous.viewportHeight): PreviewLayout {
  const next = previewLayout(width, height, viewportWidth, viewportHeight, scale);
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
  let current = previewLayout(width, height, viewport.clientWidth, viewport.clientHeight), pending: PreviewLayout | null = null;
  let frame: number | null = null, disposed = false, blocked = disabled, resizePending = false;
  const pointers = new Set<number>();
  // Read-only preview images do not capture the pointer. A release outside the
  // viewport must still unlock zoom; drawing canvases keep their own capture.
  const releaseTarget = viewport.ownerDocument?.defaultView ?? viewport;
  const snapshot = () => pending ?? { ...current, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
  const paint = () => {
    frame = null; if (disposed || !pending) return;
    current = pending; pending = null;
    extent.style.width = `${current.extentWidth}px`; extent.style.height = `${current.extentHeight}px`;
    paper.style.width = `${current.paperWidth}px`; paper.style.height = `${current.paperHeight}px`;
    paper.style.left = `${current.left}px`; paper.style.top = `${current.top}px`;
    viewport.scrollLeft = current.scrollLeft; viewport.scrollTop = current.scrollTop; onScale(current.scale);
  };
  const schedule = (next: PreviewLayout) => { pending = next; if (frame === null) frame = requestAnimationFrame(paint); };
  const resize = () => {
    if (disposed) return;
    if (pointers.size) { resizePending = true; return; }
    const before = snapshot();
    schedule(zoomPreviewAt(before, width, height, before.scale, before.viewportWidth / 2, before.viewportHeight / 2,
      viewport.clientWidth, viewport.clientHeight));
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
      event.clientX - bounds.left - viewport.clientLeft, event.clientY - bounds.top - viewport.clientTop));
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
    zoomBy(factor: number) { if (blocked || pointers.size) return; const before = snapshot(); schedule(zoomPreviewAt(before, width, height, before.scale * factor, before.viewportWidth / 2, before.viewportHeight / 2)); },
    reset() { if (!pointers.size) schedule(previewLayout(width, height, viewport.clientWidth, viewport.clientHeight)); },
    setDisabled(value: boolean) { blocked = value; },
    destroy() {
      disposed = true; if (frame !== null) cancelAnimationFrame(frame); observer?.disconnect(); pointers.clear();
      viewport.removeEventListener('wheel', wheel); viewport.removeEventListener('pointerdown', start, true);
      for (const type of ['pointerup', 'pointercancel']) releaseTarget.removeEventListener(type, finish as EventListener, true);
      viewport.removeEventListener('lostpointercapture', finish as EventListener, true);
    },
  };
}
