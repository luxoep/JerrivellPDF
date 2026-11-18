// SPDX-License-Identifier: MIT OR Apache-2.0
import { createMarkGeometry, createMarkPng, transformMarkSource } from './markGeometry';
import { renderTextFrame, resizeTextFrame } from './textFrame';
import type { PageOverlay } from './types';

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Box = Pick<PageOverlay, 'x' | 'y' | 'width' | 'height'>;
const geometryChanged = (a: Box, b: Box) => a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;
export interface OverlayChangeOptions { moveLinked?: boolean }
export type OverlayPreview = PageOverlay & { previewMoveLinked?: boolean };

/** The target stays fixed; the horizontal landing follows the text frame. */
export function attachLeader(item: PageOverlay, text: PageOverlay): PageOverlay {
  const source = item.markSource;
  if (!source || !text.textSource) return item;
  const points = source.geometry.points.map(point => ({ ...point }));
  if (points.length < 2) return item;
  const centerY = text.y + text.height / 2;
  const elbow = points[points.length - 2];
  const leftSide = elbow.x <= text.x + text.width / 2;
  // A 2-point path receives an elbow so moving the label never moves its target.
  if (points.length === 2) points.splice(1, 0, { x: elbow.x + (leftSide ? 1 : -1) * .04, y: centerY });
  else points[points.length - 2] = { ...elbow, y: centerY };
  points[points.length - 1] = { x: leftSide ? text.x : text.x + text.width, y: centerY };
  const geometry = createMarkGeometry(points, { ...source.geometry, tool: 'callout', color: source.color, opacity: item.opacity }, source.geometry.pageWidth, source.geometry.pageHeight);
  return geometry ? { ...item, ...geometry.bounds, markSource: { ...source, geometry } } : item;
}

/** Resolve semantic changes before creating any native image assets. */
export function prepareEditableOverlays(previous: PageOverlay[], requested: PageOverlay[], pageWidth: number, pageHeight: number,
  options: OverlayChangeOptions = {}, nextId: () => string = () => crypto.randomUUID()) {
  const old = new Map(previous.map(item => [item.id, item]));
  const requestedIds = new Set(requested.map(item => item.id));
  // Removing a text frame also removes its leader; removing a leader keeps text.
  let next = requested.filter(item => !item.leaderFor || requestedIds.has(item.leaderFor)).map(item => {
    const before = old.get(item.id);
    let result = item;
    if (before?.textSource && item.textSource && (before.width !== item.width || before.height !== item.height) && equal(before.textSource, item.textSource)) {
      // Use the old physical dimensions to detect an explicit height edit.
      result = resizeTextFrame(before, item, pageWidth, pageHeight);
    }
    if (before?.markSource && result.markSource && (before.rotation ?? 0) !== (result.rotation ?? 0)) {
      const angle = ((result.rotation ?? 0) - (before.rotation ?? 0)) * Math.PI / 180;
      const cx = (before.x + before.width / 2) * pageWidth, cy = (before.y + before.height / 2) * pageHeight;
      const nx = (result.x + result.width / 2) * pageWidth, ny = (result.y + result.height / 2) * pageHeight;
      const quarter = Math.abs(Math.round(angle / (Math.PI / 2))) % 2 === 1;
      const sx = result.width * pageWidth / (quarter ? before.height * pageHeight : before.width * pageWidth);
      const sy = result.height * pageHeight / (quarter ? before.width * pageWidth : before.height * pageHeight);
      const points = before.markSource.geometry.points.map(point => {
        const x = point.x * pageWidth - cx, y = point.y * pageHeight - cy;
        return { x: (nx + (x * Math.cos(angle) - y * Math.sin(angle)) * sx) / pageWidth,
          y: (ny + (x * Math.sin(angle) + y * Math.cos(angle)) * sy) / pageHeight };
      });
      const geometry = createMarkGeometry(points, { ...result.markSource.geometry, color: result.markSource.color, opacity: result.opacity }, pageWidth, pageHeight);
      if (geometry) result = { ...result, ...geometry.bounds, rotation: 0, markSource: { ...result.markSource, geometry } };
    } else if (result.markSource && (!before || equal(before.markSource, result.markSource)) && geometryChanged(result.markSource.geometry.bounds, result)) {
      result = { ...result, markSource: transformMarkSource(result.markSource, result.markSource.geometry.bounds, result) };
    }
    return result;
  });
  // Duplicating a text object duplicates its connected leaders in the same undo.
  const copies: PageOverlay[] = [];
  for (const item of next) {
    if (old.has(item.id) || !item.textSource || next.some(line => line.leaderFor === item.id)) continue;
    const source = previous.find(value => value.textSource && value.assetId === item.assetId && equal(value.textSource, item.textSource));
    if (!source) continue;
    for (const leader of previous.filter(value => value.leaderFor === source.id && value.markSource)) {
      const dx = item.x - source.x, dy = item.y - source.y;
      const bounds = { ...leader, x: leader.x + dx, y: leader.y + dy };
      copies.push({ ...leader, ...bounds, id: nextId(), leaderFor: item.id, locked: false,
        markSource: transformMarkSource(leader.markSource!, leader, bounds) });
    }
  }
  next = [...next, ...copies];
  if (next.length > 30) throw new Error('OVERLAY_LIMIT');
  const images: { id: string; dataUrl: string }[] = [];
  // Text must be measured first because auto-height changes its attachment edge.
  next = next.map(item => {
    if (!item.textSource) return item;
    const before = old.get(item.id);
    if (before && equal(before.textSource, item.textSource) && before.width === item.width && before.height === item.height) return item;
    const result = renderTextFrame(item, pageWidth, pageHeight);
    if (result.overflow) throw new Error(result.pageOverflow ? 'TEXT_PAGE_OVERFLOW' : 'TEXT_FRAME_OVERFLOW');
    images.push({ id: item.id, dataUrl: result.dataUrl });
    return result.overlay;
  });
  const byId = new Map(next.map(item => [item.id, item]));
  next = next.map(item => {
    let result = item;
    if (item.leaderFor && item.markSource) {
      const text = byId.get(item.leaderFor)!;
      if (!text.textSource) return { ...item, leaderFor: undefined };
      const oldText = old.get(item.leaderFor);
      if (options.moveLinked && oldText && (text.x !== oldText.x || text.y !== oldText.y)) {
        const dx = text.x - oldText.x, dy = text.y - oldText.y;
        const translated = { ...item, x: item.x + dx, y: item.y + dy };
        result = { ...item, markSource: transformMarkSource(item.markSource, item, translated) };
      }
      result = attachLeader(result, text);
    }
    const before = old.get(result.id);
    if (result.markSource && (!before || !equal(before.markSource, result.markSource))) {
      images.push({ id: result.id, dataUrl: createMarkPng(result.markSource.geometry, result.markSource.color) });
      result = { ...result, ...result.markSource.geometry.bounds, rotation: 0 };
    }
    return result;
  });
  return { overlays: next, images };
}

/** Cheap, local preview. Native rendering and PNG registration are never invoked. */
export function previewEditableOverlays(overlays: PageOverlay[], placement: OverlayPreview | null) {
  if (!placement) return overlays;
  return overlays.map(item => {
    if (item.id === placement.id) return item.markSource && placement.markSource && equal(item.markSource, placement.markSource) && geometryChanged(item, placement)
      ? { ...placement, markSource: transformMarkSource(item.markSource, item, placement) } : placement;
    if (item.leaderFor !== placement.id) return item;
    const text = overlays.find(value => value.id === placement.id);
    let line = item;
    if (placement.previewMoveLinked && text && item.markSource) line = { ...item, markSource: transformMarkSource(item.markSource, item, { ...item, x: item.x + placement.x - text.x, y: item.y + placement.y - text.y }) };
    return attachLeader(line, placement);
  });
}
