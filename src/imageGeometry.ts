// SPDX-License-Identifier: GPL-3.0-or-later
export interface ImagePoint { x: number; y: number }
export interface ImageSelection { x: number; y: number; width: number; height: number; points?: ImagePoint[] }
export type SelectionShape = 'rectangle' | 'ellipse' | 'polygon' | 'lasso';
export interface EraseStroke { points: ImagePoint[]; width: number }
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
