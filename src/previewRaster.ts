// SPDX-License-Identifier: MIT OR Apache-2.0
/** Paint one decoded page at its displayed device resolution. The PDF worker
 * remains untouched when the user zooms; only this local bitmap is resampled. */
function rasterDimensions(canvas: HTMLCanvasElement, pixelRatio: number) {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? Math.min(pixelRatio, 4) : 1;
  // Keep extreme zoom memory bounded. CSS still presents the entire page and
  // selection coordinates continue to use its unchanged displayed bounds.
  const limit = Math.min(1, 4096 / Math.max(bounds.width * ratio, bounds.height * ratio));
  const width = Math.max(1, Math.round(bounds.width * ratio * limit));
  const height = Math.max(1, Math.round(bounds.height * ratio * limit));
  return { width, height };
}

function paintRaster(canvas: HTMLCanvasElement, source: HTMLImageElement, width: number, height: number) {
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

export function paintPreviewRaster(canvas: HTMLCanvasElement, source: HTMLImageElement, pixelRatio: number) {
  const size = rasterDimensions(canvas, pixelRatio);
  if (size) paintRaster(canvas, source, size.width, size.height);
}

export function createPreviewRasterPainter(canvas: HTMLCanvasElement, source: HTMLImageElement) {
  const host = canvas.ownerDocument.defaultView ?? window;
  let frame: number | null = null, disposed = false;
  let lastWidth = -1, lastHeight = -1;
  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = host.requestAnimationFrame(() => {
      frame = null;
      if (!disposed) {
        const size = rasterDimensions(canvas, host.devicePixelRatio);
        if (!size || size.width === lastWidth && size.height === lastHeight && canvas.width === size.width && canvas.height === size.height) return;
        paintRaster(canvas, source, size.width, size.height);
        lastWidth = size.width; lastHeight = size.height;
      }
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
