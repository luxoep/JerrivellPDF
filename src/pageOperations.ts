// SPDX-License-Identifier: MIT OR Apache-2.0
import type { WorkspacePage } from './types';

const clockwiseBounds = (item: { x: number; y: number; width: number; height: number }) => ({
  x: Math.max(0, Math.min(1 - item.height, 1 - item.y - item.height)),
  y: Math.max(0, Math.min(1 - item.width, item.x)), width: item.height, height: item.width,
});

/** A quarter turn of the visible page also rotates each placed image and its rectangle. */
export function rotatePageClockwise(page: WorkspacePage): WorkspacePage {
  const previouslyQuarterTurned = page.rotation % 180 === 90;
  const newPageWidth = previouslyQuarterTurned ? page.width : page.height;
  const newPageHeight = previouslyQuarterTurned ? page.height : page.width;
  return {
    ...page,
    rotation: (page.rotation + 90) % 360,
    ...(page.decorations?.length ? { decorations: page.decorations.map(item => ({ ...item, x: 1 - item.y, y: item.x, angle: ((item.angle + 90 + 180) % 360) - 180 })) } : {}),
    ...(page.contentEdits?.length ? {
      contentEdits: page.contentEdits.map(edit => edit.bounds ? {
        ...edit, bounds: { x: Math.max(0, 1 - edit.bounds.y - edit.bounds.height), y: edit.bounds.x,
          width: edit.bounds.height, height: edit.bounds.width },
      } : { ...edit }),
    } : {}),
    ...(page.overlays?.length ? {
      overlays: page.overlays.map(overlay => {
        const rotated = { ...overlay, ...clockwiseBounds(overlay), rotation: ((overlay.rotation ?? 0) + 90) % 360 };
        if (!overlay.markSource) return rotated;
        // The existing PNG rotates through `rotation`; its editable source stays
        // in the newly visible page space. A later source re-render must reset
        // the PNG's rotation to zero rather than applying this turn twice.
        const source = overlay.markSource;
        return { ...rotated, markSource: { ...source, geometry: {
          ...source.geometry, bounds: clockwiseBounds(source.geometry.bounds),
          pageWidth: newPageWidth, pageHeight: newPageHeight,
          points: source.geometry.points.map(point => ({ x: 1 - point.y, y: point.x })),
        } } };
      }),
    } : {}),
  };
}
