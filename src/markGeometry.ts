// SPDX-License-Identifier: MIT OR Apache-2.0
export type MarkTool = 'select' | 'highlight' | 'block' | 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'polyline' | 'polyarrow' | 'callout' | 'pen';
export type LineStyle = 'solid' | 'dashed' | 'dashDot' | 'dashDotDot';
export type ArrowHeads = 'none' | 'start' | 'end' | 'both';
export interface MarkPoint { x: number; y: number }
export interface MarkSettings { tool: MarkTool; color: string; opacity: number; lineWidth: number; lineStyle?: LineStyle; arrowHeads?: ArrowHeads }
export type MarkStylePatch = Partial<Pick<MarkSettings, 'color' | 'opacity' | 'lineWidth' | 'lineStyle' | 'arrowHeads'>>;
export interface MarkBounds { x: number; y: number; width: number; height: number }
export interface MarkGeometry {
  tool: Exclude<MarkTool, 'select'>;
  bounds: { x: number; y: number; width: number; height: number };
  points: MarkPoint[];
  pageWidth: number;
  pageHeight: number;
  lineWidth: number;
  lineStyle?: LineStyle;
  arrowHeads?: ArrowHeads;
}
export interface MarkSource { geometry: MarkGeometry; color: string }
export const isMultiPointTool = (tool: MarkTool) => tool === 'polyline' || tool === 'polyarrow' || tool === 'callout';
export const isEditablePathTool = (tool: MarkTool) => tool === 'line' || tool === 'arrow' || isMultiPointTool(tool);
export const defaultArrowHeads = (tool: MarkTool): ArrowHeads => tool === 'callout' ? 'start' : tool === 'arrow' || tool === 'polyarrow' ? 'end' : 'none';
export const markArrowHeads = (mark: Pick<MarkGeometry, 'tool' | 'arrowHeads'>): ArrowHeads => mark.arrowHeads ?? defaultArrowHeads(mark.tool);

/** Geometry stays in visible-page coordinates when a whole overlay is moved/resized. */
export function transformMarkSource(source: MarkSource, oldBounds: MarkBounds, newBounds: MarkBounds): MarkSource {
  if (![oldBounds.x, oldBounds.y, oldBounds.width, oldBounds.height, newBounds.x, newBounds.y, newBounds.width, newBounds.height].every(Number.isFinite) || !(oldBounds.width > 0 && oldBounds.height > 0 && newBounds.width > 0 && newBounds.height > 0)) return source;
  const points = source.geometry.points.map(point => markPoint(
    newBounds.x + (point.x - oldBounds.x) * newBounds.width / oldBounds.width,
    newBounds.y + (point.y - oldBounds.y) * newBounds.height / oldBounds.height,
  ));
  // Stroke width and arrowheads stay in physical points when a path is resized.
  // Recompute padding instead of shrinking it with the old raster rectangle.
  const geometry = createMarkGeometry(points, { ...source.geometry, color: source.color, opacity: 1 }, source.geometry.pageWidth, source.geometry.pageHeight);
  return geometry ? { ...source, geometry } : source;
}

/** Physical-page arrow strokes. Use adjacent distinct nodes, including after node edits. */
export function markArrowPaths(mark: MarkGeometry): MarkPoint[][] {
  const heads = markArrowHeads(mark), points = mark.points.map(point => ({ x: point.x * mark.pageWidth, y: point.y * mark.pageHeight }));
  const result: MarkPoint[][] = [], head = Math.max(7, mark.lineWidth * 4);
  const append = (tip: MarkPoint, others: MarkPoint[]) => {
    const neighbor = others.find(point => Math.hypot(tip.x - point.x, tip.y - point.y) > .0001);
    if (!neighbor) return;
    const angle = Math.atan2(tip.y - neighbor.y, tip.x - neighbor.x);
    result.push([{ x: tip.x - head * Math.cos(angle - Math.PI / 6), y: tip.y - head * Math.sin(angle - Math.PI / 6) }, tip,
      { x: tip.x - head * Math.cos(angle + Math.PI / 6), y: tip.y - head * Math.sin(angle + Math.PI / 6) }]);
  };
  if (points.length > 1 && (heads === 'start' || heads === 'both')) append(points[0], points.slice(1));
  if (points.length > 1 && (heads === 'end' || heads === 'both')) append(points.at(-1)!, points.slice(0, -1).reverse());
  return result;
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
  if (isEditablePathTool(tool)) {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
    return markPoint(start.x + Math.cos(angle) * Math.hypot(dx, dy) / pageWidth, start.y + Math.sin(angle) * Math.hypot(dx, dy) / pageHeight);
  }
  const size = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), (dx < 0 ? start.x : 1 - start.x) * pageWidth, (dy < 0 ? start.y : 1 - start.y) * pageHeight);
  return markPoint(start.x + (dx < 0 ? -size : size) / pageWidth, start.y + (dy < 0 ? -size : size) / pageHeight);
}

export function createMarkGeometry(points: MarkPoint[], settings: MarkSettings, pageWidth: number, pageHeight: number): MarkGeometry | null {
  if (settings.tool === 'select' || points.length < 2 || !Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || !(pageWidth > 0 && pageHeight > 0)) return null;
  if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  const safe = points.slice(0, 2000).map(point => markPoint(point.x, point.y));
  const used = settings.tool === 'pen' || isMultiPointTool(settings.tool) ? safe : [safe[0], safe[safe.length - 1]];
  const xs = used.map(point => point.x), ys = used.map(point => point.y);
  let left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
  const lineWidth = Number.isFinite(settings.lineWidth) ? Math.max(0.5, Math.min(12, settings.lineWidth)) : 2;
  const filled = settings.tool === 'highlight' || settings.tool === 'block';
  if (filled && ((right - left) * pageWidth < 1 || (bottom - top) * pageHeight < 1)) return null;
  if (!filled && Math.hypot((right - left) * pageWidth, (bottom - top) * pageHeight) < 2) return null;
  if (!filled) {
    const pad = (settings.arrowHeads ?? defaultArrowHeads(settings.tool)) !== 'none' ? Math.max(7, lineWidth * 4) + lineWidth / 2 : lineWidth + 1;
    left = Math.max(0, left - pad / pageWidth); right = Math.min(1, right + pad / pageWidth);
    top = Math.max(0, top - pad / pageHeight); bottom = Math.min(1, bottom + pad / pageHeight);
  }
  return { tool: settings.tool, points: used, bounds: { x: left, y: top, width: right - left, height: bottom - top }, pageWidth, pageHeight, lineWidth, lineStyle: settings.lineStyle ?? 'solid', arrowHeads: settings.arrowHeads ?? defaultArrowHeads(settings.tool) };
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
    const arrows = markArrowPaths(mark);
    if (arrows.length) context.setLineDash?.([]);
    for (const path of arrows) {
      context.beginPath();
      path.forEach((point, index) => { const x = point.x - bounds.x * pageWidth, y = point.y - bounds.y * pageHeight; if (index) context.lineTo(x, y); else context.moveTo(x, y); });
      context.stroke();
    }
  }
  return canvas.toDataURL('image/png');
}
