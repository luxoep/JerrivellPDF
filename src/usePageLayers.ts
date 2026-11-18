// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { cancelledRequest, errorMessage, isDesktop, rasterReference, renderPageLayers } from './backend';
import type { RenderedPageLayers, WorkspacePage } from './types';

async function decode(dataUrl: string) {
  const image = new Image(); image.src = dataUrl;
  await image.decode();
}

/** Swap decoded rasters in place. Resolution updates retain a usable page;
 * source/native-content changes never make stale content editable. */
export function usePageLayers(page: WorkspacePage, width: number, enabled: boolean, thumbnail = false) {
  const key = JSON.stringify(rasterReference(page));
  const identity = JSON.stringify([page.documentId, page.pageIndex, page.rotation]);
  const [result, setResult] = useState<{ key: string; identity: string; layers: RenderedPageLayers } | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!enabled || !isDesktop()) { setPending(false); if (thumbnail) setResult(null); return; }
    let disposed = false;
    setPending(true); setError('');
    const timer = window.setTimeout(() => {
      void renderPageLayers(page, width, thumbnail).then(async layers => {
        if (disposed) return;
        await Promise.all([decode(layers.background.dataUrl), ...layers.foreground.map(layer => decode(layer.image.dataUrl))]);
        if (!disposed) setResult({ key, identity, layers });
      }).catch(reason => { if (!disposed && errorMessage(reason) !== cancelledRequest) setError(errorMessage(reason)); })
        .finally(() => { if (!disposed) setPending(false); });
    }, thumbnail ? 0 : 90);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [key, width, enabled, thumbnail]);
  const layers = result?.identity === identity ? result.layers : null;
  const fresh = result?.key === key;
  return { layers, error, loading: !layers || !fresh, refreshing: pending && Boolean(layers) };
}
