// SPDX-License-Identifier: MIT OR Apache-2.0
import { parsePageRange } from './pageRanges';
import type { PageDecoration, WorkspacePage } from './types';
import type { ContentBounds, ContentObject } from './originalContent';
import { visiblePageSize } from './viewerGeometry';

export interface ExportPart { name: string; pages: WorkspacePage[] }
export interface ExportReport {
  token: string; outputs: { name: string; pageCount: number; bytes: number }[]; totalBytes: number; pageCount: number;
  risks: string[]; structures: { sourceCount: number; annotationsAndLinks: number; bookmarks: number; attachments: number; signatures: number; forms: boolean; protected: boolean };
}
export interface ExportResult { succeeded: number; failed: number; results: { path: string; success: boolean; bytes?: number; pageCount: number; error?: string }[] }
export interface TextLine { id: string; objects: ContentObject[]; text: string; bounds: ContentBounds; fontSize: number; mixedFont: boolean }
export type GenerateRequest = { kind: 'blank'; width: number; height: number; count: number } | { kind: 'images'; paths: string[]; paper: 'a4' | 'original'; margin: number } | { kind: 'crop'; pages: object[]; bounds: ContentBounds };

export function duplicatePage(page: WorkspacePage, id: string): WorkspacePage {
  return { ...page, id, overlays: page.overlays?.map(item => ({ ...item })), decorations: page.decorations?.map(item => ({ ...item })), contentEdits: page.contentEdits?.map(edit => ({ ...edit, ...(edit.bounds ? { bounds: { ...edit.bounds } } : {}) })) };
}
export function safePdfName(name: string): string {
  let base = name.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 100) || 'document';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return `${base}.pdf`;
}
export function splitPlan(pages: WorkspacePage[], mode: 'every' | 'each' | 'oddEven' | 'ranges', amount: string, ranges: string, prefix: string): ExportPart[] {
  if (!pages.length) throw new Error('EMPTY');
  let groups: WorkspacePage[][] = [];
  if (mode === 'ranges') groups = ranges.split(/[;；\n]+/).filter(value => value.trim()).map(value => parsePageRange(value, pages.length).map(index => pages[index]));
  else if (mode === 'oddEven') groups = [pages.filter((_, index) => index % 2 === 0), pages.filter((_, index) => index % 2 === 1)].filter(group => group.length);
  else {
    const n = mode === 'each' ? 1 : Number(amount);
    if (!Number.isInteger(n) || n < 1 || n > pages.length) throw new Error('COUNT');
    for (let index = 0; index < pages.length; index += n) groups.push(pages.slice(index, index + n));
  }
  if (!groups.length || groups.length > 200 || groups.reduce((n, group) => n + group.length, 0) > 5000) throw new Error('LIMIT');
  const base = safePdfName(prefix).replace(/\.pdf$/i, '');
  return groups.map((group, index) => ({ name: `${base}_${String(index + 1).padStart(3, '0')}.pdf`, pages: group }));
}

/** Horizontal baseline/gap clustering: tables and separated columns stay distinct. */
export function groupTextLines(objects: ContentObject[], pageWidth: number, pageHeight: number): TextLine[] {
  const candidates = objects.filter(item => item.kind === 'text' && item.editable && !item.deleted && item.text?.trim() && !/[\r\n\t]/.test(item.text) && Math.abs(item.textAngle ?? 0) < 1);
  candidates.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  const lines: ContentObject[][] = [];
  for (const item of candidates) {
    const box = item.bounds;
    const target = lines.find(line => {
      const last = line.at(-1)!; const other = last.bounds;
      const baseline = Math.abs((box.y + box.height - other.y - other.height) * pageHeight);
      const gap = (box.x - other.x - other.width) * pageWidth;
      const height = Math.max(box.height, other.height) * pageHeight;
      return baseline <= Math.max(1.5, height * .28) && gap >= -1 && gap <= height * 2.5;
    });
    if (target && target.length < 64) target.push(item); else lines.push([item]);
  }
  return lines.map(objects => {
    objects.sort((a, b) => a.bounds.x - b.bounds.x);
    const left = Math.min(...objects.map(item => item.bounds.x)), top = Math.min(...objects.map(item => item.bounds.y));
    const right = Math.max(...objects.map(item => item.bounds.x + item.bounds.width)), bottom = Math.max(...objects.map(item => item.bounds.y + item.bounds.height));
    let text = '';
    objects.forEach((item, index) => {
      if (index) { const previous = objects[index - 1]; const gap = (item.bounds.x - previous.bounds.x - previous.bounds.width) * pageWidth;
        if (gap > Math.max(1, Math.min(item.bounds.height, previous.bounds.height) * pageHeight * .2) && !/\s$/.test(text) && !/^\s/.test(item.text!)) text += ' '; }
      text += item.text;
    });
    return { id: objects.map(item => `${item.objectIndex}:${item.fingerprint}`).join('|'), objects, text, bounds: { x: left, y: top, width: right - left, height: bottom - top }, fontSize: objects[0].renderedFontSize ?? objects[0].fontSize ?? 12, mixedFont: new Set(objects.map(item => item.fontFamily)).size > 1 };
  }).sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
}

export function numberedPages(pages: WorkspacePage[], selected: ReadonlySet<string>, options: { kind: 'number' | 'watermark'; template: string; start: number; fontSize: number; fontFamily: string | null; color: string; opacity: number; angle: number; placement: string; margin: number }, id: () => string): WorkspacePage[] {
  if (!options.template.trim() || options.template.length > 200 || !Number.isInteger(options.start)) throw new Error('TEXT');
  let serial = options.start;
  return pages.map((page, index) => {
    if (!selected.has(page.id)) return page;
    const { width, height } = visiblePageSize(page);
    const text = options.template.replace(/\{page\}/g, String(index + 1)).replace(/\{total\}/g, String(pages.length)).replace(/\{n\}/g, String(serial++));
    const x = options.placement.endsWith('left') ? options.margin / width : options.placement.endsWith('right') ? 1 - options.margin / width : .5;
    const y = options.placement.startsWith('top') ? options.margin / height : options.placement.startsWith('bottom') ? 1 - options.margin / height : .5;
    const alignment: PageDecoration['alignment'] = options.placement.endsWith('left') ? 'left' : options.placement.endsWith('right') ? 'right' : 'center';
    const item: PageDecoration = { id: id(), kind: options.kind, text, fontFamily: options.fontFamily || null, fontSize: options.fontSize, color: options.color, opacity: options.opacity, angle: options.angle, x, y, alignment };
    return { ...page, decorations: [...(page.decorations ?? []).filter(item => item.kind !== options.kind), item] };
  });
}
