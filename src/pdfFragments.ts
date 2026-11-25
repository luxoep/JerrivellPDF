// SPDX-License-Identifier: MIT OR Apache-2.0
import type { ImageAsset, PageOverlay } from './types';
import type { ImageSelection } from './imageGeometry';
import { selectionRegions } from './imageGeometry';
import { normalizedOverlay } from './overlayGeometry';

/** Session tray; saving an item to the local library makes it persistent. */
export interface PdfFragmentItem {
  id: string;
  key: string;
  name: string;
  image: ImageAsset;
  blendMode: 'normal' | 'multiply';
  featureSource?: PageOverlay['featureSource'];
  featureImage?: ImageAsset;
}
export interface FragmentDrop { pageId: string; x: number; y: number }
export const MAX_FRAGMENT_ITEMS = 48;
export const MAX_FRAGMENT_BYTES = 24 * 1024 * 1024;
export const MAX_PAGE_CONTENT = 30;

export function fragmentSelections(crop: ImageSelection | null, combined: boolean): ImageSelection[] {
  if (!crop) return [{ x: 0, y: 0, width: 1, height: 1 }];
  return combined ? [crop] : selectionRegions(crop);
}

/** Preserve names and order for an already generated selection; append only new items. */
export function mergeFragments(current: PdfFragmentItem[], incoming: PdfFragmentItem[]): PdfFragmentItem[] {
  const next = [...current];
  for (const item of incoming) if (!next.some(previous => previous.key === item.key)) next.push(item);
  if (next.length > MAX_FRAGMENT_ITEMS) throw new Error('FRAGMENT_COUNT_LIMIT');
  // Count distinct PNGs once, matching their shared JS string / native image storage.
  const bytes = [...new Set(next.flatMap(item => item.featureImage ? [item.image.dataUrl, item.featureImage.dataUrl] : [item.image.dataUrl]))]
    .reduce((sum, png) => sum + png.length, 0);
  if (bytes > MAX_FRAGMENT_BYTES) throw new Error('FRAGMENT_MEMORY_LIMIT');
  return next;
}

export function moveFragment(items: PdfFragmentItem[], id: string, targetId: string, after = false): PdfFragmentItem[] {
  if (id === targetId) return items;
  const source = items.find(item => item.id === id);
  if (!source || !items.some(item => item.id === targetId)) return items;
  const rest = items.filter(item => item.id !== id);
  const at = rest.findIndex(item => item.id === targetId) + (after ? 1 : 0);
  return [...rest.slice(0, at), source, ...rest.slice(at)];
}

/** Build a whole insertion before committing: one undo step, no lost earlier objects. */
export function fragmentOverlays(items: PdfFragmentItem[], pageWidth: number, pageHeight: number,
  existing: PageOverlay[], point?: { x: number; y: number }): PageOverlay[] {
  if (!items.length || existing.length + items.length > MAX_PAGE_CONTENT) throw new Error('FRAGMENT_PAGE_LIMIT');
  const decoded = items.reduce((sum, item) => sum + item.image.width * item.image.height * 4, 0);
  if (decoded > 64 * 1024 * 1024) throw new Error('FRAGMENT_PIXEL_LIMIT');
  return items.map((item, index) => {
    let width = .3, height = width * pageWidth / pageHeight * item.image.height / item.image.width;
    if (height > .65) { width *= .65 / height; height = .65; }
    width = Math.max(.01, width); height = Math.max(.01, height);
    const x = point ? point.x - width / 2 : .08 + (index % 5) * .035;
    const y = point ? point.y - height / 2 : .08 + (index % 5) * .035;
    return normalizedOverlay({ id: crypto.randomUUID(), assetId: item.image.id,
      x, y, width, height, opacity: 1, rotation: 0, blendMode: item.blendMode,
      ...(item.featureSource ? { featureSource: item.featureSource } : {}) });
  });
}
