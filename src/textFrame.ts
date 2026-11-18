// SPDX-License-Identifier: MIT OR Apache-2.0
import type { PageOverlay } from './types';
import { normalizedOverlay } from './overlayGeometry';
import { createTextPng } from './components/overlayCanvas';
import type { TextOverlaySource } from './components/overlayCanvas';

export const TEXT_FRAME_MIN_PT = 24;
export type TextFrameRectangle = Pick<PageOverlay, 'x' | 'y' | 'width' | 'height'>;

function physicalSize(item: PageOverlay, pageWidth: number, pageHeight: number) {
  if (![pageWidth, pageHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('TEXT_LAYOUT_LIMIT');
  const quarterTurn = Math.abs(item.rotation ?? 0) % 180 === 90;
  return { quarterTurn, width: quarterTurn ? item.height * pageHeight : item.width * pageWidth,
    height: quarterTurn ? item.width * pageWidth : item.height * pageHeight };
}

/** Change a text container. Explicitly changing its logical height opts out of auto height. */
export function resizeTextFrame<T extends PageOverlay>(item: T, rectangle: TextFrameRectangle, pageWidth: number, pageHeight: number): T {
  if (!item.textSource) return normalizedOverlay({ ...item, ...rectangle });
  const next = normalizedOverlay({ ...item, ...rectangle });
  const previousSize = physicalSize(item, pageWidth, pageHeight), nextSize = physicalSize(next, pageWidth, pageHeight);
  const heightChanged = Math.abs(nextSize.height - previousSize.height) > .01;
  const autoHeight = !heightChanged && (item.textSource.frame?.autoHeight ?? true);
  const source: TextOverlaySource = { ...item.textSource, wrapWidth: undefined,
    frame: { width: Math.max(TEXT_FRAME_MIN_PT, nextSize.width), height: Math.max(12, nextSize.height), autoHeight } };
  return { ...next, textSource: source };
}

/** Render at the requested font size. Callers must reject overflow before committing an asset. */
function layoutTextFrame<T extends PageOverlay>(item: T, pageWidth: number, pageHeight: number, measureOnly: boolean) {
  if (!item.textSource) throw new Error('TEXT_SOURCE_REQUIRED');
  const size = physicalSize(item, pageWidth, pageHeight);
  const source: TextOverlaySource = { ...item.textSource, wrapWidth: undefined, frame: item.textSource.frame ?? {
    width: Math.max(TEXT_FRAME_MIN_PT, size.width), height: Math.max(12, size.height), autoHeight: true,
  } };
  const result = createTextPng(source.content, source.color, source.fontSize, source.bold, source.fontFamily, source, measureOnly);
  const physicalWidth = result.width / 2, physicalHeight = result.height / 2;
  const width = (size.quarterTurn ? physicalHeight : physicalWidth) / pageWidth;
  const height = (size.quarterTurn ? physicalWidth : physicalHeight) / pageHeight;
  const pageOverflow = item.x < 0 || item.y < 0 || item.x + width > 1 + 1e-7 || item.y + height > 1 + 1e-7;
  const overlay = { ...item, width, height, textSource: { ...source, frame: {
    width: physicalWidth, height: physicalHeight, autoHeight: source.frame!.autoHeight,
  } } };
  return { ...result, overflow: result.overflow || pageOverflow, pageOverflow, overlay };
}

export function renderTextFrame<T extends PageOverlay>(item: T, pageWidth: number, pageHeight: number) {
  return layoutTextFrame(item, pageWidth, pageHeight, false);
}

/** Measurement only: no full-size canvas, glyph painting or PNG encoding. */
export function measureTextFrame<T extends PageOverlay>(item: T, pageWidth: number, pageHeight: number) {
  const { dataUrl: _dataUrl, ...result } = layoutTextFrame(item, pageWidth, pageHeight, true);
  return result;
}
