// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { useI18n } from '../i18n';
import { boundedContentBounds, contentObjectId, contentStep, translatedContentBounds, upsertContentEdit } from '../originalContent';
import type { ContentBounds, ContentChange, ContentEdit, ContentObject } from '../originalContent';
import './original-content.css';
import { OriginalObjectPreview } from './OriginalObjectPreview';
import type { WorkspacePage } from '../types';

type Gesture = { object: ContentObject; original: ContentBounds; next: ContentBounds; kind: 'move' | 'resize'; pointerId: number; x: number; y: number; rectangle: DOMRect; page?: WorkspacePage; key?: string };
type Preview = { id: string; bounds: ContentBounds; object: ContentObject; page?: WorkspacePage; key?: string };
export function OriginalContentHandles({ objects, contentEdits, selectedId, onSelect, onChange, pageWidth, pageHeight, disabled = false, inspectionKey, page, rendering = false, eraseMode = false }: {
  objects: ContentObject[]; contentEdits: ContentEdit[]; selectedId?: string; onSelect: (id: string) => void; onChange: ContentChange;
  pageWidth: number; pageHeight: number; disabled?: boolean; inspectionKey?: string; page?: WorkspacePage; rendering?: boolean; eraseMode?: boolean;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null), settling = useRef(false), committedPlanSeen = useRef(false);
  const [hoveredId,setHoveredId] = useState('');
  useEffect(() => { if (!settling.current) { gesture.current = null; setPreview(null); } }, [inspectionKey, disabled]);
  useEffect(() => {
    if (!settling.current || !preview) return;
    if (inspectionKey !== preview.key) committedPlanSeen.current = true;
    if (committedPlanSeen.current && !rendering) { settling.current = false; committedPlanSeen.current = false; setPreview(null); }
  }, [inspectionKey,rendering]);
  const begin = (event: PointerEvent<HTMLDivElement>, object: ContentObject, kind: Gesture['kind']) => {
    if (event.button !== 0 || disabled || !root.current) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
    onSelect(contentObjectId(object));
    if (!object.editable || object.deleted) return;
    if (eraseMode) { void onChange(upsertContentEdit(contentEdits,object,{deleted:true})); return; }
    const rectangle = root.current.getBoundingClientRect();
    if (!rectangle.width || !rectangle.height) return;
    gesture.current = { object, original: object.bounds, next: object.bounds, kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rectangle, page, key: inspectionKey };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPreview({ id: contentObjectId(object), bounds: object.bounds, object, page, key: inspectionKey });
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointerId || disabled) return;
    event.preventDefault(); event.stopPropagation();
    const dx = (event.clientX - active.x) / active.rectangle.width, dy = (event.clientY - active.y) / active.rectangle.height;
    active.next = active.kind === 'move' ? translatedContentBounds(active.original, dx, dy)
      : boundedContentBounds({ ...active.original, width: Math.max(.0001, Math.min(1 - active.original.x, active.original.width + dx)), height: Math.max(.0001, Math.min(1 - active.original.y, active.original.height + dy)) });
    setPreview({ id: contentObjectId(active.object), bounds: active.next, object: active.object, page: active.page, key: active.key });
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancel || disabled || !objects.some(object => object.objectIndex === active.object.objectIndex && object.fingerprint === active.object.fingerprint)) { setPreview(null); return; }
    if (JSON.stringify(active.original) !== JSON.stringify(active.next)) {
      settling.current = true; committedPlanSeen.current = false;
      void Promise.resolve(onChange(upsertContentEdit(contentEdits, active.object, { bounds: active.next }))).then(result => { if(result===false){settling.current=false;setPreview(null);} }).catch(()=>{settling.current=false;setPreview(null);});
    } else setPreview(null);
  };
  return <div ref={root} className="original-content-handles" aria-label={t('PDF 原有对象选择与位置控制', 'Original PDF object selection and placement')}>
    <OriginalObjectPreview page={preview?.page ?? page} object={preview?.object ?? objects.find(object=>contentObjectId(object)===(hoveredId || selectedId))} bounds={preview?.bounds} visible={Boolean(preview)}/>
    {objects.filter(object => !object.deleted && object.bounds.width > 0 && object.bounds.height > 0 && (object.kind !== 'unsupported' || contentObjectId(object) === selectedId)).map(object => {
      const id = contentObjectId(object), bounds = preview?.id === id ? preview.bounds : object.bounds;
      return <div key={`${id}:${object.fingerprint}`} role="button" tabIndex={disabled ? -1 : 0} aria-pressed={selectedId === id}
        aria-label={t(`选择原有${object.kind === 'text' ? '文字' : object.kind === 'image' ? '图片' : '内容'}对象 ${object.objectIndex + 1}`, `Select original ${object.kind} object ${object.objectIndex + 1}`)}
        className={`oc-page-object ${selectedId === id ? 'selected' : ''} ${!object.editable ? 'oc-unsupported' : ''} ${object.kind === 'image' ? 'oc-image-object' : ''}`}
        style={{ left: `${bounds.x * 100}%`, top: `${bounds.y * 100}%`, width: `${bounds.width * 100}%`, height: `${bounds.height * 100}%` }}
        onPointerEnter={()=>{if(object.editable&&!eraseMode)setHoveredId(id);}} onPointerLeave={()=>{if(!gesture.current)setHoveredId('');}} onFocus={() => onSelect(id)} onPointerDown={event => begin(event, object, 'move')} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
        onLostPointerCapture={event => { if (gesture.current?.pointerId === event.pointerId) { gesture.current = null; setPreview(null); } }}
        onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation(); if (disabled || !object.editable) return;
            const dx = contentStep(pageWidth, event.shiftKey), dy = contentStep(pageHeight, event.shiftKey);
            const next = translatedContentBounds(object.bounds, event.key === 'ArrowLeft' ? -dx : event.key === 'ArrowRight' ? dx : 0, event.key === 'ArrowUp' ? -dy : event.key === 'ArrowDown' ? dy : 0);
            if (JSON.stringify(next) !== JSON.stringify(object.bounds)) void onChange(upsertContentEdit(contentEdits, object, { bounds: next }));
          } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault(); event.stopPropagation(); if (!disabled && object.editable) void onChange(upsertContentEdit(contentEdits, object, { deleted: true }));
          } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (!disabled) onSelect(id); }
        }}>
        {selectedId === id && <span className="oc-page-number">{object.objectIndex + 1}</span>}
        {selectedId === id && object.editable && !disabled && <div className="oc-page-resize" title={t('拖动调整原对象宽高', 'Drag to resize the original object')} onPointerDown={event => begin(event, object, 'resize')} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}/>}
      </div>;
    })}
  </div>;
}
