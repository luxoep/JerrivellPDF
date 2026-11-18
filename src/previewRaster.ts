// SPDX-License-Identifier: MIT OR Apache-2.0
/** Paint one decoded page at its displayed device resolution. The PDF worker
 * remains untouched when the user zooms; only this local bitmap is resampled. */
export function paintPreviewRaster(canvas: HTMLCanvasElement, source: HTMLImageElement, pixelRatio: number) {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? Math.min(pixelRatio, 4) : 1;
  // Keep extreme zoom memory bounded. CSS still presents the entire page and
  // selection coordinates continue to use its unchanged displayed bounds.
  const limit = Math.min(1, 4096 / Math.max(bounds.width * ratio, bounds.height * ratio));
  const width = Math.max(1, Math.round(bounds.width * ratio * limit));
  const height = Math.max(1, Math.round(bounds.height * ratio * limit));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  // Source changes replace the existing pixels in one frame, including any
  // transparent pixels. Never composite a new page over the previous one.
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
}

export function createPreviewRasterPainter(canvas: HTMLCanvasElement, source: HTMLImageElement) {
  const host = canvas.ownerDocument.defaultView ?? window;
  let frame: number | null = null, disposed = false;
  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = host.requestAnimationFrame(() => {
      frame = null;
      if (!disposed) paintPreviewRaster(canvas, source, host.devicePixelRatio);
    });
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  observer?.observe(canvas);
  host.addEventListener('resize', schedule);
  schedule();
  return () => {
    disposed = true;
    if (frame !== null) host.cancelAnimationFrame(frame);
    observer?.disconnect();
    host.removeEventListener('resize', schedule);
  };
}
