// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react';
import { backend, cancelledRequest, errorMessage, isDesktop, pageReference, renderPage } from '../backend';
import type { ImageFilePreview, RenderedPage, WorkspacePage } from '../types';
import type { ExportPart } from '../documentTools';
import { visiblePageSize } from '../viewerGeometry';
import { useI18n } from '../i18n';
import { MarkLayer } from './MarkLayer';
import { PreviewZoom } from './PreviewZoom';

type ImagePreview = ImageFilePreview;
type Crop = { x: number; y: number; width: number; height: number };
export interface ToolPreviewProps {
  tab: string; pages: WorkspacePage[]; targets: WorkspacePage[]; insertAt: number;
  imagePaths: string[]; imagePaper: string; margin: number;
  onReady?: (ready:boolean) => void;
  parts: ExportPart[]; splitError: string; crop: Crop; onCrop: (crop: Crop) => void; working: boolean;
}

/** Keep decoded content through parameter changes, isolate different sources. */
export function useToolImage(page: WorkspacePage | undefined) {
  const key = page ? JSON.stringify(pageReference(page)) : '';
  const identity = page ? JSON.stringify([page.documentId, page.pageIndex, page.rotation]) : '';
  const [result, setResult] = useState<{ identity: string; key: string; image: RenderedPage } | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const decodedCache = useRef(new Map<string, RenderedPage>());
  useEffect(() => {
    if (!page || !isDesktop()) return;
    if (decodedCache.current.has(key)) { setPending(false); setError(''); return; }
    let disposed = false; const lease = { cancelled: false }; setPending(true); setError('');
    const timer = window.setTimeout(() => {
      void renderPage(page, 1000, false, lease).then(async image => {
        const decoded = new Image(); decoded.src = image.dataUrl; await decoded.decode();
        if (!disposed) {
          decodedCache.current.set(key,image);
          let bytes = [...decodedCache.current.values()].reduce((sum, value) => sum + value.width * value.height * 4 + value.dataUrl.length * 2, 0);
          while (decodedCache.current.size > 8 || bytes > 24 * 1024 * 1024) {
            const oldest = decodedCache.current.keys().next().value!, value = decodedCache.current.get(oldest)!;
            decodedCache.current.delete(oldest); bytes -= value.width * value.height * 4 + value.dataUrl.length * 2;
          }
          setResult({ identity, key, image });
        }
      }).catch(reason => { if (!disposed && errorMessage(reason) !== cancelledRequest) setError(errorMessage(reason)); })
        .finally(() => { if (!disposed) setPending(false); });
    }, result?.identity === identity ? 120 : 0);
    return () => { disposed = true; lease.cancelled = true; window.clearTimeout(timer); };
  }, [key]);
  const cached=decodedCache.current.get(key);
  return { image: cached ?? (result?.identity === identity ? result.image : null), pending: !cached && (pending || result?.key !== key), error };
}

export function PageToolPreview(props: ToolPreviewProps) {
  const { t } = useI18n();
  const [cursor, setCursor] = useState(0), [partIndex, setPartIndex] = useState(0);
  const [images, setImages] = useState<Record<string, ImagePreview>>({}), [imageError, setImageError] = useState('');
  const imageCache = useRef(new Map<string, Promise<ImagePreview>>());
  const sourceKey = JSON.stringify([props.tab, props.targets.map(page => page.id), props.imagePaths]);
  useEffect(() => { setCursor(0); setPartIndex(0); }, [sourceKey]);
  useEffect(() => {
    if (props.tab !== 'images') return;
    let disposed = false; setImageError('');
    void (async () => {
      for (const path of props.imagePaths.slice(0, 32)) {
        if (disposed) return;
        let request = imageCache.current.get(path);
        if (!request) { request = backend<ImagePreview>('preview_image', { path }, 1); imageCache.current.set(path, request); }
        try { const image = await request; if (!disposed) setImages(previous => ({ ...previous, [path]: image })); }
        catch (reason) { imageCache.current.delete(path); if (!disposed) setImageError(errorMessage(reason)); }
      }
    })();
    return () => { disposed = true; };
  }, [props.tab, JSON.stringify(props.imagePaths)]);
  const part = props.parts[Math.min(partIndex, props.parts.length - 1)];
  const list = props.tab === 'split' ? part?.pages ?? [] : props.targets;
  const total = props.tab === 'images' ? props.imagePaths.length : list.length;
  const index = Math.min(cursor, Math.max(0, total - 1));
  const page = props.tab === 'images' ? undefined : list[index];
  const rendered = useToolImage(page), asset = images[props.imagePaths[index]];
  useEffect(()=>{props.onReady?.(props.tab==='images' ? !props.imagePaths.length || Boolean(asset) && !imageError : !page || !rendered.pending && !rendered.error);},[props.tab,page?.id,rendered.pending,rendered.error,asset,imageError]);
  let dimensions = page ? visiblePageSize(page) : { width: 595.28, height: 841.89 };
  if (props.tab === 'images') dimensions = props.imagePaper === 'original' && asset
    ? { width: asset.width * .75 + props.margin * 2, height: asset.height * .75 + props.margin * 2 }
    : asset && asset.width > asset.height ? { width: 841.89, height: 595.28 } : { width: 595.28, height: 841.89 };
  const insertCount = props.imagePaths.length;
  const inserting = props.tab === 'images';
  const imageScale = asset ? Math.max(0, Math.min((dimensions.width - props.margin * 2) / asset.width, (dimensions.height - props.margin * 2) / asset.height)) : 0;
  return <section className="tool-preview-workspace" aria-label={t('实时操作预览', 'Live operation preview')}>
    <div className="tool-preview-heading"><div><b>{props.tab === 'split' ? t('拆分文件与页序', 'Split files and page order') : props.tab === 'images' ? t('图片排版预览', 'Image layout') : t('处理效果预览', 'Result preview')}</b><span>{page ? `${t('来源页', 'Source page')} ${page.pageIndex + 1} · ${page.sourceName}` : t('选择图片后显示实际排版', 'Choose images to preview their layout')}</span></div>{rendered.pending && page && <small role="status"><LoaderCircle size={12} className="spin"/>{t('更新中', 'Updating')}</small>}</div>
    {inserting && <div className="tool-insert-strip" aria-label={t('插入后的页序预览', 'Page order after insertion')}><span>{t(`原 ${props.pages.length} 页`, `${props.pages.length} existing pages`)}</span><span>→</span><b>{t(`第 ${props.insertAt + 1} 页起插入 ${Number.isFinite(insertCount) ? insertCount : '—'} 页`, `Insert ${Number.isFinite(insertCount) ? insertCount : '—'} pages at ${props.insertAt + 1}`)}</b><span>→</span><span>{t(`共 ${props.pages.length + (Number.isFinite(insertCount) ? insertCount : 0)} 页`, `${props.pages.length + (Number.isFinite(insertCount) ? insertCount : 0)} pages total`)}</span></div>}
    {props.tab === 'split' && <div className="tool-split-groups">{props.parts.map((value, n) => <button key={value.name} className={n === partIndex ? 'active' : ''} onClick={() => { setPartIndex(n); setCursor(0); }}><b>{n + 1}. {value.name}</b><span>{value.pages.length} {t('页', 'pages')} · {value.pages.slice(0, 12).map(p => props.pages.findIndex(candidate => candidate.id === p.id) + 1).join(', ')}{value.pages.length > 12 ? '…' : ''}</span></button>)}</div>}
    {props.splitError && props.tab === 'split' && <p className="dt-error" role="alert">{props.splitError}</p>}
    <div className="tool-preview-stage">
      {(props.tab === 'images' && asset || page) && <PreviewZoom width={dimensions.width} height={dimensions.height} resetKey={`${props.tab}:${page?.id ?? props.imagePaths[index]}`} label={t('页面工具可缩放预览', 'Zoomable page tool preview')} disabled={props.working}><div className="dt-tool-page" style={{ width:'100%', height:'100%' }}>
        {props.tab === 'images' && asset ? <svg width="100%" height="100%" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}><rect width={dimensions.width} height={dimensions.height} fill="white"/><rect x={props.margin} y={props.margin} width={Math.max(0, dimensions.width - 2 * props.margin)} height={Math.max(0, dimensions.height - 2 * props.margin)} fill="none" stroke="#c8bddc" strokeWidth={1} strokeDasharray="4 4"/><image href={asset.dataUrl} x={(dimensions.width - asset.width * imageScale) / 2} y={(dimensions.height - asset.height * imageScale) / 2} width={asset.width * imageScale} height={asset.height * imageScale}/></svg> : rendered.image ? <img src={rendered.image.dataUrl} alt={t('页面工具预览', 'Page tool preview')}/> : <div className="dt-empty"><LoaderCircle className="spin"/><p>{rendered.error || t('正在载入页面', 'Loading page')}</p></div>}
        {props.tab === 'crop' && rendered.image && <><div className="dt-crop-outline" style={{ left: `${props.crop.x * 100}%`, top: `${props.crop.y * 100}%`, width: `${props.crop.width * 100}%`, height: `${props.crop.height * 100}%` }}/><MarkLayer settings={{ tool: 'rectangle', color: '#7561cb', opacity: .7, lineWidth: 2 }} pageWidth={dimensions.width} pageHeight={dimensions.height} disabled={props.working} onBegin={() => {}} onComplete={mark => props.onCrop(mark.bounds)}/></>}
      </div></PreviewZoom>}
      {!page && !(props.tab === 'images' && asset) && <div className="dt-empty"><p>{imageError || (props.tab === 'images' ? t('选择 PNG / JPEG 后，将显示纸张、比例与页边距。', 'Choose PNG / JPEG images to see paper, scaling and margins.') : t('选择有效页面或分组以查看内容。', 'Choose valid pages or a group to view its content.'))}</p></div>}
    </div>
    <div className="dt-page-nav"><button disabled={index <= 0} aria-label={t('预览上一页', 'Previous preview page')} onClick={() => setCursor(index - 1)}><ChevronLeft size={17}/></button><span>{total ? index + 1 : 0} / {Number.isFinite(total) ? total : '—'}</span><button disabled={index >= total - 1} aria-label={t('预览下一页', 'Next preview page')} onClick={() => setCursor(index + 1)}><ChevronRight size={17}/></button></div>
    {rendered.error && <p className="dt-error" role="alert">{rendered.error}</p>}
    {props.tab === 'crop' && <p className="dt-muted">{t(`裁剪后约 ${(dimensions.width * props.crop.width * 25.4 / 72).toFixed(1)} × ${(dimensions.height * props.crop.height * 25.4 / 72).toFixed(1)} mm`, `Cropped: ${(dimensions.width * props.crop.width * 25.4 / 72).toFixed(1)} × ${(dimensions.height * props.crop.height * 25.4 / 72).toFixed(1)} mm`)}</p>}
  </section>;
}
