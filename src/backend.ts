import { invoke } from '@tauri-apps/api/core';
import type { ImageAsset, PageRef, RenderedPage, RenderedPageLayers } from './types';

export const isDesktop = () => '__TAURI_INTERNALS__' in window;

type QueuedCall = {
  priority: number;
  run: () => Promise<void>;
};

const queue: QueuedCall[] = [];
let active = false;
let requestGeneration = 0;
export const sessionInvalidatedEvent = 'rivuleaf-session-invalidated';
export const cancelledRequest = 'REQUEST_CANCELLED';

async function drainQueue() {
  if (active) return;
  active = true;
  while (queue.length) {
    queue.sort((a, b) => b.priority - a.priority);
    const next = queue.shift()!;
    await next.run();
  }
  active = false;
}

/** One PDF call at a time; foreground work precedes thumbnail rendering. */
function enqueue<T>(command: string, args: Record<string, unknown> | undefined, priority: number, generation: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      priority,
      run: async () => {
        if (generation !== requestGeneration) { reject(new Error(cancelledRequest)); return; }
        try {
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
  const required = ['register_image', 'import_image', 'import_pdf_stamp'].includes(command);
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

export function backend<T>(command: string, args?: Record<string, unknown>, priority = 2): Promise<T> {
  const generation = requestGeneration;
  try {
    const dependencies = new Set<Promise<ImageAsset>>();
    const native = assetArguments(args, dependencies) as typeof args;
    if (!dependencies.size) return enqueue(command, native, priority, generation);
    return Promise.all(dependencies).then(() => {
      if (generation !== requestGeneration) throw new Error(cancelledRequest);
      return enqueue<T>(command, assetArguments(native, new Set()) as typeof args, priority, generation);
    });
  } catch (error) { return Promise.reject(error); }
}

const renderCache = new Map<string, RenderedPage>();
const pendingRenders = new Map<string, Promise<RenderedPage>>();
const layerCache = new Map<string, RenderedPageLayers>();
const pendingLayers = new Map<string, Promise<RenderedPageLayers>>();
let cacheGeneration = 0;

export function pageReference(page: PageRef): PageRef {
  return { documentId: page.documentId, pageIndex: page.pageIndex, rotation: page.rotation,
    ...(page.contentEdits?.length ? { contentEdits: page.contentEdits.map(edit => ({ ...edit, ...(edit.bounds ? { bounds: { ...edit.bounds } } : {}) })) } : {}),
    ...(page.overlays?.length ? { overlays: page.overlays.map(({ locked: _locked, ...overlay }) => ({ ...overlay })) } : {}),
    ...(page.decorations?.length ? { decorations: page.decorations.map(item => ({ ...item })) } : {}) };
}

export function renderPage(page: PageRef, targetWidth: number, thumbnail = false): Promise<RenderedPage> {
  const width = Math.max(80, Math.round(targetWidth));
  const key = `${JSON.stringify(pageReference(page))}:${width}`;
  const cached = renderCache.get(key);
  if (cached) {
    renderCache.delete(key);
    renderCache.set(key, cached);
    return Promise.resolve(cached);
  }
  const pending = pendingRenders.get(key);
  if (pending) return pending;
  const generation = cacheGeneration;
  const request = backend<RenderedPage>('render_page', { page: pageReference(page), targetWidth: width }, thumbnail ? 0 : 1)
    .then((result) => {
      if (generation === cacheGeneration) {
        renderCache.set(key, result);
        let largeCount = 0;
        for (const value of renderCache.values()) if (value.width > 220) largeCount++;
        if (largeCount > 8) {
          for (const [oldKey, value] of renderCache) {
            if (value.width > 220) { renderCache.delete(oldKey); break; }
          }
        }
        while (renderCache.size > 140) renderCache.delete(renderCache.keys().next().value!);
      }
      return result;
    })
    .finally(() => { if (pendingRenders.get(key) === request) pendingRenders.delete(key); });
  pendingRenders.set(key, request);
  return request;
}

/** Overlay placement/opacity/history do not change the expensive native raster. */
export function rasterReference(page: PageRef): PageRef { return pageReference({ ...page, overlays: [] }); }
export function renderPageLayers(page: PageRef, targetWidth: number, thumbnail = false): Promise<RenderedPageLayers> {
  const reference = rasterReference(page), width = Math.max(80, Math.round(targetWidth));
  const key = `${JSON.stringify(reference)}:${width}`;
  const cached = layerCache.get(key);
  if (cached) { layerCache.delete(key); layerCache.set(key, cached); return Promise.resolve(cached); }
  const pending = pendingLayers.get(key); if (pending) return pending;
  const generation = cacheGeneration;
  const request = backend<RenderedPageLayers>('render_page_layers', { page: reference, targetWidth: width }, thumbnail ? 0 : 1).then(value => {
    if (generation === cacheGeneration) {
      layerCache.set(key, value);
      const large = [...layerCache].filter(([, item]) => item.background.width > 220);
      if (large.length > 6) layerCache.delete(large[0][0]);
      while (layerCache.size > 140) layerCache.delete(layerCache.keys().next().value!);
    }
    return value;
  }).finally(() => { if (pendingLayers.get(key) === request) pendingLayers.delete(key); });
  pendingLayers.set(key, request); return request;
}

export function clearRenderCache() {
  cacheGeneration++;
  renderCache.clear();
  pendingRenders.clear();
  layerCache.clear(); pendingLayers.clear();
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
