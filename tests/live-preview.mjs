// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const flush = () => new Promise(resolve => setImmediate(resolve));
function load(file, globals) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {}; vm.runInNewContext(compiled, { exports, console, Error, ...globals }); return exports;
}
const calls = [], edge = new EventTarget(); edge.__TAURI_INTERNALS__ = {};
const backend = load('../src/backend.ts', {
  window: edge, CustomEvent,
  require(name) { assert.equal(name, '@tauri-apps/api/core'); return { invoke(command, args) { return new Promise((resolve, reject) => calls.push({ command, args, resolve, reject })); } }; },
});
const next = command => { const call = calls.shift(); assert.equal(call?.command, command); return call; };
const asset = { id: 'native-image', dataUrl: 'data:image/png;base64,normalized', width: 30, height: 20 };
const staged = backend.stageImageAsset('data:image/png;base64,generated');
assert.equal(backend.previewImageAsset(staged.id).dataUrl, 'data:image/png;base64,generated', 'A completed stroke appears synchronously');
const duplicate = backend.stageImageAsset('data:image/png;base64,generated'); assert.equal(duplicate.id, staged.id);
const page = { id: 'page', documentId: 'pdf', pageIndex: 0, rotation: 0, width: 600, height: 800,
  overlays: [{ id: 'mark', assetId: staged.id, x: .1, y: .2, width: .3, height: .1, opacity: .35, blendMode: 'multiply' }] };
const args = { parts: [{ name: 'immediate.pdf', pages: [backend.pageReference(page)] }] };
const immediateSave = backend.backend('prepare_export', args, 3);
args.parts[0].pages[0].overlays[0].x = .8;
const unrelated = backend.backend('unrelated', {}, 3);
assert.equal(calls.length, 1, 'The dependent save must wait outside IPC; registration is already running');
next('register_image').resolve(asset); await staged.registered; await flush();
next('unrelated').resolve('ok'); assert.equal(await unrelated, 'ok'); await flush();
const save = next('prepare_export'); assert.equal(save.args.parts[0].pages[0].overlays[0].assetId, asset.id);
assert.equal(save.args.parts[0].pages[0].overlays[0].x, .1, 'Waiting for registration preserves the exact export snapshot');
save.resolve('saved'); assert.equal(await immediateSave, 'saved'); await flush();

const layers = { background: { dataUrl: 'data:image/png;base64,base', width: 800, height: 1067 }, foreground: [{ image: { dataUrl: 'data:image/png;base64,foreground', width: 800, height: 1067 }, blendMode: 'normal' }] };
const first = backend.renderPageLayers(page, 800); const call = next('render_page_layers');
assert.equal(call.args.page.overlays, undefined, 'The native raster never receives mark geometry'); call.resolve(layers); await first; await flush();
for (let i = 0; i < 20; i++) {
  const changed = { ...page, overlays: i === 19 ? [] : [{ ...page.overlays[0], x: i / 25, opacity: i / 25 }] };
  assert.equal(await backend.renderPageLayers(changed, 800), layers);
}
assert.equal(calls.length, 0, 'Drawing/moving/opacity/removal/undo can reuse the same PDF pixels');
const decorated = backend.renderPageLayers({ ...page, decorations: [{ id: 'number', text: '1' }] }, 800);
next('render_page_layers').resolve(layers); await decorated; await flush();
const imported = backend.backend('import_image', { path: 'sample.png' }); next('import_image').resolve({ ...asset, id: 'imported' }); await imported;
assert.equal(backend.previewImageAsset('imported').width, 30);
for (const command of ['register_image','import_image','import_pdf_stamp','edit_image_asset','extract_content_image','get_image_asset','rasterize_page_asset']) {
  const id=`contract-${command}`;
  const response=backend.backend(command,{});
  next(command).resolve({...asset,id,...(command==='import_pdf_stamp'?{pageCount:3}:{})});
  const actual=await response;assert.equal(actual.id,id);assert.ok(backend.previewImageAsset(id),`${command} must populate live display`);
  if(command==='import_pdf_stamp')assert.equal(actual.pageCount,3);
  const invalid=assert.rejects(backend.backend(command,{}),/BACKEND_RESPONSE_INVALID/);
  next(command).resolve({image:{...asset,id:`wrong-${id}`},pageCount:3});await invalid;
  assert.equal(backend.previewImageAsset(`wrong-${id}`),undefined,'An invalid nested response must fail visibly, not create an invisible placement');
}
const thumbnail=backend.backend('preview_image');next('preview_image').resolve({dataUrl:asset.dataUrl,width:1200,height:800,thumbnailWidth:600,thumbnailHeight:400});await thumbnail;
const badThumbnail=assert.rejects(backend.backend('preview_image'),/BACKEND_RESPONSE_INVALID/);next('preview_image').resolve({image:asset});await badThumbnail;
const repairPreview=backend.backend('preview_image_edit');next('preview_image_edit').resolve({dataUrl:asset.dataUrl,width:30,height:20});await repairPreview;
for(const response of [{image:asset},{dataUrl:'wrong',width:30,height:20},{dataUrl:asset.dataUrl,width:NaN,height:20}]) {
  const invalidRepair=assert.rejects(backend.backend('preview_image_edit'),/BACKEND_RESPONSE_INVALID/);next('preview_image_edit').resolve(response);await invalidRepair;
}
const future=backend.backend('future_asset_producer');next('future_asset_producer').resolve({...asset,id:'future'});await future;
assert.ok(backend.previewImageAsset('future'),'Valid asset-shaped responses are recognized without a command-specific cache branch');
const failedStage = backend.stageImageAsset('data:image/png;base64,will-fail');
const failed = assert.rejects(failedStage.registered, /image budget/);
const blocked = assert.rejects(backend.backend('save_document', { pages: [{ ...page, overlays: [{ ...page.overlays[0], assetId: failedStage.id }] }] }), /image budget/);
next('register_image').reject('image budget'); await failed; await blocked; await flush(); assert.equal(calls.length, 0);
assert.equal(backend.previewImageAsset(failedStage.id), undefined);

const pending = backend.stageImageAsset('data:image/png;base64,old-session');
const stale = assert.rejects(pending.registered, /REQUEST_CANCELLED/);
const waiting = assert.rejects(backend.backend('export_image', { assetId: pending.id }), /REQUEST_CANCELLED/);
backend.resetBackendQueue(); next('register_image').resolve(asset); await stale; await waiting; await flush();
assert.equal(backend.previewImageAsset(staged.id), undefined); assert.equal(calls.length, 0);

// Exercise actual raster hook: ordinary edits retain only a disabled stale
// preview; new pages clear it, overlay-only changes start no request or timer.
let host; const timers = new Map(); let timer = 0, pendingDecode;
const react = {
  useRef(initial) { const current=host,index=current.cursor++; return current.slots[index] ??= {current:initial}; },
  useState(initial) { const current = host, index = current.cursor++; if (!(index in current.slots)) current.slots[index] = typeof initial === 'function' ? initial() : initial; return [current.slots[index], value => current.slots[index] = typeof value === 'function' ? value(current.slots[index]) : value]; },
  useEffect(effect, deps) { const current = host, index = current.cursor++, old = current.slots[index]; if (!old || deps.some((value, i) => value !== old.deps[i])) { old?.cleanup?.(); current.slots[index] = { deps }; current.effects.push(() => current.slots[index].cleanup = effect()); } },
};
const hook = load('../src/usePageLayers.ts', {
  require(name) { if (name === 'react') return react; if (name === './backend') return backend; throw new Error(name); },
  window: { setTimeout(callback) { timers.set(++timer, callback); return timer; }, clearTimeout(id) { timers.delete(id); } },
  Image: class { async decode() { if (pendingDecode) await pendingDecode; } },
});
const state = { cursor: 0, slots: [], effects: [] }; let currentPage = { ...page, overlays: [] }, width = 800;
function render() { host = state; host.cursor = 0; host.effects = []; const value = hook.usePageLayers(currentPage, width, true); for (const effect of host.effects) effect(); return value; }
function runTimers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } }
let result = render(); assert.equal(result.layers, null); runTimers(); next('render_page_layers').resolve(layers); await flush(); await flush(); result = render(); assert.equal(result.layers, layers);
currentPage = { ...currentPage, overlays: page.overlays }; result = render(); assert.equal(timers.size, 0); assert.equal(result.loading, false); assert.equal(result.layers, layers);
let decodeReady; pendingDecode = new Promise(resolve => decodeReady = resolve);
width = 1000; result = render(); runTimers(); next('render_page_layers').resolve({ ...layers, background: { ...layers.background, width: 1000 } }); await flush();
result = render(); assert.equal(result.layers, layers, 'Old resolution stays visible until the new PNG is decoded'); assert.equal(result.loading, false);
decodeReady(); pendingDecode = null; await flush(); result = render(); assert.equal(result.layers.background.width, 1000);
currentPage = { ...currentPage, contentEdits: [{ objectIndex: 1, fingerprint: 'old', text: 'new' }] }; result = render(); assert.ok(result.layers); assert.equal(result.loading, true, 'Stale native text is never editable');
runTimers(); next('render_page_layers').reject('preview failed'); await flush(); result = render(); assert.equal(result.error, 'preview failed'); assert.ok(result.layers);
currentPage = { ...currentPage, pageIndex: 1 }; result = render(); assert.equal(result.layers, null, 'Changing pages must never display another source page');
// A new viewer for a copied page reuses an already decoded identical raster.
const cloneTimers=timers.size;const cloneState={cursor:0,slots:[],effects:[]};host=cloneState;
const clone=hook.usePageLayers({...page,id:'copied-page'},1000,true);
for(const effect of cloneState.effects)effect();
assert.ok(clone.layers);assert.equal(clone.loading,false);assert.equal(timers.size,cloneTimers,'A copied page does not flash a loading placeholder or schedule another raster');
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const geometry = load('../src/viewerGeometry.ts', {});
const live = load('../src/components/LivePageImage.tsx', { require(name) {
  if (name === 'react') return react;
  if (name === '../textFrame') return {};
  if (name === './overlayCanvas') return {};
  if (name === './MarkLayer') return {};
  if (name === '../editableOverlays') return load('../src/editableOverlays.ts', { require(name) {
    if (name === './markGeometry') return load('../src/markGeometry.ts', {});
    if (name === './textFrame') return {};
    throw new Error(name);
  } });
  if (name === 'react/jsx-runtime') return jsx;
  if (name === '../backend') return { previewImageAsset: () => asset };
  if (name === '../viewerGeometry') return geometry;
  throw new Error(name);
} });
const visual = live.LivePageImage({ page: { ...page, overlays: [{ ...page.overlays[0], rotation: 90 }, { ...page.overlays[0], id: 'second', rotation: 0 }] }, layers, label: 'Page', placement: { ...page.overlays[0], x: .4, rotation: 90 } });
const nodes = visual.props.children;
assert.equal(nodes[0].props['data-pdf-background'], true);
assert.equal(nodes[1][0].props.transform, 'translate(330 200) rotate(90)');
assert.equal(nodes[1][0].props.width, 80); assert.equal(nodes[1][0].props.height, 180);
assert.equal(nodes[1][0].props.style.mixBlendMode, 'multiply');
assert.equal(nodes[1][1].props['data-live-overlay'], 'second');
assert.equal(nodes[2][0].props['data-pdf-foreground'], 0, 'Native decorations/annotations stay above all marks');
const handles = load('../src/components/OverlayHandles.tsx', { require(name) {
  if (name === 'react') return react;
  if (name === 'react/jsx-runtime') return jsx;
  if (name === '../i18n') return {useI18n:()=>({t:(zh,en)=>en??zh})};
  if (name === '../overlayGeometry') return load('../src/overlayGeometry.ts',{});
  if (name === '../placementGeometry') return load('../src/placementGeometry.ts',{});
  if (name === '../textFrame') return {};
  if (name.endsWith('.css')) return {};
  throw new Error(name);
}, requestAnimationFrame(callback) { callback(); return 1; }, cancelAnimationFrame() {} });
const handleHost={cursor:0,slots:[],effects:[]}, changes=[], previews=[];
const surface={getBoundingClientRect:()=>({width:600,height:800}),focus(){},setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}};
const handleProps={overlays:page.overlays,onChange:value=>changes.push(value),onPreview:value=>previews.push(value),pageWidth:600,pageHeight:800};
const pointer=(x,y)=>({button:0,pointerId:1,clientX:x,clientY:y,currentTarget:surface,preventDefault(){},stopPropagation(){}});
function renderHandle(){host=handleHost;host.cursor=0;host.effects=[];const tree=handles.OverlayHandles(handleProps);tree.props.ref.current=surface;return tree.props.children[0];}
let handle=renderHandle();handle.props.onPointerDown(pointer(100,100));handle=renderHandle();handle.props.onPointerMove(pointer(160,180));
assert.ok(Math.abs(previews.at(-1).x-.2)<1e-10);assert.ok(Math.abs(previews.at(-1).y-.3)<1e-10);assert.equal(changes.length,0,'Live drag does not create history on every move');
handle=renderHandle();handle.props.onPointerUp(pointer(160,180));assert.equal(changes.length,1);assert.equal(previews.at(-1),null);
handle=renderHandle();handle.props.onPointerDown(pointer(100,100));handle.props.onPointerMove(pointer(200,200));handle=renderHandle();handle.props.onPointerCancel(pointer(200,200));
assert.equal(changes.length,1);assert.equal(previews.at(-1),null,'Cancelled placement removes the transient image transform');
console.log('PASS: immediate mark assets, deduplicated registration, nonblocking/deadlock-free save snapshot resolution, failure/session safety, zero PDF rerenders for 20 overlay changes, decoded raster swaps and stale/page isolation');
