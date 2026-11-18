// SPDX-License-Identifier: MIT OR Apache-2.0
import type { WorkspacePage } from './types';

export type ViewerZoom = number | 'fit' | 'page';
export interface ViewportSize { width: number; height: number }
export interface PageLayout { id: string; index: number; left: number; top: number; width: number; height: number }
export interface DocumentLayout { pages: PageLayout[]; width: number; height: number }
export interface ViewAnchor { id: string; x: number; y: number; viewportX: number; viewportY: number }
export const VIEW_MARGIN = 24;
export const PAGE_GAP = 44;
export const clampZoom = (value: number) => Math.max(25, Math.min(400, Number.isFinite(value) ? value : 100));
export const rasterTargetWidth = (width: number, pixelRatio = 1) => Math.min(2400, Math.ceil(width * Math.min(pixelRatio || 1, 1.5) / 64) * 64);

export function visiblePageSize(page: Pick<WorkspacePage, 'width' | 'height' | 'rotation'>) {
  return page.rotation % 180 === 90 ? { width: page.height, height: page.width } : { width: page.width, height: page.height };
}

export function fittedPageWidth(page: Pick<WorkspacePage, 'width' | 'height' | 'rotation'>, viewport: ViewportSize, zoom: ViewerZoom): number {
  const dimensions = visiblePageSize(page);
  const available = Math.max(120, viewport.width - VIEW_MARGIN * 2);
  if (zoom === 'fit') return available;
  if (zoom === 'page') return Math.min(available, Math.max(120, viewport.height - VIEW_MARGIN * 2 - 20) * dimensions.width / dimensions.height);
  return dimensions.width * clampZoom(zoom) / 100;
}

/** Reserve exact page geometry even when its raster is outside the render window. */
export function buildDocumentLayout(pages: WorkspacePage[], viewport: ViewportSize, zoom: ViewerZoom): DocumentLayout {
  const widths = pages.map(page => fittedPageWidth(page, viewport, zoom));
  const width = Math.max(viewport.width, ...widths.map(value => value + VIEW_MARGIN * 2));
  let top = VIEW_MARGIN;
  const rows = pages.map((page, index) => {
    const dimensions = visiblePageSize(page);
    const row = { id: page.id, index, left: (width - widths[index]) / 2, top, width: widths[index], height: widths[index] * dimensions.height / dimensions.width };
    top += row.height + PAGE_GAP;
    return row;
  });
  return { pages: rows, width, height: Math.max(viewport.height, top - PAGE_GAP + VIEW_MARGIN + 20) };
}

export function pageAtPosition(rows: PageLayout[], y: number): PageLayout | undefined {
  let low = 0, high = rows.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (y > rows[mid].top + rows[mid].height + PAGE_GAP / 2) low = mid + 1;
    else high = mid;
  }
  return rows[low];
}

/** O(log n + visible) window lookup; pages are ordered and never overlap. */
export function visibleRows<T extends { top: number; height: number }>(rows: T[], top: number, bottom: number): T[] {
  let low = 0, high = rows.length;
  while (low < high) { const mid = (low + high) >>> 1; if (rows[mid].top + rows[mid].height < top) low = mid + 1; else high = mid; }
  const start = low;
  while (low < rows.length && rows[low].top <= bottom) low++;
  return rows.slice(start, low);
}

/** Fixed card geometry reserves offscreen space without thousands of DOM nodes. */
export function buildThumbnailLayout(pages: WorkspacePage[]) {
  let top = 0;
  const rows = pages.map((page, index) => {
    const size = visiblePageSize(page), height = size.width > size.height ? 146 : 202;
    const row = { id: page.id, index, top, height };
    top += height + 10; return row;
  });
  return { rows, height: top };
}

export function captureViewAnchor(layout: DocumentLayout, scroll: { left: number; top: number }, point: { x: number; y: number }): ViewAnchor | null {
  const page = pageAtPosition(layout.pages, scroll.top + point.y);
  if (!page) return null;
  return { id: page.id, x: (scroll.left + point.x - page.left) / page.width, y: (scroll.top + point.y - page.top) / page.height, viewportX: point.x, viewportY: point.y };
}

export function restoreViewAnchor(layout: DocumentLayout, anchor: ViewAnchor): { left: number; top: number } | null {
  const page = layout.pages.find(row => row.id === anchor.id);
  return page ? { left: Math.max(0, page.left + anchor.x * page.width - anchor.viewportX), top: Math.max(0, page.top + anchor.y * page.height - anchor.viewportY) } : null;
}

export function wheelZoom(current: number, deltaY: number, deltaMode = 0): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 500 : 1);
  return Math.round(clampZoom(current * Math.exp(-Math.max(-240, Math.min(240, pixels)) * 0.0015)));
}

/** Move selected pages as a stable block, inserting explicitly before/after a target. */
export function reorderPages(pages: WorkspacePage[], sourceId: string, targetId: string, side: 'before' | 'after', selected: ReadonlySet<string>): WorkspacePage[] {
  if (sourceId === targetId || !pages.some(page => page.id === sourceId) || !pages.some(page => page.id === targetId)) return pages;
  const movedIds = selected.has(sourceId) ? selected : new Set([sourceId]);
  if (movedIds.has(targetId)) return pages;
  const moved = pages.filter(page => movedIds.has(page.id));
  const rest = pages.filter(page => !movedIds.has(page.id));
  const at = rest.findIndex(page => page.id === targetId) + (side === 'after' ? 1 : 0);
  const next = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
  return next.every((page, index) => page.id === pages[index].id) ? pages : next;
}
