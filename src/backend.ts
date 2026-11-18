import { invoke } from '@tauri-apps/api/core';
import type { ImageAsset, ObjectPreviewLayers, PageRef, RenderedPage, RenderedPageLayers } from './types';

export const isDesktop = () => '__TAURI_INTERNALS__' in window;

type QueuedCall = {
  priority: number;
  work?: RenderWork;
  run: () => Promise<void>;
};
// A disposed view releases only its own lease. Another live viewer/thumbnail
// sharing the same request must still receive the native result.
export interface RenderLease { cancelled: boolean }
type RenderWork = { priority: number; unleased: boolean; leases: Set<RenderLease>; aborted?: boolean };
const isNeeded = (work: RenderWork) => work.unleased || [...work.leases].some(lease => !lease.cancelled);
let skippedRenders = 0, nativeRenders = 0;

const queue: QueuedCall[] = [];
let active = false;
let requestGeneration = 0;
export const sessionInvalidatedEvent = 'rivuleaf-session-invalidated';
export const cancelledRequest = 'REQUEST_CANCELLED';

async function drainQueue() {
  if (active) return;
  active = true;
  while (queue.length) {
    queue.sort((a, b) => (b.work?.priority ?? b.priority) - (a.work?.priority ?? a.priority));
    const next = queue.shift()!;
    await next.run();
  }
  active = false;
}

/** One PDF call at a time; foreground work precedes thumbnail rendering. */
function enqueue<T>(command: string, args: Record<string, unknown> | undefined, priority: number, generation: number, work?: RenderWork): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      priority,
      work,
      run: async () => {
        if (generation !== requestGeneration) { reject(new Error(cancelledRequest)); return; }
        if (work && !isNeeded(work)) { work.aborted = true; skippedRenders++; reject(new Error(cancelledRequest)); return; }
        try {
          if (work) nativeRenders++;
          const value = await invoke<T>(command, args);
          if (generation === requestGeneration) {
            rememberImage(value, command);
            if (command === 'close_all_documents') clearImageAssets();
          }
          resolve(value);
        } catch (error) {
          if (generation === requestGeneration && errorMessage(error).includes('SESSION_INVALIDATED:')) {
            resetBackendQueue();
            window.dispatchEvent(new CustomEvent(sessionInvalidatedEvent, { detail: errorMessage(error) }));
          }
          reject(error);
        }
      },
    });
    void drainQueue();
  });
}

// Local marks enter history immediately. Their registration happens in the
// background; only operations that consume these assets await registration.
// Waiting takes place BEFORE queueing IPC, so a save cannot deadlock behind it.
const imageAssets = new Map<string, ImageAsset>();
const stagedImages = new Map<string, { promise: Promise<ImageAsset>; nativeId?: string; error?: unknown }>();
const stagedData = new Map<string, string>();
let imageSequence = 0;
const LOCAL_IMAGE = 'jerrivell-preview-';
function rememberImage(value: unknown, command: string) {
  if (command === 'preview_image_edit') {
    const preview = value as { dataUrl?: string; width?: number; height?: number } | null;
    if (!preview || typeof preview.dataUrl !== 'string' || !preview.dataUrl.startsWith('data:image/png;base64,')
      || ![preview.width,preview.height].every(size=>Number.isSafeInteger(size)&&Number(size)>0)) {
      throw new Error('BACKEND_RESPONSE_INVALID: preview_image_edit 图像预览格式无效，请重试。');
    }
    return;
  }
  if (command === 'preview_image') {
    const preview = value as { dataUrl?: string; width?: number; height?: number; thumbnailWidth?: number; thumbnailHeight?: number } | null;
    if (!preview || typeof preview.dataUrl !== 'string' || !preview.dataUrl.startsWith('data:image/png;base64,')
      || ![preview.width,preview.height,preview.thumbnailWidth,preview.thumbnailHeight].every(size=>Number.isSafeInteger(size)&&Number(size)>0)) {
      throw new Error('BACKEND_RESPONSE_INVALID: preview_image 图像预览格式无效，请重试或更新应用。');
    }
    return;
  }
  const required = ['register_image', 'import_image', 'import_pdf_stamp', 'edit_image_asset', 'extract_content_image', 'get_image_asset', 'rasterize_page_asset'].includes(command);
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  // Image-returning commands share a flat contract. Recognize any future asset
  // producer by its shape as well, so adding a producer cannot silently omit it
  // from the live reader. Known producers must fail visibly on invalid data.
  if (!required && !(object && 'id' in object && 'dataUrl' in object)) return;
  const asset = object as unknown as ImageAsset | null;
  if (!asset || typeof asset.id !== 'string' || !asset.id.trim() || typeof asset.dataUrl !== 'string' || !asset.dataUrl.startsWith('data:image/png;base64,')
    || !Number.isSafeInteger(asset.width) || asset.width < 1 || !Number.isSafeInteger(asset.height) || asset.height < 1
    || (command === 'import_pdf_stamp' && (!Number.isSafeInteger(object?.pageCount) || Number(object?.pageCount) < 1))) {
    throw new Error(`BACKEND_RESPONSE_INVALID: ${command} 未返回有效的图像资源，请重试或更新应用。`);
  }
  imageAssets.set(asset.id, { id: asset.id, dataUrl: asset.dataUrl, width: asset.width, height: asset.height });
}
function clearImageAssets() { imageAssets.clear(); stagedImages.clear(); stagedData.clear(); }
export const previewImageAsset = (id: string) => imageAssets.get(id);

export function stageImageAsset(dataUrl: string): { id: string; registered: Promise<ImageAsset> } {
  const existing = stagedData.get(dataUrl);
  if (existing && stagedImages.has(existing)) return { id: existing, registered: stagedImages.get(existing)!.promise };
  if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 1_500_000) throw new Error('标记图像超过限制，请缩小绘制区域或简化笔画。');
  const id = `${LOCAL_IMAGE}${requestGeneration}-${++imageSequence}`;
  const generation = requestGeneration;
  imageAssets.set(id, { id, dataUrl, width: 1, height: 1 });
  const record: { promise: Promise<ImageAsset>; nativeId?: string; error?: unknown } = { promise: null! };
  record.promise = backend<ImageAsset>('register_image', { dataUrl }, 3).then(asset => {
    if (generation !== requestGeneration || stagedImages.get(id) !== record) throw new Error(cancelledRequest);
    record.nativeId = asset.id;
    imageAssets.set(id, { ...asset, id });
    return asset;
  }).catch(error => {
    record.error = error;
    if (generation === requestGeneration) { imageAssets.delete(id); stagedData.delete(dataUrl); }
    throw error;
  });
  stagedImages.set(id, record); stagedData.set(dataUrl, id);
  return { id, registered: record.promise };
}

function assetArguments(value: unknown, dependencies: Set<Promise<ImageAsset>>, field = ''): unknown {
  if (typeof value === 'string' && ['assetId', 'replacementAssetId'].includes(field) && value.startsWith(LOCAL_IMAGE)) {
    const record = stagedImages.get(value);
    if (!record) throw new Error('标记图片会话已失效，请重新绘制。');
    if (record.error) throw record.error;
    if (record.nativeId) return record.nativeId;
    dependencies.add(record.promise); return value;
  }
  if (Array.isArray(value)) return value.map(item => assetArguments(item, dependencies));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, assetArguments(item, dependencies, key)]));
  return value;
}

export function backend<T>(command: string, args?: Record<string, unknown>, priority = 2, work?: RenderWork): Promise<T> {
  const generation = requestGeneration;
  try {
    const dependencies = new Set<Promise<ImageAsset>>();
    const native = assetArguments(args, dependencies) as typeof args;
    if (!dependencies.size) return enqueue(command, native, priority, generation, work);
    return Promise.all(dependencies).then(() => {
      if (generation !== requestGeneration) throw new Error(cancelledRequest);
      return enqueue<T>(command, assetArguments(native, new Set()) as typeof args, priority, generation, work);
    });
  } catch (error) { return Promise.reject(error); }
}

const renderCache = new Map<string, RenderedPage>();
const pendingRenders = new Map<string, { promise: Promise<RenderedPage>; work: RenderWork }>();
const layerCache = new Map<string, RenderedPageLayers>();
const pendingLayers = new Map<string, { promise: Promise<RenderedPageLayers>; work: RenderWork }>();
const objectCache = new Map<string, ObjectPreviewLayers>();
const pendingObjects = new Map<string, { promise: Promise<ObjectPreviewLayers>; work: RenderWork }>();
let cacheGeneration = 0;
const CACHE_LIMIT = 96 * 1024 * 1024;
type RasterKind = 'page' | 'layers' | 'object';
const cacheOrder = new Map<string, { kind: RasterKind; bytes: number; key: string }>();
let cacheBytes = 0;
const imageCost = (image: RenderedPage) => image.dataUrl.length * 2 + image.width * image.height * 4;
function touchCache(kind: RasterKind, key: string) {
  const id = `${kind}:${key}`, entry = cacheOrder.get(id);
  if (entry) { cacheOrder.delete(id); cacheOrder.set(id, entry); }
}
function forgetRaster(kind: RasterKind, key: string) { if (kind === 'page') renderCache.delete(key); else if (kind === 'layers') layerCache.delete(key); else objectCache.delete(key); }
function rememberRaster(kind: RasterKind, key: string, value: RenderedPage | RenderedPageLayers | ObjectPreviewLayers) {
  const id = `${kind}:${key}`, previous = cacheOrder.get(id);
  if (previous) { cacheBytes -= previous.bytes; cacheOrder.delete(id); forgetRaster(kind, key); }
  const bytes = 'lower' in value ? imageCost(value.lower) + imageCost(value.moving) + imageCost(value.upper) + value.foreground.reduce((sum, layer) => sum + imageCost(layer.image), 0)
    : 'background' in value ? imageCost(value.background) + value.foreground.reduce((sum, layer) => sum + imageCost(layer.image), 0) : imageCost(value);
  // Oversized images can be displayed by the current view, but are not retained
  // again by the shared cache. Estimate includes RGBA decode plus UTF-16 URLs.
  if (bytes > CACHE_LIMIT) return;
  if (kind === 'page') renderCache.set(key, value as RenderedPage); else if (kind === 'layers') layerCache.set(key, value as RenderedPageLayers); else objectCache.set(key, value as ObjectPreviewLayers);
  cacheOrder.set(id, { kind, key, bytes }); cacheBytes += bytes;
  while (cacheBytes > CACHE_LIMIT || cacheOrder.size > 160) {
    const [oldId, entry] = cacheOrder.entries().next().value!;
    cacheOrder.delete(oldId); cacheBytes -= entry.bytes;
    forgetRaster(entry.kind, entry.key);
  }
}
function subscribe(work: RenderWork, thumbnail: boolean, lease?: RenderLease) {
  if (lease) work.leases.add(lease); else work.unleased = true;
  if (!thumbnail) work.priority = 1;
}
function renderWork(thumbnail: boolean, lease?: RenderLease): RenderWork {
  const work: RenderWork = { priority: thumbnail ? 0 : 1, unleased: false, leases: new Set() };
  subscribe(work, thumbnail, lease); return work;
}
/** Only this resource-free preview is cancellable; writes/exports keep normal
 * backend semantics and are never discarded when a view closes. */
export function previewImageEdit(args: Record<string, unknown>, lease: RenderLease): Promise<RenderedPage> {
  const work = renderWork(false, lease); work.priority = 2;
  return backend<RenderedPage>('preview_image_edit', args, 2, work);
}
/** Diagnostics measure retained rasters and avoided IPC, not total process/GPU memory. */
export const renderDiagnostics = () => ({ estimatedCacheBytes: cacheBytes, cacheLimitBytes: CACHE_LIMIT, cacheEntries: cacheOrder.size, queued: queue.length, skippedRenders, nativeRenders });

export function pageReference(page: PageRef): PageRef {
  return { documentId: page.documentId, pageIndex: page.pageIndex, rotation: page.rotation,
    ...(page.contentEdits?.length ? { contentEdits: page.contentEdits.map(edit => ({ ...edit, ...(edit.bounds ? { bounds: { ...edit.bounds } } : {}) })) } : {}),
    ...(page.overlays?.length ? { overlays: page.overlays.map(({ locked: _locked, textSource: _textSource, ...overlay }) => ({ ...overlay })) } : {}),
    ...(page.decorations?.length ? { decorations: page.decorations.map(item => ({ ...item })) } : {}) };
}

export function renderPage(page: PageRef, targetWidth: number, thumbnail = false, lease?: RenderLease): Promise<RenderedPage> {
  const width = Math.max(80, Math.round(targetWidth));
  const key = `${JSON.stringify(pageReference(page))}:${width}`;
  const cached = renderCache.get(key);
  if (cached) {
    touchCache('page', key);
    return Promise.resolve(cached);
  }
  const pending = pendingRenders.get(key);
  if (pending && !pending.work.aborted) { subscribe(pending.work, thumbnail, lease); return pending.promise; }
  const generation = cacheGeneration;
  const work = renderWork(thumbnail, lease);
  const request = backend<RenderedPage>('render_page', { page: pageReference(page), targetWidth: width }, thumbnail ? 0 : 1, work)
    .then((result) => {
      if (generation === cacheGeneration) {
        if (isNeeded(work)) rememberRaster('page', key, result);
      }
      return result;
    })
    .finally(() => { if (pendingRenders.get(key)?.promise === request) pendingRenders.delete(key); });
  pendingRenders.set(key, { promise: request, work });
  return request;
}

/** Overlay placement/opacity/history do not change the expensive native raster. */
export function rasterReference(page: PageRef): PageRef { return pageReference({ ...page, overlays: [] }); }
export function cachedPageLayers(page: PageRef, targetWidth: number): RenderedPageLayers | undefined {
  const key = `${JSON.stringify(rasterReference(page))}:${Math.max(80,Math.round(targetWidth))}`;
  const cached = layerCache.get(key); if (cached) touchCache('layers', key); return cached;
}
export function renderPageLayers(page: PageRef, targetWidth: number, thumbnail = false, lease?: RenderLease): Promise<RenderedPageLayers> {
  const reference = rasterReference(page), width = Math.max(80, Math.round(targetWidth));
  const key = `${JSON.stringify(reference)}:${width}`;
  const cached = layerCache.get(key);
  if (cached) { touchCache('layers', key); return Promise.resolve(cached); }
  const pending = pendingLayers.get(key); if (pending && !pending.work.aborted) { subscribe(pending.work, thumbnail, lease); return pending.promise; }
  const generation = cacheGeneration;
  const work = renderWork(thumbnail, lease);
  const request = backend<RenderedPageLayers>('render_page_layers', { page: reference, targetWidth: width }, thumbnail ? 0 : 1, work).then(value => {
    if (generation === cacheGeneration) {
      if (isNeeded(work)) rememberRaster('layers', key, value);
    }
    return value;
  }).finally(() => { if (pendingLayers.get(key)?.promise === request) pendingLayers.delete(key); });
  pendingLayers.set(key, { promise: request, work }); return request;
}

/** Object hover preparation shares the same bounded raster cache and queue.
 * Disposed hover targets can be skipped without delaying the active drag. */
export function renderObjectLayers(page: PageRef, objectIndex: number, fingerprint: string, targetWidth = 1200, prefetch = false, lease?: RenderLease): Promise<ObjectPreviewLayers> {
  const reference = rasterReference(page), width = Math.max(80, Math.round(targetWidth));
  const key = JSON.stringify([reference, objectIndex, fingerprint, width]);
  const cached = objectCache.get(key);
  if (cached) { touchCache('object', key); return Promise.resolve(cached); }
  const pending = pendingObjects.get(key);
  if (pending && !pending.work.aborted) { subscribe(pending.work, prefetch, lease); return pending.promise; }
  const generation = cacheGeneration, work = renderWork(prefetch, lease);
  const request = backend<ObjectPreviewLayers>('render_object_layers', { page: reference, objectIndex, fingerprint, targetWidth: width }, prefetch ? 0 : 1, work).then(value => {
    if (generation === cacheGeneration && isNeeded(work)) rememberRaster('object', key, value);
    return value;
  }).finally(() => { if (pendingObjects.get(key)?.promise === request) pendingObjects.delete(key); });
  pendingObjects.set(key, { promise: request, work }); return request;
}

export function clearRenderCache() {
  cacheGeneration++;
  renderCache.clear();
  pendingRenders.clear();
  layerCache.clear(); pendingLayers.clear();
  objectCache.clear(); pendingObjects.clear();
  cacheOrder.clear(); cacheBytes = 0;
}

/** Cancel queued work from the old workspace before releasing its documents. */
export function resetBackendQueue() {
  requestGeneration++;
  clearRenderCache();
  clearImageAssets();
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '操作未完成，请重试。';
}
