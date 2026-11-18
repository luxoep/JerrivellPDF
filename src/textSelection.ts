// SPDX-License-Identifier: MIT OR Apache-2.0
import type { ContentBounds } from './originalContent';
export interface TextGlyph { start: number; end: number; bounds: ContentBounds }
export interface PageText { status: 'ready' | 'restricted' | 'empty' | 'limited'; reason?: string; text: string; glyphs: TextGlyph[] }
export function nearestGlyph(glyphs: TextGlyph[], x: number, y: number, aspect = 1): number {
  let best = -1, distance = Infinity;
  glyphs.forEach((glyph, index) => {
    const b = glyph.bounds, dx = Math.max(b.x - x, 0, x - b.x - b.width) * aspect;
    const dy = Math.max(b.y - y, 0, y - b.y - b.height);
    const score = dx * dx + dy * dy * 4;
    if (score < distance) { distance = score; best = index; }
  });
  return best;
}
export function selectedText(page: PageText, anchor: number, focus: number): string {
  const a = page.glyphs[Math.min(anchor, focus)], b = page.glyphs[Math.max(anchor, focus)];
  return a && b ? page.text.slice(a.start, b.end).replace(/\r\n?/g, '\n') : '';
}
export function wordGlyphRange(page: PageText, index: number): [number, number] {
  const word = (i: number) => /[\p{L}\p{N}_]/u.test(page.text.slice(page.glyphs[i]?.start, page.glyphs[i]?.end));
  let a = index, b = index;
  if (!word(index)) return [a,b];
  while (a > 0 && page.glyphs[a - 1].end === page.glyphs[a].start && word(a - 1)) a--;
  while (b + 1 < page.glyphs.length && page.glyphs[b].end === page.glyphs[b + 1].start && word(b + 1)) b++;
  return [a,b];
}
