// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useState } from 'react';
import { cancelledRequest, errorMessage, isDesktop, pageReference, renderPage } from './backend';
import type { RenderedPage, WorkspacePage } from './types';

export function usePageImage(page: WorkspacePage | undefined, width: number, enabled: boolean, thumbnail = false) {
  const contentKey = page ? JSON.stringify(pageReference(page)) : '';
  const [result, setResult] = useState<{ key: string; image: RenderedPage } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!page || !enabled || !isDesktop()) { setLoading(false); if (thumbnail) setResult(null); return; }
    let disposed = false;
    const lease = { cancelled: false };
    setLoading(true); setError('');
    const timer = window.setTimeout(() => {
      void renderPage(page, width, thumbnail, lease)
        .then(image => { if (!disposed) setResult({ key: contentKey, image }); })
        .catch(reason => { if (!disposed && errorMessage(reason) !== cancelledRequest) setError(errorMessage(reason)); })
        .finally(() => { if (!disposed) setLoading(false); });
    }, thumbnail ? 0 : 100);
    return () => { disposed = true; lease.cancelled = true; window.clearTimeout(timer); };
  }, [contentKey, width, enabled, thumbnail]);
  // Keep the previous resolution while zooming; never display old page content after an edit.
  return { image: result?.key === contentKey ? result.image : null, loading, error };
}
