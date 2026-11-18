// SPDX-License-Identifier: GPL-3.0-or-later
import { parsePageRange } from './pageRanges';
import type { WorkspacePage } from './types';

export type PrintScope = 'all' | 'current' | 'selected' | 'range';
export type PrintSubset = 'all' | 'odd' | 'even';
export interface PrintOptions {
  scale: 'fit' | 'actual';
  orientation: 'auto' | 'portrait' | 'landscape';
  copies: number;
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
