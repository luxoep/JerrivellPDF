// SPDX-License-Identifier: MIT OR Apache-2.0
// Deterministic workload against production queue, cache, geometry and component.
// Only IPC/native pixels and browser scheduling are substituted; this is not an FPS claim.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { performance } from 'node:perf_hooks';
const root = new URL('../', import.meta.url);
const version = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).version;
async function load(path, require, globals = {}) {
  const exports = {}, source = await readFile(new URL(path, root), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require, console, Error, ...globals }, { filename: path });
  return exports;
}
const view = await load('src/viewerGeometry.ts', () => {});
const pages = Array.from({ length: 5000 }, (_, index) => ({ id: `page-${index}`, documentId: `pdf-${index % 32}`, pageIndex: Math.floor(index / 32), width: 595, height: 842, rotation: index % 3 === 0 ? 90 : 0, sourceName: `doc-${index % 32}.pdf` }));
const started = performance.now(), layout = view.buildThumbnailLayout(pages);
let accesses = 0;
const tracked = new Proxy(layout.rows, { get(target, key) { if (/^\d+$/.test(String(key))) accesses++; return target[key]; } });
const windowed = view.visibleRows(tracked, layout.rows[2500].top - 260, layout.rows[2500].top + 700 + 260);
assert.ok(windowed.length <= 12);
assert.ok(accesses < 60, 'Visible-range lookup must not scan 5000 pages per scroll');
const lookupMilliseconds = performance.now() - started;
let host;
const react = {
  useRef(initial) { const n = host.cursor++; return host.slots[n] ??= { current: initial }; },
  useState(initial) { const owner = host, n = owner.cursor++; if (!(n in owner.slots)) owner.slots[n] = typeof initial === 'function' ? initial() : initial; return [owner.slots[n], value => owner.slots[n] = typeof value === 'function' ? value(owner.slots[n]) : value]; },
  useMemo(calculate, deps) { const n = host.cursor++, old = host.slots[n]; if (!old || deps.some((value, i) => value !== old.deps[i])) host.slots[n] = { deps, value: calculate() }; return host.slots[n].value; },
  useEffect(effect, deps) { const owner = host, n = owner.cursor++, old = owner.slots[n]; if (!old || deps.some((value, i) => value !== old.deps[i])) { old?.cleanup?.(); owner.slots[n] = { deps }; owner.effects.push(() => owner.slots[n].cleanup = effect()); } },
};
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
const listeners = new Map(), frames = new Map(); let frameId = 0, resizeObservers = 0;
const thumbnails = await load('src/components/PageThumbnails.tsx', name => {
  if (name === 'react') return react; if (name === 'react/jsx-runtime') return jsx;
  if (name === '../viewerGeometry') return view;
  if (name === '../usePageLayers' || name === './LivePageImage') return {};
  if (name === '../i18n') return { useI18n: () => ({ t: (zh, en) => en ?? zh }) };
  if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) });
  throw new Error(name);
}, { window: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) },
  ResizeObserver: class { constructor() { resizeObservers++; } observe() {} disconnect() {} },
  requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: id => frames.delete(id) });
const state = { slots: [], cursor: 0, effects: [] }, surface = { scrollTop: 0, clientHeight: 700 };
const props = { pages, activeId: pages[0].id, selection: new Set(), busy: false, onSelect() {}, onToggle() {}, onReorder() {}, onAdd() {} };
function render() { host = state; host.cursor = 0; host.effects = []; const tree = thumbnails.PageThumbnails(props); tree.props.ref.current = surface; for (const effect of host.effects) effect(); return tree; }
let tree = render(); tree = render();
const cardNodes = tree => tree.props.children[0].props.children[0];
const initialMounted = cardNodes(tree).length;
assert.ok(initialMounted <= 12);
surface.scrollTop = layout.rows[2500].top; tree.props.onScroll();
for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
tree = render(); const middleMounted = cardNodes(tree).length;
assert.ok(middleMounted <= 12 && cardNodes(tree).some(node => node.props.page.id === pages[2500].id));
props.activeId = pages[4999].id; tree = render(); tree = render();
assert.ok(cardNodes(tree).some(node => node.props.page.id === pages[4999].id), 'Navigation must mount an initially offscreen thumbnail');
assert.equal(resizeObservers, 1, 'The sidebar has one resize observer, not one observer per page');

const calls = [], edge = new EventTarget(), flush = () => new Promise(resolve => setImmediate(resolve));
const backend = await load('src/backend.ts', name => { assert.equal(name, '@tauri-apps/api/core'); return { invoke(command, args) { return new Promise((resolve, reject) => calls.push({ command, args, resolve, reject })); } }; }, { window: edge, CustomEvent });
const image = { width: 1800, height: 2400, dataUrl: 'data:image/png;base64,synthetic' }, layers = { background: image, foreground: [{ image, blendMode: 'normal' }] };
const gate = backend.backend('hold-native', {}, 3); const hold = calls.shift();
const leases = Array.from({ length: 200 }, () => ({ cancelled: false }));
const jobs = leases.map((lease, index) => backend.renderPageLayers(pages[index], 154, true, lease).then(() => 'rendered', error => { assert.equal(error.message, backend.cancelledRequest); return 'cancelled'; }));
for (const lease of leases.slice(0, 195)) lease.cancelled = true;
const sharedLease = { cancelled: false };
// A visible reader joins the final queued thumbnail: promote it, keep it alive.
const promoted = backend.renderPageLayers(pages[199], 154, false, sharedLease);
leases[199].cancelled = true;
const save = backend.backend('save-foreground', {}, 3);
hold.resolve(null); await gate; await flush();
assert.equal(calls[0].command, 'save-foreground'); calls.shift().resolve(null); await save; await flush();
assert.equal(calls[0].args.page.pageIndex, pages[199].pageIndex, 'Visible shared render overtakes low-priority thumbnails');
assert.equal(calls[0].args.page.documentId, pages[199].documentId);
let nativeCalls = 0;
while (calls.length) { calls.shift().resolve(layers); nativeCalls++; await flush(); }
const statuses = await Promise.all(jobs); await promoted;
assert.equal(statuses.filter(value => value === 'rendered').length, 5);
assert.equal(nativeCalls, 5);
assert.equal(backend.renderDiagnostics().skippedRenders, 195);

backend.clearRenderCache();
for (let index = 0; index < 32; index++) {
  const request = backend.renderPageLayers(pages[index], 1800);
  assert.equal(calls.length, 1); calls.shift().resolve(layers); await request; await flush();
  assert.ok(backend.renderDiagnostics().estimatedCacheBytes <= backend.renderDiagnostics().cacheLimitBytes);
}
const cache = backend.renderDiagnostics(); assert.ok(cache.cacheEntries <= 3);
backend.clearRenderCache();
const widths = Array.from({ length: 64 }, (_, n) => 800 + n), quantized = new Set(widths.map(width => view.rasterTargetWidth(width, 1)));
let zoomNativeCalls = 0;
for (const width of widths) {
  const promise = backend.renderPageLayers(pages[0], view.rasterTargetWidth(width, 1));
  if (calls.length) { calls.shift().resolve({ background: { ...image, width: 850, height: 1200 }, foreground: [] }); zoomNativeCalls++; }
  await promise; await flush();
}
assert.equal(quantized.size, 2); assert.equal(zoomNativeCalls, 2);
for (const paper of [{width:595,height:842,rotation:0},{width:842,height:595,rotation:0},{width:595,height:842,rotation:90},{width:100,height:4000,rotation:0}]) {
  const size=view.visiblePageSize(paper),target=view.rasterTargetWidth(9999,4,paper),height=Math.round(target*size.height/size.width);
  assert.ok(target<=8192 && height<=8192 && target*height<=view.READER_PIXEL_BUDGET,'High-DPI targets obey both native side and decoded pixel budgets');
}
assert.ok(view.rasterTargetWidth(1600,2,{width:595,height:842,rotation:0})>=3200,'Zoom must obtain native detail beyond the previous 2400px ceiling');
assert.ok(view.rasterTargetWidth(1200,3,{width:595,height:842,rotation:0})>=3600,'A 3x display is not reduced to 1.5x');
assert.ok(view.rasterTargetWidth(1000,1)>=2000,'Initial reading supersamples small vector text');
backend.clearRenderCache(); assert.equal(backend.renderDiagnostics().estimatedCacheBytes, 0);

const objectLayers = { lower: image, moving: image, upper: image, foreground: [] };
for (let index = 0; index < 32; index++) {
  const promise = backend.renderObjectLayers(pages[index], index, `object-${index}`);
  calls.shift().resolve(objectLayers); await promise; await flush();
  assert.ok(backend.renderDiagnostics().estimatedCacheBytes <= cache.cacheLimitBytes);
}
const objectCache = backend.renderDiagnostics();
assert.equal(objectCache.cacheEntries, 1, 'Multiple RGBA object layers must count towards the same memory budget');
backend.clearRenderCache();
const timers = new Map(); let timer = 0;
const objectModule = await load('src/components/OriginalObjectPreview.tsx', name => {
  if (name === 'react') return react; if (name === 'react/jsx-runtime') return jsx;
  if (name === '../backend') return backend; if (name === './LivePageImage') return { LivePageImage: 'LivePageImage' };
  if (name === '../i18n') return { useI18n: () => ({ t: (zh, en) => en ?? zh }) };
  throw new Error(name);
}, { window: { setTimeout: callback => { timers.set(++timer, callback); return timer; }, clearTimeout: id => timers.delete(id) }, Image: class { async decode() {} } });
const objectState = { slots: [], cursor: 0, effects: [] }, bounds = { x: .1, y: .1, width: .3, height: .1 };
const objectProps = { page: pages[0], object: { objectIndex: 0, fingerprint: 'hover-0', editable: true, deleted: false, bounds }, bounds, visible: false };
function renderObject() { host = objectState; host.cursor = 0; host.effects = []; const tree = objectModule.OriginalObjectPreview(objectProps); for (const effect of host.effects) effect(); return tree; }
function runTimers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } }
const holdObjects = backend.backend('hold-object-native', {}, 3), blockedObject = calls.shift();
const skippedBeforeHover = backend.renderDiagnostics().skippedRenders;
for (let index = 0; index < 40; index++) { objectProps.object = { ...objectProps.object, objectIndex: index, fingerprint: `hover-${index}` }; renderObject(); runTimers(); }
objectProps.visible = true; renderObject(); runTimers();
for (let index = 0; index < 20; index++) { objectProps.bounds = { ...bounds, x: .1 + index / 100 }; renderObject(); runTimers(); }
blockedObject.resolve(null); await holdObjects; await flush();
assert.equal(calls.length, 1); assert.equal(calls[0].command, 'render_object_layers'); assert.equal(calls[0].args.objectIndex, 39);
calls.shift().resolve(objectLayers); await flush(); await flush();
assert.equal(renderObject().props.className, 'oc-live-preview');
assert.equal(backend.renderDiagnostics().skippedRenders - skippedBeforeHover, 39);
assert.equal(calls.length, 0, 'Hover-to-drag preparation and 20 moves use one native response');
objectProps.page = pages[1]; assert.equal(renderObject(), null, 'Another source must not display prior object layers');
for (const slot of objectState.slots) slot?.cleanup?.();
backend.clearRenderCache();
for (const slot of state.slots) slot?.cleanup?.();
const report = { status: 'PASS', version, method: 'Production TypeScript queue/cache/geometry/components with synthetic IPC pixels and controlled browser scheduling; counts are deterministic, not measured desktop FPS', workload: { documents: 32, pages: 5000 },
  thumbnails: { priorMountedCards: 5000, initialMountedCards: initialMounted, middleMountedCards: middleMounted, perPageIntersectionObservers: 0, sidebarResizeObservers: resizeObservers, indexedRowAccesses: accesses, visibleRows: windowed.length },
  rapidNavigation: { queuedRenderRequests: 200, obsoleteRequestsSkippedBeforeIpc: 195, nativeRenderCalls: nativeCalls, sharedVisibleConsumerPreserved: true, foregroundSavePrioritized: true },
  rasterCache: { budgetBytes: cache.cacheLimitBytes, retainedEstimatedBytes: cache.estimatedCacheBytes, retainedEntriesAfter32Documents: cache.cacheEntries, clearedOnReset: true, estimateIncludes: 'RGBA decoded pixel estimate + UTF-16 data URL; current mounted views, native worker and GPU memory are additional' },
  zoom: { cssWidthUpdates: 64, priorDistinctRasterWidthKeys: 64, quantizedRasterWidthKeys: quantized.size, actualMockedIpcCalls: zoomNativeCalls, exactCssLayoutRetained: true },
  objectHover: { queuedTargets: 40, obsoleteTargetsSkippedBeforeIpc: 39, dragMoves: 20, actualMockedIpcCalls: 1, sourceIsolation: true, estimatedBytesAfter32CachedObjectPreviews: objectCache.estimatedCacheBytes, retainedObjectEntries: objectCache.cacheEntries, budgetSharedWithPageRasters: true },
  informationalTiming: { thumbnailLayoutAndLookupMilliseconds: Number(lookupMilliseconds.toFixed(3)), environment: process.version },
};
await mkdir(new URL(`test-results/${version}/`, root), { recursive: true });
await writeFile(new URL(`test-results/${version}/performance.json`, root), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
