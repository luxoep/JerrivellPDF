import { invoke } from '@tauri-apps/api/core';
import type { PageRef, RenderedPage } from './types';

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
export function backend<T>(command: string, args?: Record<string, unknown>, priority = 2): Promise<T> {
  const generation = requestGeneration;
  return new Promise<T>((resolve, reject) => {
    queue.push({
      priority,
      run: async () => {
        if (generation !== requestGeneration) { reject(new Error(cancelledRequest)); return; }
        try {
          resolve(await invoke<T>(command, args));
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

const renderCache = new Map<string, RenderedPage>();
const pendingRenders = new Map<string, Promise<RenderedPage>>();
let cacheGeneration = 0;

export function pageReference(page: PageRef): PageRef {
  return { documentId: page.documentId, pageIndex: page.pageIndex, rotation: page.rotation,
    ...(page.contentEdits?.length ? { contentEdits: page.contentEdits.map(edit => ({ ...edit, ...(edit.bounds ? { bounds: { ...edit.bounds } } : {}) })) } : {}),
    ...(page.overlays?.length ? { overlays: page.overlays.map(({ locked: _locked, ...overlay }) => ({ ...overlay })) } : {}) };
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

export function clearRenderCache() {
  cacheGeneration++;
  renderCache.clear();
  pendingRenders.clear();
}

/** Cancel queued work from the old workspace before releasing its documents. */
export function resetBackendQueue() {
  requestGeneration++;
  clearRenderCache();
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '操作未完成，请重试。';
}
