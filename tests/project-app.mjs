// SPDX-License-Identifier: MIT OR Apache-2.0
// Exercise the real App callbacks with deterministic React/native boundaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const tick = () => new Promise(resolve => setImmediate(resolve));
const compile = (path, jsx = false) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}) },
}).outputText;
const app = compile('../src/App.tsx', true) + '\nexports.TestWorkspace = AppWorkspace;';
const clone = value => JSON.parse(JSON.stringify(value));
function walk(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) { for (const child of node) walk(child, predicate, found); return found; }
  if (predicate(node)) found.push(node);
  walk(node.props?.children, predicate, found); return found;
}
function label(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  return Array.isArray(node) ? node.map(label).join('') : label(node.props?.children);
}
const changed = (before, after) => !before || before.length !== after.length || after.some((value, n) => !Object.is(value, before[n]));
async function fixture({ prepare } = {}) {
  const slots = [], effects = [], listeners = new Map(), calls = [], timers = new Map(), dialogs = [], events = [], cachedImages = new Map();
  let cursor = 0, pending = [], needsRender = true, tree, nextId = 0, timerId = 0, resets = 0;
  let pickerPaths = ['C:\\input.pdf'], savePath = 'C:\\draft.jvp', saveFailure, loadFailure, closeListener;
  const staged = [];
  const source = { id: 'native-document', path: 'C:\\input.pdf', fileName: 'input.pdf', fileSize: 12000, pageCount: 2, warnings: [],
    pages: [{ index: 0, width: 595, height: 842, rotation: 0 }, { index: 1, width: 595, height: 842, rotation: 0 }] };
  const project = { title: 'Restored project', documents: [{ id: 'restored-source', path: 'memory://restored/source.pdf', fileName: 'source.pdf', fileSize: 3000,
    pageCount: 1, warnings: [], pages: [{ index: 0, width: 595, height: 842, rotation: 0 }] }],
    assets: [{ id: 'restored-image', width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }],
    workspace: [{ id: 'restored-page', documentId: 'restored-source', pageIndex: 0, rotation: 0, width: 595, height: 842, sourceName: 'source.pdf',
      overlays: [{ id: 'restored-text', assetId: 'restored-image', x: .1, y: .2, width: .3, height: .1, opacity: 1,
        textSource: { content: 'Jerry 可编辑文字', color: '#243746', fontSize: 12, bold: false, fontFamily: 'Arial', frame: { width: 120, height: 40, autoHeight: false } } }],
      contentEdits: [], decorations: [] }] };
  const setSlot = (n, value) => { const next = typeof value === 'function' ? value(slots[n]) : value; if (!Object.is(slots[n], next)) { slots[n] = next; needsRender = true; } };
  const react = {
    useState(initial) { const n = cursor++; if (!(n in slots)) slots[n] = typeof initial === 'function' ? initial() : initial; return [slots[n], value => setSlot(n, value)]; },
    useRef(initial) { const n = cursor++; return slots[n] ??= { current: initial }; },
    useMemo(factory, deps) { const n = cursor++; if (changed(slots[n]?.deps, deps)) slots[n] = { deps, value: factory() }; return slots[n].value; },
    useEffect(callback, deps) { const n = cursor++; if (changed(effects[n]?.deps, deps)) pending.push(() => { effects[n]?.cleanup?.(); effects[n] = { deps, cleanup: callback() }; }); },
  };
  react.useCallback = (callback, deps) => react.useMemo(() => callback, deps); react.useLayoutEffect = react.useEffect;
  class HTMLElement { tagName = 'DIV'; isContentEditable = false; closest() { return null; } }
  class HTMLInputElement extends HTMLElement { tagName = 'INPUT'; type = 'text'; }
  const window = { __TAURI_INTERNALS__: {},
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
  };
  const backend = {
    isDesktop: () => true, cancelledRequest: 'REQUEST_CANCELLED', sessionInvalidatedEvent: 'session-invalidated',
    pageReference: page => ({ documentId: page.documentId, pageIndex: page.pageIndex, rotation: page.rotation, ...(page.overlays?.length ? { overlays: page.overlays } : {}) }),
    resetBackendQueue() { resets++; events.push('reset'); cachedImages.clear(); },
    hydrateImageAssets(images) { events.push('hydrate'); for (const image of images) cachedImages.set(image.id, image); },
    stageImageAsset(dataUrl) {
      let resolve, reject;
      const registered = new Promise((done, fail) => { resolve = done; reject = fail; });
      const image = { id: `staged-${staged.length + 1}`, registered, dataUrl, resolve, reject };
      staged.push(image); return image;
    },
    errorMessage: error => String(error?.message ?? error),
    async backend(command, args) {
      calls.push({ command, args }); events.push(command);
      if (command === 'get_backend_status') return { engineReady: true };
      if (command === 'get_startup_files') return [];
      if (command === 'open_document') return source;
      if (command === 'close_all_documents') return;
      if (command === 'save_editable_project') { if (saveFailure) throw saveFailure; return { path: args.path, pageCount: args.pages.length }; }
      if (command === 'load_editable_project') { if (loadFailure) throw loadFailure; return clone(project); }
      throw new Error(`Unexpected native command: ${command}`);
    },
  };
  const nativeWindow = { async onCloseRequested(callback) { closeListener = callback; return () => { closeListener = null; }; }, async onDragDropEvent() { return () => {}; }, async destroy() {} };
  const i18n = { translate: (zh, en) => en ?? zh, useI18n: () => ({ language: 'en-US', setLanguage() {} }), I18nProvider: 'I18nProvider' };
  const modules = new Map();
  function require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name === './backend') return backend;
    if (name === './i18n') return i18n;
    if (name === './editableOverlays' && prepare) return { prepareEditableOverlays: prepare };
    if (name === '@tauri-apps/plugin-dialog') return {
      async open(options) { dialogs.push({ kind: 'open', options }); return pickerPaths; },
      async save(options) { dialogs.push({ kind: 'save', options }); return savePath; },
    };
    if (name === '@tauri-apps/api/webviewWindow') return { getCurrentWebviewWindow: () => nativeWindow };
    if (name === 'lucide-react' || name.startsWith('./components/')) return new Proxy({}, { get: (_, key) => String(key) });
    if (name.endsWith('.svg')) return 'own-project-icon.svg';
    const path = `${name.replace(/^\.\//, '')}.ts`;
    if (!modules.has(path)) {
      const exports = {}; vm.runInNewContext(compile(`../src/${path}`), { exports, require, console }); modules.set(path, exports);
    }
    return modules.get(path);
  }
  const exports = {};
  vm.runInNewContext(app, { exports, require, window, console, HTMLElement, HTMLInputElement, crypto: { randomUUID: () => `page-${++nextId}` }, Set, Map, Date });
  function render() { if (!needsRender) return tree; needsRender = false; cursor = 0; pending = []; tree = exports.TestWorkspace(); for (const effect of pending) effect(); return tree; }
  async function settle() { for (let n = 0; n < 14; n++) { render(); await tick(); if (!needsRender && n > 2) break; } render(); }
  const find = predicate => { render(); return walk(tree, predicate)[0]; };
  const component = name => find(node => node.type === name);
  const button = text => find(node => node.type === 'button' && (label(node) === text || node.props['aria-label'] === text));
  const pages = () => component('PdfViewer')?.props.pages ?? [];
  const isDirty = () => Boolean(find(node => node.props?.className === 'status-dot modified'));
  const counts = command => calls.filter(call => call.command === command).length;
  function key(value, shift = false) { render(); const event = { key: value, ctrlKey: true, metaKey: false, shiftKey: shift, target: new HTMLElement(), preventDefault() { this.prevented = true; } };
    for (const listener of [...listeners.get('keydown') ?? []]) listener(event); return event;
  }
  async function open(paths = [source.path]) { pickerPaths = paths; const opening = find(node => node.type === 'button' && node.props.className === 'rail-button rail-open'); opening.props.onClick(); await settle(); }
  async function edit() { const rotate = find(node => node.type === 'button' && node.props.title?.includes('旋转') && node.props.className?.includes('tool-button')); rotate.props.onClick(); await settle(); }
  async function overlayHandles() {
    const toggle = find(node => node.type === 'button' && node.props.className?.includes('content-edit-button'));
    if (!toggle.props['aria-pressed']) { toggle.props.onClick(); await settle(); }
    const viewer = component('PdfViewer');
    const controls = viewer.props.controls(viewer.props.pages[0], true, false, () => {});
    const handles = walk(controls, node => node.type === 'OverlayHandles')[0];
    assert.ok(handles, 'Production PdfViewer controls expose the added-content handles');
    return handles;
  }
  await settle();
  return { render, settle, button, component, pages, isDirty, counts, calls, dialogs, events, cachedImages, staged, key, open, edit, overlayHandles,
    get resets() { return resets; }, get project() { return project; },
    saveTo(path) { savePath = path; }, failSave(error) { saveFailure = error; }, failLoad(error) { loadFailure = error; },
    nativeClose() { const event = { preventDefault() { this.prevented = true; } }; closeListener(event); return event; },
    beforeUnload() { const event = { preventDefault() { this.prevented = true; } }; for (const listener of listeners.get('beforeunload') ?? []) listener(event); return event; },
    cleanup() { for (const effect of effects) effect?.cleanup?.(); },
  };
}

// A live inline draft is outside committed workspace history. The production
// controls callback must block window/document close and both save paths until
// the text editor reports that it has finished or cancelled the draft.
{
  const ui = await fixture(); await ui.open();
  const handles = await ui.overlayHandles(), snapshot = clone(ui.pages()), closes = ui.counts('close_all_documents');
  handles.props.onEditingChange(true);
  assert.equal(ui.nativeClose().prevented, true, 'Native window close must preserve an uncommitted inline draft');
  const unloading = ui.beforeUnload(); assert.equal(unloading.prevented, true); assert.equal(unloading.returnValue, '');
  ui.key('w'); ui.key('s', true); ui.key('s'); await ui.settle();
  assert.equal(ui.counts('close_all_documents'), closes); assert.equal(ui.counts('save_editable_project'), 0);
  assert.equal(ui.component('ExportDialog'), undefined, 'Uncommitted inline text cannot be exported as an old PDF snapshot');
  assert.equal(ui.dialogs.filter(dialog => dialog.kind === 'save').length, 0);
  assert.deepEqual(clone(ui.pages()), snapshot);
  handles.props.onEditingChange(false);
  assert.notEqual(ui.nativeClose().prevented, true, 'A clean committed workspace can close normally after inline editing ends');
  ui.key('s', true); await ui.settle(); assert.equal(ui.counts('save_editable_project'), 1);
  ui.key('s'); await ui.settle(); assert.ok(ui.component('ExportDialog'));
  ui.component('ExportDialog').props.onClose(); await ui.settle(); ui.cleanup();
}

// Text and its reattached leader are one staged transaction. If either native
// asset registration fails, remove the complete batch from current and copied
// pages and every undo/redo snapshot, including the asset that already succeeded.
{
  const text = { id: 'batch-text', assetId: '', x: .2, y: .2, width: .3, height: .1, opacity: 1,
    textSource: { content: 'Batch text', fontFamily: 'Arial', fontSize: 12, bold: false, color: '#243746', frame: { width: 120, height: 40, autoHeight: false } } };
  const leader = { id: 'batch-leader', assetId: '', x: .1, y: .1, width: .2, height: .2, opacity: 1, leaderFor: text.id,
    markSource: { color: '#243746', geometry: { tool: 'callout', points: [{ x: .12, y: .12 }, { x: .2, y: .25 }, { x: .21, y: .25 }],
      bounds: { x: .1, y: .1, width: .2, height: .2 }, pageWidth: 595, pageHeight: 842, lineWidth: 2, arrowHeads: 'start' } } };
  const ui = await fixture({ prepare: (_previous, requested) => ({ overlays: requested,
    images: [{ id: text.id, dataUrl: 'data:image/png;base64,TEXT' }, { id: leader.id, dataUrl: 'data:image/png;base64,LEADER' }] }) });
  await ui.open(); const handles = await ui.overlayHandles();
  handles.props.onChange([text, leader]); await ui.settle();
  assert.equal(ui.staged.length, 2); assert.equal(ui.pages()[0].overlays.length, 2);
  const ids = new Set(ui.staged.map(item => item.id));
  assert.ok(ui.pages()[0].overlays.every(item => ids.has(item.assetId)));
  ui.button('Duplicate pages').props.onClick(); await ui.settle();
  assert.equal(ui.pages().length, 3); assert.equal(ui.pages().filter(page => page.overlays?.some(item => ids.has(item.assetId))).length, 2);
  ui.staged[0].resolve({ id: 'native-success', dataUrl: 'data:image/png;base64,TEXT', width: 1, height: 1 }); await ui.settle();
  ui.staged[1].reject(new Error('Leader registration failed')); await ui.settle();
  const noFailedReferences = () => {
    for (const page of ui.pages()) {
      assert.ok(!(page.overlays ?? []).some(item => ids.has(item.assetId)), 'A failed staged batch cannot survive on the original or copied page');
      const parents = new Set((page.overlays ?? []).filter(item => item.textSource).map(item => item.id));
      assert.ok((page.overlays ?? []).every(item => !item.leaderFor || parents.has(item.leaderFor)), 'Rollback cannot leave a dangling text leader');
    }
  };
  noFailedReferences(); ui.key('z'); await ui.settle(); noFailedReferences(); ui.key('z'); await ui.settle(); noFailedReferences();
  ui.key('z', true); await ui.settle(); noFailedReferences(); ui.key('z', true); await ui.settle(); noFailedReferences();
  assert.equal(ui.pages().length, 3, 'Redo restores page organization while failed resources remain removed');
  ui.cleanup();
}

// Project saves and PDF exports have separate native/UI paths. Cancelled/failed
// project saves retain edits and the previous default save location.
{
  const ui = await fixture(); await ui.open(); await ui.edit(); assert.ok(ui.isDirty());
  const initial = clone(ui.pages());
  ui.saveTo(null); assert.equal(ui.key('s', true).prevented, true); await ui.settle();
  assert.equal(ui.counts('save_editable_project'), 0); assert.ok(ui.isDirty()); assert.equal(ui.component('ExportDialog'), undefined);
  ui.saveTo('C:\\draft.jvp'); ui.failSave(new Error('Project disk write failed'));
  ui.key('s', true); await ui.settle(); assert.equal(ui.counts('save_editable_project'), 1); assert.ok(ui.isDirty()); assert.deepEqual(clone(ui.pages()), initial);
  ui.failSave(null); ui.saveTo('C:\\Jerry\\finished.jvp'); ui.key('s', true); await ui.settle();
  assert.equal(ui.counts('save_editable_project'), 2); assert.equal(ui.isDirty(), false); assert.equal(ui.component('ExportDialog'), undefined);
  assert.deepEqual(clone(ui.calls.filter(call => call.command === 'save_editable_project').at(-1).args.pages), initial);
  await ui.edit(); assert.ok(ui.isDirty()); ui.key('s'); await ui.settle();
  const exporting = ui.component('ExportDialog'); assert.ok(exporting, 'Ctrl+S opens the PDF export review');
  assert.equal(ui.counts('save_editable_project'), 2); exporting.props.onClose(); await ui.settle(); assert.ok(ui.isDirty());
  ui.saveTo(null); ui.key('s', true); await ui.settle();
  assert.equal(ui.dialogs.filter(dialog => dialog.kind === 'save').at(-1).options.defaultPath, 'C:\\Jerry\\finished.jvp'); assert.ok(ui.isDirty());
  ui.cleanup();
}

// A rejected project does not close the worker, reset history, or clear images.
// A successful restore resets exactly once and hydrates the new images after it.
{
  const ui = await fixture(); await ui.open(); const snapshot = clone(ui.pages()), resets = ui.resets, closes = ui.counts('close_all_documents');
  ui.failLoad(new Error('PROJECT_INVALID: damaged PNG')); await ui.open(['C:\\portable.jvp']);
  assert.equal(ui.counts('load_editable_project'), 1); assert.equal(ui.resets, resets); assert.equal(ui.counts('close_all_documents'), closes);
  assert.deepEqual(clone(ui.pages()), snapshot); assert.equal(ui.isDirty(), false);
  ui.failLoad(null); await ui.open(['C:\\portable.jvp']);
  assert.equal(ui.resets, resets + 1); assert.equal(ui.counts('close_all_documents'), closes);
  assert.deepEqual(clone(ui.pages()), ui.project.workspace); assert.equal(ui.isDirty(), false);
  assert.equal(ui.cachedImages.get('restored-image').dataUrl, ui.project.assets[0].dataUrl);
  const loadIndex = ui.events.lastIndexOf('load_editable_project');
  assert.deepEqual(ui.events.slice(loadIndex, loadIndex + 3), ['load_editable_project', 'reset', 'hydrate']);
  const undo = ui.button('撤销'); assert.equal(undo.props.disabled, true, 'Restored project starts with a fresh history');
  await ui.edit(); assert.ok(ui.isDirty()); ui.key('z'); await ui.settle(); assert.deepEqual(clone(ui.pages()), ui.project.workspace); assert.equal(ui.isDirty(), false);
  ui.saveTo(null); ui.key('s', true); await ui.settle();
  assert.equal(ui.dialogs.filter(dialog => dialog.kind === 'save').at(-1).options.defaultPath, 'C:\\portable.jvp');
  const before = ui.counts('load_editable_project'), count = ui.resets;
  await ui.open(['C:\\portable.jvp', 'C:\\extra.pdf']); assert.equal(ui.counts('load_editable_project'), before); assert.equal(ui.resets, count);
  assert.deepEqual(clone(ui.pages()), ui.project.workspace);
  ui.cleanup();
}

// Dirty-workspace replacement requires a concrete choice. Cancelling the
// picker/write leaves the choice pending; successful project save precedes load.
{
  const ui = await fixture(); await ui.open(); await ui.edit(); const snapshot = clone(ui.pages()), before = ui.resets;
  await ui.open(['C:\\replacement.jvp']); assert.ok(ui.button('Save project and open')); assert.equal(ui.counts('load_editable_project'), 0);
  ui.button('返回文档').props.onClick(); await ui.settle(); assert.deepEqual(clone(ui.pages()), snapshot); assert.ok(ui.isDirty());
  await ui.open(['C:\\replacement.jvp']); ui.saveTo(null);
  ui.button('Save project and open').props.onClick(); await ui.settle();
  assert.ok(ui.button('Save project and open')); assert.equal(ui.counts('load_editable_project'), 0); assert.equal(ui.resets, before); assert.ok(ui.isDirty());
  ui.saveTo('C:\\before-replacement.jvp'); ui.failSave(new Error('Save failed'));
  ui.button('Save project and open').props.onClick(); await ui.settle(); assert.equal(ui.counts('load_editable_project'), 0); assert.ok(ui.button('Save project and open')); assert.ok(ui.isDirty());
  ui.failSave(null); ui.button('Save project and open').props.onClick(); await ui.settle();
  assert.equal(ui.counts('load_editable_project'), 1); assert.deepEqual(clone(ui.pages()), ui.project.workspace); assert.equal(ui.isDirty(), false);
  assert.ok(ui.events.lastIndexOf('save_editable_project') < ui.events.lastIndexOf('load_editable_project'));
  ui.cleanup();
}
console.log('Project App workflow: inline-draft close/save guards, staged text/leader batch rollback across copied pages and undo/redo, keyboard/export distinction, save cancellation/failure/location, atomic restore/cache hydration/history, mixed-file refusal and dirty replacement protection passed.');
