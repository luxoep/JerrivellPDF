// SPDX-License-Identifier: MIT OR Apache-2.0
import type { DocumentInfo, ImageAsset, WorkspacePage } from './types';

export interface EditableProjectResult {
  title: string;
  workspace: WorkspacePage[];
  documents: DocumentInfo[];
  assets: ImageAsset[];
}

const fail = (): never => { throw new Error('PROJECT_INVALID: 可编辑项目格式无效或超出资源限制。'); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const array = (value: unknown, maximum: number): unknown[] => Array.isArray(value) && value.length <= maximum ? value : fail();
const text = (value: unknown, maximum = 128, empty = false): string => typeof value === 'string' && value.length <= maximum && (empty || value.length > 0) && !value.includes('\0') ? value : fail();
const number = (value: unknown, low: number, high: number): number => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high ? value : fail();
const boolean = (value: unknown) => value === undefined || typeof value === 'boolean' ? value : fail();
const color = (value: unknown) => typeof value === 'string' && /^#[\da-f]{6}$/iu.test(value) ? value : fail();
const oneOf = (value: unknown, options: readonly unknown[]) => options.includes(value) ? value : fail();
const rotation = (value: unknown) => oneOf(value, [0, 90, 180, 270]);
const optional = (value: unknown, check: (value: unknown) => unknown) => value === undefined || value === null ? undefined : check(value);
function bounds(value: unknown) {
  const box = object(value);
  const x = number(box.x, 0, 1), y = number(box.y, 0, 1);
  const width = number(box.width, .000001, 1), height = number(box.height, .000001, 1);
  if (x + width > 1.000001 || y + height > 1.000001) fail();
}
function textSource(value: unknown) {
  const source = object(value);
  text(source.content, 4000); text(source.fontFamily, 256); color(source.color);
  number(source.fontSize, 6, 144); boolean(source.bold);
  for (const key of ['italic', 'underline', 'strikeout']) boolean(source[key]);
  optional(source.alignment, value => oneOf(value, ['left', 'center', 'right']));
  optional(source.charSpacing, value => number(value, -2, 20));
  optional(source.lineHeight, value => number(value, .8, 3));
  optional(source.wrapWidth, value => number(value, 24, 1800));
  if (source.frame !== undefined) {
    const frame = object(source.frame);
    number(frame.width, 24, 2048); number(frame.height, 12, 4096); if (typeof frame.autoHeight !== 'boolean') fail();
  }
}
function markSource(value: unknown) {
  const source = object(value), geometry = object(source.geometry);
  color(source.color);
  oneOf(geometry.tool, ['highlight', 'block', 'rectangle', 'ellipse', 'line', 'arrow', 'pen', 'polyline', 'polyarrow', 'callout']);
  bounds(geometry.bounds);
  number(geometry.pageWidth, 1, 200000); number(geometry.pageHeight, 1, 200000);
  number(geometry.lineWidth, .5, 12);
  optional(geometry.lineStyle, value => oneOf(value, ['solid', 'dashed', 'dashDot', 'dashDotDot']));
  optional(geometry.arrowHeads, value => oneOf(value, ['none', 'start', 'end', 'both']));
  const points = array(geometry.points, 2000);
  if (points.length < 2) fail();
  for (const point of points) { const p = object(point); number(p.x, 0, 1); number(p.y, 0, 1); }
}

/** Retains source semantics; this must never call pageReference(), which strips them. */
export function validateEditableWorkspace(input: unknown): WorkspacePage[] {
  const pages = array(input, 5000);
  if (!pages.length || JSON.stringify(input).length > 1_400_000) fail();
  const ids = new Set<string>();
  for (const raw of pages) {
    const page = object(raw), id = text(page.id);
    if (ids.has(id)) fail(); ids.add(id);
    text(page.documentId); number(page.pageIndex, 0, 4999); if (!Number.isInteger(page.pageIndex)) fail();
    rotation(page.rotation); number(page.width, .000001, 200000); number(page.height, .000001, 200000); text(page.sourceName, 260, true);
    const overlays = array(page.overlays ?? [], 64), objects = new Map<string, Record<string, unknown>>();
    for (const rawOverlay of overlays) {
      const item = object(rawOverlay), overlayId = text(item.id);
      if (objects.has(overlayId)) fail(); objects.set(overlayId, item);
      text(item.assetId); bounds(item); number(item.opacity, 0, 1);
      optional(item.rotation, rotation); optional(item.blendMode, value => oneOf(value, ['normal', 'multiply'])); boolean(item.locked);
      if (item.textSource !== undefined) textSource(item.textSource);
      if (item.markSource !== undefined) markSource(item.markSource);
      if (item.textSource !== undefined && item.markSource !== undefined) fail();
      optional(item.leaderFor, text);
    }
    for (const item of objects.values()) {
      if (item.leaderFor !== undefined && (!item.markSource || !objects.get(String(item.leaderFor))?.textSource || item.leaderFor === item.id)) fail();
    }
    for (const rawEdit of array(page.contentEdits ?? [], 128)) {
      const edit = object(rawEdit); number(edit.objectIndex, 0, 2047); if (!Number.isInteger(edit.objectIndex)) fail(); text(edit.fingerprint, 128);
      optional(edit.text, value => text(value, 2000, true)); optional(edit.fontFamily, value => text(value, 256));
      optional(edit.fontSize, value => number(value, .1, 512)); optional(edit.fillColor, color); optional(edit.opacity, value => number(value, 0, 1));
      optional(edit.replacementAssetId, text); optional(edit.bounds, bounds); boolean(edit.deleted); boolean(edit.bold); boolean(edit.italic);
    }
    for (const rawDecoration of array(page.decorations ?? [], 32)) {
      const item = object(rawDecoration); text(item.id); oneOf(item.kind, ['number', 'watermark']); text(item.text, 200, true);
      optional(item.fontFamily, value => text(value, 256)); number(item.fontSize, 1, 512); color(item.color); number(item.opacity, 0, 1);
      number(item.angle, -180, 180); number(item.x, 0, 1); number(item.y, 0, 1); oneOf(item.alignment, ['left', 'center', 'right']);
    }
  }
  return JSON.parse(JSON.stringify(input)) as WorkspacePage[];
}

export function editableAssetIds(pages: WorkspacePage[]): string[] {
  const ids = new Set<string>();
  for (const page of pages) {
    for (const item of page.overlays ?? []) ids.add(item.assetId);
    for (const edit of page.contentEdits ?? []) if (edit.replacementAssetId) ids.add(edit.replacementAssetId);
  }
  return [...ids];
}

/** Defense in depth for the already validated, atomically restored worker response. */
export function validateLoadedProject(input: unknown): EditableProjectResult {
  const result = object(input), title = text(result.title, 260), workspace = validateEditableWorkspace(result.workspace);
  const documents = array(result.documents, 32) as DocumentInfo[], assets = array(result.assets, 64) as ImageAsset[];
  const sources = new Map<string, DocumentInfo>(), images = new Set<string>();
  for (const raw of documents) {
    const document = object(raw), id = text(document.id);
    if (sources.has(id)) fail(); sources.set(id, raw);
    text(document.path, 512); text(document.fileName, 260); number(document.fileSize, 1, 64 * 1024 * 1024);
    const count = number(document.pageCount, 1, 5000), pages = array(document.pages, 5000);
    if (!Number.isInteger(count) || count !== pages.length) fail();
    pages.forEach((rawPage, index) => { const page = object(rawPage); if (page.index !== index) fail(); number(page.width, .000001, 200000); number(page.height, .000001, 200000); rotation(page.rotation); });
    for (const warning of array(document.warnings, 32)) text(warning, 2048, true);
  }
  for (const raw of assets) {
    const asset = object(raw), id = text(asset.id);
    if (images.has(id)) fail(); images.add(id);
    const data = text(asset.dataUrl, 24 * 1024 * 1024);
    if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(data)) fail();
    number(asset.width, 1, 8192); number(asset.height, 1, 8192);
    if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height) || Number(asset.width) * Number(asset.height) > 16 * 1024 * 1024) fail();
  }
  for (const page of workspace) { const document = sources.get(page.documentId); if (!document || page.pageIndex >= document.pageCount) fail(); }
  for (const id of editableAssetIds(workspace)) if (!images.has(id)) fail();
  return { title, workspace, documents, assets };
}
