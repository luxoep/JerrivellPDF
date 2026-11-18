// SPDX-License-Identifier: MIT OR Apache-2.0
export interface ImagePoint { x: number; y: number }
export interface ImageSelection { x: number; y: number; width: number; height: number; points?: ImagePoint[]; regions?: ImageSelection[] }
export type SelectionShape = 'rectangle' | 'ellipse' | 'polygon' | 'lasso';
export interface EraseStroke { points: ImagePoint[]; width: number; mode?: 'transparent' | 'repair' }
export const MAX_IMAGE_REGIONS = 16;
export const selectionRegions = (crop: ImageSelection | null): ImageSelection[] => crop ? crop.regions ?? [crop] : [];
/** A union keeps the source-relative positions, including transparent gaps. */
export function selectionUnion(input: ImageSelection[]): ImageSelection | null {
  const regions = input.flatMap(selectionRegions);
  if (!regions.length) return null;
  if (regions.length > MAX_IMAGE_REGIONS) throw new Error('SELECTION_LIMIT');
  if (regions.length === 1) return regions[0];
  const x = Math.min(...regions.map(region => region.x)), y = Math.min(...regions.map(region => region.y));
  return { x, y, width: Math.max(...regions.map(region => region.x + region.width)) - x, height: Math.max(...regions.map(region => region.y + region.height)) - y, regions };
}
export function transformSelection(crop: ImageSelection, box: Pick<ImageSelection, 'x' | 'y' | 'width' | 'height'>): ImageSelection {
  const transform = (region: ImageSelection): ImageSelection => ({
    x: box.x + (region.x - crop.x) * box.width / crop.width,
    y: box.y + (region.y - crop.y) * box.height / crop.height,
    width: region.width * box.width / crop.width, height: region.height * box.height / crop.height,
    ...(region.points ? { points: region.points.map(point => ({ x: box.x + (point.x - crop.x) * box.width / crop.width, y: box.y + (point.y - crop.y) * box.height / crop.height })) } : {}),
  });
  return crop.regions ? { ...box, regions: crop.regions.map(transform) } : transform(crop);
}
export const imagePoint = (x: number, y: number): ImagePoint => ({ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });
export function selectionOutline(crop: ImageSelection): ImagePoint[] {
  return crop.points ?? [{ x: crop.x, y: crop.y }, { x: crop.x + crop.width, y: crop.y }, { x: crop.x + crop.width, y: crop.y + crop.height }, { x: crop.x, y: crop.y + crop.height }];
}
export function selectionFromPoints(input: ImagePoint[], shape: SelectionShape): ImageSelection | null {
  if (input.some(point => !Number.isFinite(point.x + point.y))) return null;
  let points = input.map(point => imagePoint(point.x, point.y));
  if (shape === 'rectangle' || shape === 'ellipse') {
    if (points.length < 2) return null;
    points = [points[0], points[points.length - 1]];
  } else if (points.length < 3) return null;
  if (points.length > 256) points = Array.from({ length: 256 }, (_, i) => points[Math.round(i * (points.length - 1) / 255)]);
  const x = Math.min(...points.map(point => point.x)), y = Math.min(...points.map(point => point.y));
  const width = Math.max(...points.map(point => point.x)) - x, height = Math.max(...points.map(point => point.y)) - y;
  if (width < .002 || height < .002) return null;
  return { x, y, width, height, ...(shape === 'ellipse' ? { points: Array.from({ length: 96 }, (_, i) => ({ x: x + width / 2 * (1 + Math.cos(i * Math.PI / 48)), y: y + height / 2 * (1 + Math.sin(i * Math.PI / 48)) })) } : ['polygon', 'lasso'].includes(shape) ? { points } : {}) };
}
export const outlineString = (points: ImagePoint[], width = 1, height = 1) => points.map(point => `${point.x * width},${point.y * height}`).join(' ');
