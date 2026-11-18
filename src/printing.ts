// SPDX-License-Identifier: MIT OR Apache-2.0
import { parsePageRange } from './pageRanges';
import type { WorkspacePage } from './types';

export type PrintScope = 'all' | 'current' | 'selected' | 'range';
export type PrintSubset = 'all' | 'odd' | 'even';
export type PrintPaper = 'printer' | 'a3' | 'a4' | 'a5' | 'b5' | 'letter' | 'legal';
export type PrintColor = 'printer' | 'color' | 'grayscale';
export type PrintDpi = 150 | 300 | 600;
export const PRINT_DPI_OPTIONS: readonly PrintDpi[] = [150, 300, 600];
export const PRINT_PAPERS: { id: PrintPaper; name: string; width: number; height: number }[] = [
  { id: 'a3', name: 'A3', width: 297, height: 420 }, { id: 'a4', name: 'A4', width: 210, height: 297 },
  { id: 'a5', name: 'A5', width: 148, height: 210 }, { id: 'b5', name: 'B5 (JIS)', width: 182, height: 257 },
  { id: 'letter', name: 'Letter', width: 215.9, height: 279.4 }, { id: 'legal', name: 'Legal', width: 215.9, height: 355.6 },
];
export interface PrintOptions {
  scale: 'fit' | 'actual';
  orientation: 'auto' | 'portrait' | 'landscape';
  copies: number;
  paperSize?: PrintPaper;
  color?: PrintColor;
  /** PDF raster sampling density, independent of the printer driver's DPI. */
  dpi?: PrintDpi | null;
}
export interface PrintResult { status: 'printed' | 'cancelled'; pageCount: number; copies: number; warnings?: string[] }

/** All filters refer to workspace page numbers, before optional reversal. */
export function selectPrintIndices(pages: WorkspacePage[], current: number, selectedIds: ReadonlySet<string>, scope: PrintScope, range: string, subset: PrintSubset, reverse: boolean): number[] {
  let indices = scope === 'all' ? pages.map((_, i) => i)
    : scope === 'current' ? (pages[current] ? [current] : [])
    : scope === 'selected' ? pages.flatMap((page, i) => selectedIds.has(page.id) ? [i] : [])
    : parsePageRange(range, pages.length);
  if (subset !== 'all') indices = indices.filter(i => (i + 1) % 2 === (subset === 'odd' ? 1 : 0));
  return reverse ? indices.reverse() : indices;
}

export function validPrintCopies(value: string): number | null {
  if (!/^\d{1,2}$/.test(value)) return null;
  const copies = Number(value);
  return copies >= 1 && copies <= 99 ? copies : null;
}
