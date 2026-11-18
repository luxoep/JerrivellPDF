// SPDX-License-Identifier: GPL-3.0-or-later
import type { PageOverlay } from './types';

export const POINTS_PER_MM = 72 / 25.4;
export const MIN_OVERLAY_SIDE = 0.001;
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
export type PageAlignment = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom';

/** Coordinates refer to the visible page, after its intrinsic/additional rotation. */
export function normalizedOverlay<T extends PageOverlay>(item: T): T {
  const width = clamp(finite(item.width, 0.1), MIN_OVERLAY_SIDE, 1);
  const height = clamp(finite(item.height, 0.1), MIN_OVERLAY_SIDE, 1);
  return { ...item, width, height, x: clamp(finite(item.x, 0), 0, 1 - width), y: clamp(finite(item.y, 0), 0, 1 - height) };
}

export function resizeOverlay<T extends PageOverlay>(item: T, axis: 'width' | 'height', requested: number, preserveAspect: boolean): T {
  const source = normalizedOverlay(item);
  const side = axis === 'width' ? source.width : source.height;
  if (!preserveAspect) return normalizedOverlay({ ...source, [axis]: clamp(finite(requested, side), MIN_OVERLAY_SIDE, axis === 'width' ? 1 - source.x : 1 - source.y) });
  const maximum = Math.min((1 - source.x) / source.width, (1 - source.y) / source.height);
  const minimum = Math.min(maximum, Math.max(MIN_OVERLAY_SIDE / source.width, MIN_OVERLAY_SIDE / source.height));
  const scale = clamp(finite(requested, side) / side, minimum, maximum);
  return { ...source, width: source.width * scale, height: source.height * scale };
}

export function translatedOverlay<T extends PageOverlay>(item: T, dx: number, dy: number): T {
  return normalizedOverlay({ ...item, x: item.x + finite(dx, 0), y: item.y + finite(dy, 0) });
}

export function alignedOverlay<T extends PageOverlay>(item: T, alignment: PageAlignment): T {
  const source = normalizedOverlay(item);
  switch (alignment) {
    case 'left': return { ...source, x: 0 };
    case 'centerX': return { ...source, x: (1 - source.width) / 2 };
    case 'right': return { ...source, x: 1 - source.width };
    case 'top': return { ...source, y: 0 };
    case 'centerY': return { ...source, y: (1 - source.height) / 2 };
    case 'bottom': return { ...source, y: 1 - source.height };
  }
}

/** Swap physical dimensions, not normalized fractions, for a 90 degree turn. */
export function rotatedOverlay90<T extends PageOverlay>(item: T, pageWidth: number, pageHeight: number): T {
  const source = normalizedOverlay(item);
  if (!(pageWidth > 0 && pageHeight > 0 && Number.isFinite(pageWidth) && Number.isFinite(pageHeight))) return source;
  let width = source.height * pageHeight / pageWidth;
  let height = source.width * pageWidth / pageHeight;
  const scale = Math.min(1, 1 / width, 1 / height);
  width *= scale; height *= scale;
  return normalizedOverlay({ ...source, x: source.x + (source.width - width) / 2, y: source.y + (source.height - height) / 2,
    width, height, rotation: ((source.rotation ?? 0) + 90) % 360 });
}

export function duplicatedOverlay<T extends PageOverlay>(item: T, id: string, pageWidth: number, pageHeight: number): T {
  const dx = pageWidth > 0 ? 3 * POINTS_PER_MM / pageWidth : 0.015;
  const dy = pageHeight > 0 ? 3 * POINTS_PER_MM / pageHeight : 0.015;
  return translatedOverlay({ ...item, id, locked: false }, dx, dy);
}

export function overlayStep(pagePoints: number, accelerated: boolean): number {
  return pagePoints > 0 && Number.isFinite(pagePoints) ? (accelerated ? 1 : 0.1) * POINTS_PER_MM / pagePoints : accelerated ? 0.01 : 0.001;
}
