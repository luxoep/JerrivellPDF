// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useState } from 'react';
import { cachedPageLayers, cancelledRequest, errorMessage, isDesktop, rasterReference, renderPageLayers } from './backend';
import type { RenderedPageLayers, WorkspacePage } from './types';

// Weak references share decoded images between identical source pages/copies;
// the native cache remains the authority and is cleared with the session.
const decodedLayers = new WeakSet<RenderedPageLayers>();
const decodingLayers = new WeakMap<RenderedPageLayers, Promise<void>>();

async function decode(dataUrl: string) {
  const image = new Image(); image.src = dataUrl;
  await image.decode();
}
function decodeLayers(layers: RenderedPageLayers) {
  if (decodedLayers.has(layers)) return Promise.resolve();
  const pending = decodingLayers.get(layers); if (pending) return pending;
  const request = Promise.all([decode(layers.background.dataUrl), ...layers.foreground.map(layer => decode(layer.image.dataUrl))])
    .then(() => { decodedLayers.add(layers); })
    .finally(() => decodingLayers.delete(layers));
  decodingLayers.set(layers, request); return request;
}

/** Swap decoded rasters in place. Resolution updates retain a usable page;
 * source/native-content changes never make stale content editable. */
export function usePageLayers(page: WorkspacePage, width: number, enabled: boolean, thumbnail = false) {
  const key = JSON.stringify(rasterReference(page));
  const identity = JSON.stringify([page.documentId, page.pageIndex, page.rotation]);
  const candidate = enabled && isDesktop() ? cachedPageLayers(page,width) : undefined;
  const cached = candidate && decodedLayers.has(candidate) ? candidate : undefined;
  const [result, setResult] = useState<{ key: string; identity: string; layers: RenderedPageLayers } | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!enabled || !isDesktop()) { setPending(false); if (thumbnail) setResult(null); return; }
    if (cached) { setResult({ key, identity, layers: cached }); setPending(false); setError(''); return; }
    let disposed = false;
    const lease = { cancelled: false };
    setPending(true); setError('');
    const timer = window.setTimeout(() => {
      void renderPageLayers(page, width, thumbnail, lease).then(async layers => {
        if (disposed) return;
        await decodeLayers(layers);
        if (!disposed) setResult({ key, identity, layers });
      }).catch(reason => { if (!disposed && errorMessage(reason) !== cancelledRequest) setError(errorMessage(reason)); })
        .finally(() => { if (!disposed) setPending(false); });
    }, thumbnail ? 0 : 90);
    return () => { disposed = true; lease.cancelled = true; window.clearTimeout(timer); };
  }, [key, width, enabled, thumbnail]);
  const layers = cached ?? (result?.identity === identity ? result.layers : null);
  const fresh = Boolean(cached) || result?.key === key;
  return { layers, error, loading: !layers || !fresh, refreshing: pending && Boolean(layers) };
}
