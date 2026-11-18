import type { WorkspacePage } from './types';

/** A quarter turn of the visible page also rotates each placed image and its rectangle. */
export function rotatePageClockwise(page: WorkspacePage): WorkspacePage {
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
        const width = overlay.height; const height = overlay.width;
        return { ...overlay, x: Math.max(0, Math.min(1 - width, 1 - overlay.y - overlay.height)), y: Math.max(0, Math.min(1 - height, overlay.x)), width, height, rotation: ((overlay.rotation ?? 0) + 90) % 360 };
      }),
    } : {}),
  };
}
