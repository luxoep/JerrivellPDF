// SPDX-License-Identifier: MIT OR Apache-2.0
/** Bounds use the final displayed PDF page, normalized from its top-left. */
export interface ContentBounds { x: number; y: number; width: number; height: number }
export interface ContentEdit {
  objectIndex: number;
  fingerprint: string;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fillColor?: string;
  bounds?: ContentBounds;
  deleted?: boolean;
  replacementAssetId?: string;
}
export interface ContentObject {
  objectIndex: number;
  fingerprint: string;
  kind: 'text' | 'image' | 'unsupported';
  bounds: ContentBounds;
  originalBounds: ContentBounds;
  text?: string | null;
  originalText?: string | null;
  fontFamily?: string | null;
  fontSize?: number | null;
  fillColor?: string | null;
  editable: boolean;
  reason?: string;
  deleted: boolean;
  textAngle?: number | null;
  renderedFontSize?: number | null;
}
export interface ContentInspection {
  objects: ContentObject[];
  totalObjects: number;
  truncated: boolean;
  warnings: string[];
}
export type ContentChange = (edits: ContentEdit[]) => Promise<boolean | void> | boolean | void;
export const POINTS_PER_MILLIMETER = 72 / 25.4;
export const MAX_CONTENT_EDITS = 128;
export const contentObjectId = (object: Pick<ContentObject, 'objectIndex'>) => String(object.objectIndex);
export const contentEditFor = (edits: ContentEdit[], object: Pick<ContentObject, 'objectIndex' | 'fingerprint'>) => edits.find(edit => edit.objectIndex === object.objectIndex && edit.fingerprint === object.fingerprint);

/** Replacement plans always retain source identity, never a native handle. */
export function upsertContentEdit(edits: ContentEdit[], object: Pick<ContentObject, 'objectIndex' | 'fingerprint'>, patch: Partial<Omit<ContentEdit, 'objectIndex' | 'fingerprint'>>): ContentEdit[] {
  const previous = contentEditFor(edits, object);
  const next: ContentEdit = { ...previous, objectIndex: object.objectIndex, fingerprint: object.fingerprint, ...patch };
  for (const key of Object.keys(next) as (keyof ContentEdit)[]) if (next[key] === undefined) delete next[key];
  if (next.bounds) next.bounds = { ...next.bounds };
  if (Object.keys(next).length === 2) return removeContentEdit(edits, object);
  return [...edits.filter(edit => edit.objectIndex !== object.objectIndex), next].sort((left, right) => left.objectIndex - right.objectIndex);
}

export function removeContentEdit(edits: ContentEdit[], object: Pick<ContentObject, 'objectIndex' | 'fingerprint'>): ContentEdit[] {
  return edits.filter(edit => edit.objectIndex !== object.objectIndex || edit.fingerprint !== object.fingerprint);
}

export function boundedContentBounds(bounds: ContentBounds): ContentBounds {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) throw new Error('CONTENT_INVALID_BOUNDS');
  const width = Math.max(.00001, Math.min(1, bounds.width));
  const height = Math.max(.00001, Math.min(1, bounds.height));
  return { x: Math.max(0, Math.min(1 - width, bounds.x)), y: Math.max(0, Math.min(1 - height, bounds.y)), width, height };
}

export function translatedContentBounds(bounds: ContentBounds, dx: number, dy: number): ContentBounds {
  return boundedContentBounds({ ...bounds, x: bounds.x + dx, y: bounds.y + dy });
}

export function contentStep(pagePoints: number, accelerated: boolean): number {
  return Number.isFinite(pagePoints) && pagePoints > 0 ? (accelerated ? 1 : .1) * POINTS_PER_MILLIMETER / pagePoints : 0;
}

/** A geometry draft is explicit; text-only changes do not acquire old bounds. */
export function geometryFromMillimeters(values: { x: string; y: string; width: string; height: string }, pageWidth: number, pageHeight: number): ContentBounds {
  if (!(pageWidth > 0 && pageHeight > 0)) throw new Error('CONTENT_INVALID_BOUNDS');
  const read = (value: string) => value.trim() === '' ? Number.NaN : Number(value);
  const bounds = { x: read(values.x) * POINTS_PER_MILLIMETER / pageWidth, y: read(values.y) * POINTS_PER_MILLIMETER / pageHeight,
    width: read(values.width) * POINTS_PER_MILLIMETER / pageWidth, height: read(values.height) * POINTS_PER_MILLIMETER / pageHeight };
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0
    || bounds.x + bounds.width > 1.000001 || bounds.y + bounds.height > 1.000001) throw new Error('CONTENT_INVALID_BOUNDS');
  return bounds;
}
