// SPDX-License-Identifier: GPL-3.0-or-later
export type MarkTool = 'select' | 'highlight' | 'block' | 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'pen';
export type LineStyle = 'solid' | 'dashed' | 'dashDot' | 'dashDotDot';
export interface MarkPoint { x: number; y: number }
export interface MarkSettings { tool: MarkTool; color: string; opacity: number; lineWidth: number; lineStyle?: LineStyle }
export interface MarkGeometry {
  tool: Exclude<MarkTool, 'select'>;
  bounds: { x: number; y: number; width: number; height: number };
  points: MarkPoint[];
  pageWidth: number;
  pageHeight: number;
  lineWidth: number;
  lineStyle?: LineStyle;
}
export function lineDash(style: LineStyle = 'solid', width = 1): number[] {
  return (style === 'dashed' ? [7, 4] : style === 'dashDot' ? [9, 3, 1, 3] : style === 'dashDotDot' ? [9, 3, 1, 3, 1, 3] : []).map(value => value * Math.max(1, width));
}
export const DEFAULT_MARK: MarkSettings = { tool: 'highlight', color: '#f6ce45', opacity: 0.35, lineWidth: 2 };
export const markPoint = (x: number, y: number): MarkPoint => ({ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });

export function constrainedMarkPoint(start: MarkPoint, end: MarkPoint, tool: MarkTool, square: boolean, pageWidth: number, pageHeight: number): MarkPoint {
  if (!square) return end;
  if (tool === 'pen' || tool === 'select') return end;
  const dx = (end.x - start.x) * pageWidth, dy = (end.y - start.y) * pageHeight;
  if (tool === 'arrow' || tool === 'line') {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
    return markPoint(start.x + Math.cos(angle) * Math.hypot(dx, dy) / pageWidth, start.y + Math.sin(angle) * Math.hypot(dx, dy) / pageHeight);
  }
  const size = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), (dx < 0 ? start.x : 1 - start.x) * pageWidth, (dy < 0 ? start.y : 1 - start.y) * pageHeight);
  return markPoint(start.x + (dx < 0 ? -size : size) / pageWidth, start.y + (dy < 0 ? -size : size) / pageHeight);
}

export function createMarkGeometry(points: MarkPoint[], settings: MarkSettings, pageWidth: number, pageHeight: number): MarkGeometry | null {
  if (settings.tool === 'select' || points.length < 2 || !(pageWidth > 0 && pageHeight > 0)) return null;
  if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  const safe = points.slice(0, 2000).map(point => markPoint(point.x, point.y));
  const used = settings.tool === 'pen' ? safe : [safe[0], safe[safe.length - 1]];
  const xs = used.map(point => point.x), ys = used.map(point => point.y);
  let left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
  const lineWidth = Math.max(0.5, Math.min(12, settings.lineWidth));
  const filled = settings.tool === 'highlight' || settings.tool === 'block';
  if (filled && ((right - left) * pageWidth < 1 || (bottom - top) * pageHeight < 1)) return null;
  if (!filled && Math.hypot((right - left) * pageWidth, (bottom - top) * pageHeight) < 2) return null;
  if (!filled) {
    const pad = settings.tool === 'arrow' ? Math.max(7, lineWidth * 4) : lineWidth + 1;
    left = Math.max(0, left - pad / pageWidth); right = Math.min(1, right + pad / pageWidth);
    top = Math.max(0, top - pad / pageHeight); bottom = Math.min(1, bottom + pad / pageHeight);
  }
  return { tool: settings.tool, points: used, bounds: { x: left, y: top, width: right - left, height: bottom - top }, pageWidth, pageHeight, lineWidth, lineStyle: settings.lineStyle ?? 'solid' };
}

/** Original canvas geometry; only its transparent PNG asset is passed to the PDF worker. */
export function createMarkPng(mark: MarkGeometry, color: string): string {
  const { bounds, pageWidth, pageHeight } = mark;
  const physicalWidth = bounds.width * pageWidth, physicalHeight = bounds.height * pageHeight;
  const scale = Math.min(2.5, 1800 / Math.max(physicalWidth, physicalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(physicalWidth * scale)); canvas.height = Math.max(1, Math.ceil(physicalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('CANVAS_UNAVAILABLE');
  context.scale(canvas.width / physicalWidth, canvas.height / physicalHeight);
  context.fillStyle = color; context.strokeStyle = color; context.lineWidth = mark.lineWidth; context.lineCap = 'round'; context.lineJoin = 'round';
  context.setLineDash?.(lineDash(mark.lineStyle, mark.lineWidth));
  const points = mark.points.map(point => ({ x: (point.x - bounds.x) * pageWidth, y: (point.y - bounds.y) * pageHeight }));
  const start = points[0], end = points[points.length - 1];
  const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y), width = Math.abs(end.x - start.x), height = Math.abs(end.y - start.y);
  if (mark.tool === 'highlight' || mark.tool === 'block') context.fillRect(0, 0, physicalWidth, physicalHeight);
  else if (mark.tool === 'rectangle') context.strokeRect(x, y, width, height);
  else if (mark.tool === 'ellipse') { context.beginPath(); context.ellipse(x + width / 2, y + height / 2, Math.max(.1, width / 2), Math.max(.1, height / 2), 0, 0, Math.PI * 2); context.stroke(); }
  else {
    context.beginPath(); context.moveTo(start.x, start.y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
    if (mark.tool === 'arrow') {
      const angle = Math.atan2(end.y - start.y, end.x - start.x), head = Math.max(7, mark.lineWidth * 4);
      context.beginPath(); context.moveTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6));
      context.lineTo(end.x, end.y); context.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6)); context.stroke();
    }
  }
  return canvas.toDataURL('image/png');
}
