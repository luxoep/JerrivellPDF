// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import type { ImageAsset } from './types';
import type { ImageSelection } from './imageGeometry';
import { selectionOutline } from './imageGeometry';

/** Browser-only previews do not consume native assets or reopen PDFs per drag. */
export function useFragmentPreview(source: ImageAsset | null, crop: ImageSelection | null, removeWhite: boolean, trim: boolean) {
  const [result, setResult] = useState<{ owner: string; image: ImageAsset } | null>(null);
  const [error, setError] = useState('');
  const decoded = useRef<{ id: string; promise: Promise<HTMLImageElement> } | null>(null);
  const key = JSON.stringify([source?.id, crop, removeWhite, trim]);
  useEffect(() => {
    if (!source) return;
    let disposed = false; setError('');
    const timer = window.setTimeout(() => {
      void (async () => {
        if (decoded.current?.id !== source.id) {
          const image = new Image(); image.src = source.dataUrl;
          decoded.current = { id: source.id, promise: image.decode().then(() => image) };
        }
        const image = await decoded.current.promise; if (disposed) return;
        const region = crop ?? { x: 0, y: 0, width: 1, height: 1 };
        const left = Math.min(source.width - 1, Math.floor(region.x * source.width)), top = Math.min(source.height - 1, Math.floor(region.y * source.height));
        const right = Math.max(left + 1, Math.min(source.width, Math.ceil((region.x + region.width) * source.width))), bottom = Math.max(top + 1, Math.min(source.height, Math.ceil((region.y + region.height) * source.height)));
        const canvas = document.createElement('canvas'); canvas.width = right - left; canvas.height = bottom - top;
        const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) throw new Error('CANVAS_UNAVAILABLE');
        if (crop?.points) {
          const points = selectionOutline(crop); context.beginPath();
          points.forEach((point, n) => n ? context.lineTo(point.x * source.width - left, point.y * source.height - top) : context.moveTo(point.x * source.width - left, point.y * source.height - top));
          context.closePath(); context.clip('evenodd');
        }
        context.drawImage(image, -left, -top);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          const offset = (y * canvas.width + x) * 4;
          if (removeWhite && pixels.data[offset] >= 245 && pixels.data[offset + 1] >= 245 && pixels.data[offset + 2] >= 245) pixels.data.fill(0, offset, offset + 4);
          if (pixels.data[offset + 3]) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
        }
        context.putImageData(pixels, 0, 0);
        let output = canvas;
        if (trim) {
          output = document.createElement('canvas'); output.width = Math.max(1, maxX - minX + 1); output.height = Math.max(1, maxY - minY + 1);
          if (maxX >= minX) output.getContext('2d')!.drawImage(canvas, minX, minY, output.width, output.height, 0, 0, output.width, output.height);
        }
        if (!disposed) setResult({ owner: source.id, image: { id: `preview-${key}`, dataUrl: output.toDataURL('image/png'), width: output.width, height: output.height } });
      })().catch(reason => { if (!disposed) setError(String(reason)); });
    }, 80);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [key]);
  return { image: result?.owner === source?.id ? result?.image ?? null : null, error };
}
