// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useState } from 'react';
import { cancelledRequest, errorMessage, rasterReference, renderObjectLayers } from '../backend';
import type { ObjectPreviewLayers, WorkspacePage } from '../types';
import type { ContentBounds, ContentObject } from '../originalContent';
import { LivePageImage } from './LivePageImage';
import { useI18n } from '../i18n';

const decoded = new WeakSet<ObjectPreviewLayers>();
const decoding = new WeakMap<ObjectPreviewLayers, Promise<void>>();
function decodeObject(layers: ObjectPreviewLayers): Promise<void> {
  if (decoded.has(layers)) return Promise.resolve();
  const pending = decoding.get(layers); if (pending) return pending;
  const promise = Promise.all([layers.lower,layers.moving,layers.upper,...layers.foreground.map(layer=>layer.image)].map(async image=>{const bitmap=new Image();bitmap.src=image.dataUrl;await bitmap.decode();}))
    .then(() => { decoded.add(layers); }).finally(() => decoding.delete(layers));
  decoding.set(layers, promise); return promise;
}

export function OriginalObjectPreview({ page, object, bounds, visible }: { page?: WorkspacePage; object?: ContentObject; bounds?: ContentBounds; visible: boolean }) {
  const { t } = useI18n();
  const key = page && object ? JSON.stringify([rasterReference(page),object.objectIndex,object.fingerprint]) : '';
  const [result,setResult] = useState<{key:string;layers:ObjectPreviewLayers}|null>(null);
  const [error,setError] = useState('');
  useEffect(() => {
    if (!key || !page || !object || !object.editable || object.deleted) return;
    setError('');
    let disposed = false;
    const lease = { cancelled: false };
    const timer = window.setTimeout(() => {
      void renderObjectLayers(page,object.objectIndex,object.fingerprint,1200,!visible,lease).then(async layers => {
        if (disposed) return;
        await decodeObject(layers);
        if(!disposed)setResult({key,layers});
      }).catch(reason=>{if(!disposed && errorMessage(reason)!==cancelledRequest)setError(errorMessage(reason));});
    },visible ? 0 : 40);
    return ()=>{disposed=true;lease.cancelled=true;window.clearTimeout(timer);};
  },[key,visible]);
  if(visible && error)return <div className="oc-preview-error" role="status">{t('实时预览未能载入，松手后更新页面。','Live preview could not load; the page will update after release.')} {error}</div>;
  if(!visible || !page || !object || !bounds || result?.key!==key)return null;
  const layers=result.layers;
  return <div className="oc-live-preview" aria-hidden="true"><LivePageImage page={page} label="" layers={{background:layers.lower,foreground:layers.foreground}} nativePlacement={{layers,original:object.bounds,bounds}}/></div>;
}
