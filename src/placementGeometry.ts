// SPDX-License-Identifier: MIT OR Apache-2.0
import type { PageOverlay } from './types';
export type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
/** The opposite edge stays fixed; text frame resizing never changes the font. */
export function resizedPlacement(item: PageOverlay, handle: ResizeHandle, dx: number, dy: number, pageWidth: number, pageHeight: number) {
  const minW = Math.min(item.width, 1 / pageWidth), minH = Math.min(item.height, 1 / pageHeight);
  let left = item.x, top = item.y, right = left + item.width, bottom = top + item.height;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - minW);
  if (handle.includes('e')) right = clamp(right + dx, left + minW, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - minH);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + minH, 1);
  return { ...item, x: left, y: top, width: right - left, height: bottom - top };
}
