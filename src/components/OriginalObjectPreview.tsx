// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { backend, errorMessage, rasterReference } from '../backend';
import type { ObjectPreviewLayers, WorkspacePage } from '../types';
import type { ContentBounds, ContentObject } from '../originalContent';
import { LivePageImage } from './LivePageImage';
import { useI18n } from '../i18n';

export function OriginalObjectPreview({ page, object, bounds, visible }: { page?: WorkspacePage; object?: ContentObject; bounds?: ContentBounds; visible: boolean }) {
  const { t } = useI18n();
  const key = page && object ? JSON.stringify([rasterReference(page),object.objectIndex,object.fingerprint]) : '';
  const [result,setResult] = useState<{key:string;layers:ObjectPreviewLayers}|null>(null);
  const [error,setError] = useState('');
  const cache = useRef(new Map<string,Promise<ObjectPreviewLayers>>());
  useEffect(() => {
    if (!key || !page || !object || !object.editable || object.deleted) return;
    setError('');
    let disposed = false;
    const timer = window.setTimeout(() => {
      let request = cache.current.get(key);
      if (!request) {
        request = backend<ObjectPreviewLayers>('render_object_layers',{page:rasterReference(page),objectIndex:object.objectIndex,fingerprint:object.fingerprint,targetWidth:1200},1);
        cache.current.set(key,request); if(cache.current.size>8)cache.current.delete(cache.current.keys().next().value!);
      }
      void request.then(async layers => {
        await Promise.all([layers.lower,layers.moving,layers.upper,...layers.foreground.map(layer=>layer.image)].map(async image=>{const decoded=new Image();decoded.src=image.dataUrl;await decoded.decode();}));
        if(!disposed)setResult({key,layers});
      }).catch(reason=>{cache.current.delete(key);if(!disposed)setError(errorMessage(reason));});
    },visible ? 0 : 40);
    return ()=>{disposed=true;window.clearTimeout(timer);};
  },[key,visible]);
  if(visible && error)return <div className="oc-preview-error" role="status">{t('实时预览未能载入，松手后更新页面。','Live preview could not load; the page will update after release.')} {error}</div>;
  if(!visible || !page || !object || !bounds || result?.key!==key)return null;
  const layers=result.layers;
  return <div className="oc-live-preview" aria-hidden="true"><LivePageImage page={page} label="" layers={{background:layers.lower,foreground:layers.foreground}} nativePlacement={{layers,original:object.bounds,bounds}}/></div>;
}
