// SPDX-License-Identifier: MIT OR Apache-2.0
// Execute the production AppWorkspace with deterministic React hooks and native
// boundaries. Button/keyboard/export callbacks are the ones rendered by App.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText + '\nexports.TestWorkspace = AppWorkspace;';
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
async function fixture() {
  const slots = [], effects = [], listeners = new Map(), calls = [], timers = new Map();
  let cursor = 0, pending = [], dirty = true, tree, nextId = 0, timerId = 0;
  let closeListener, destroyed = 0, resetCount = 0, nativeDocuments = 0, closeFailure = null, closeDeferred = null;
  const setSlot = (n, value) => { const next = typeof value === 'function' ? value(slots[n]) : value; if (!Object.is(slots[n], next)) { slots[n] = next; dirty = true; } };
  const react = {
    useState(initial) { const n = cursor++; if (!(n in slots)) slots[n] = typeof initial === 'function' ? initial() : initial; return [slots[n], value => setSlot(n, value)]; },
    useRef(initial) { const n = cursor++; return slots[n] ??= { current: initial }; },
    useMemo(factory, deps) { const n = cursor++; if (changed(slots[n]?.deps, deps)) slots[n] = { deps, value: factory() }; return slots[n].value; },
    useCallback(callback, deps) { return this.useMemo(() => callback, deps); },
    useEffect(callback, deps) { const n = cursor++; if (changed(effects[n]?.deps, deps)) pending.push(() => { effects[n]?.cleanup?.(); effects[n] = { deps, cleanup: callback() }; }); },
  };
  // Named imports call this without the object receiver.
  react.useCallback = (callback, deps) => react.useMemo(() => callback, deps);
  react.useLayoutEffect = react.useEffect;
  class HTMLElement { tagName = 'DIV'; isContentEditable = false; closest() { return null; } }
  class HTMLInputElement extends HTMLElement { tagName = 'INPUT'; type = 'text'; }
  const window = {
    __TAURI_INTERNALS__: {},
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const document = { id: 'native-document', path: 'C:\\input.pdf', fileName: 'input.pdf', fileSize: 12000,
    pageCount: 2, warnings: [], pages: [{ index: 0, width: 595, height: 842 }, { index: 1, width: 595, height: 842 }] };
  const backend = {
    isDesktop: () => true, cancelledRequest: 'REQUEST_CANCELLED', sessionInvalidatedEvent: 'session-invalidated',
    pageReference: page => ({ documentId: page.documentId, pageIndex: page.pageIndex, rotation: page.rotation, ...(page.overlays?.length ? { overlays: page.overlays } : {}) }),
    resetBackendQueue() { resetCount++; }, errorMessage: error => String(error?.message ?? error),
    async backend(command, args) {
      calls.push({ command, args });
      if (command === 'get_backend_status') return { engineReady: true };
      if (command === 'get_startup_files') return [];
      if (command === 'open_document') { nativeDocuments++; return document; }
      if (command === 'close_all_documents') {
        if (closeFailure) throw closeFailure;
        if (closeDeferred) await closeDeferred.promise;
        nativeDocuments = 0; return;
      }
      throw new Error(`Unexpected native operation: ${command}`);
    },
  };
  const nativeWindow = {
    async onCloseRequested(callback) { closeListener = callback; return () => { closeListener = null; }; },
    async onDragDropEvent() { return () => {}; },
    async destroy() { destroyed++; },
  };
  const i18n = { translate: (zh, en) => en ?? zh, useI18n: () => ({ language: 'en-US', setLanguage() {} }), I18nProvider: 'I18nProvider' };
  const modules = new Map();
  function require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name === './backend') return backend;
    if (name === './i18n') return i18n;
    if (name === '@tauri-apps/plugin-dialog') return { open: async () => [document.path] };
    if (name === '@tauri-apps/api/webviewWindow') return { getCurrentWebviewWindow: () => nativeWindow };
    if (name === 'lucide-react' || name.startsWith('./components/')) return new Proxy({}, { get: (_, key) => String(key) });
    if (name.endsWith('.svg')) return 'own-project-icon.svg';
    const path = `${name.replace(/^\.\//, '')}.ts`;
    if (!modules.has(path)) {
      const exports = {};
      vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText, { exports, require, console });
      modules.set(path, exports);
    }
    return modules.get(path);
  }
  const exports = {};
  vm.runInNewContext(compiled, { exports, require, window, console, HTMLElement, HTMLInputElement,
    crypto: { randomUUID: () => `workspace-page-${++nextId}` }, Set, Map, Date });
  const render = () => {
    if (!dirty) return tree;
    dirty = false; cursor = 0; pending = [];
    tree = exports.TestWorkspace(); for (const effect of pending) effect(); return tree;
  };
  async function settle() { for (let n = 0; n < 12; n++) { render(); await tick(); if (!dirty && n > 2) break; } render(); }
  const find = predicate => { render(); return walk(tree, predicate)[0]; };
  const component = name => find(node => node.type === name);
  const button = text => find(node => node.type === 'button' && label(node) === text);
  const closeButton = () => find(node => node.type === 'button' && node.props.className?.includes('close-document-button'));
  const pageCount = () => component('PdfViewer')?.props.pages.length ?? 0;
  const event = (key = 'w') => ({ key, ctrlKey: true, metaKey: false, shiftKey: false, target: new HTMLElement(), preventDefault() { this.prevented = true; } });
  const key = (value = 'w') => { render(); const current = event(value); for (const listener of [...listeners.get('keydown') ?? []]) listener(current); return current; };
  const counts = command => calls.filter(call => call.command === command).length;
  await settle();
  return { render, settle, button, closeButton, component, key, pageCount, counts, calls,
    get destroyed() { return destroyed; }, get resets() { return resetCount; }, get nativeDocuments() { return nativeDocuments; },
    failClose(error) { closeFailure = error; },
    deferClose() { let resolve; closeDeferred = { promise: new Promise(done => resolve = done) }; return () => { resolve(); closeDeferred = null; }; },
    nativeClose() { const value = event(); closeListener(value); return value; },
    async open() { const opening = find(node => node.type === 'button' && node.props.className === 'rail-button rail-open'); await opening.props.onClick(); await settle(); assert.equal(pageCount(), 2); },
    async edit() { const rotate = find(node => node.type === 'button' && node.props.onClick && node.props.title?.includes('旋转') && node.props.className?.includes('tool-button')); rotate.props.onClick(); await settle(); },
    cleanup() { for (const effect of effects) effect?.cleanup?.(); },
  };
}

// A clean document closes once, releases handles and resets the workspace. A
// second Ctrl+W while native release is pending cannot race that operation.
{
  const ui = await fixture(); await ui.open();
  const before = ui.counts('close_all_documents'), resets = ui.resets;
  const release = ui.deferClose();
  assert.equal(ui.key().prevented, true); assert.equal(ui.key().prevented, true);
  await ui.settle(); assert.equal(ui.counts('close_all_documents'), before + 1);
  assert.equal(ui.pageCount(), 2, 'The workspace stays mounted until native release succeeds');
  assert.equal(ui.nativeClose().prevented, true, 'Window closing waits for native PDF release');
  release(); await ui.settle();
  assert.equal(ui.pageCount(), 0); assert.equal(ui.nativeDocuments, 0);
  assert.equal(ui.resets, resets + 1); assert.equal(ui.destroyed, 0);
  assert.equal(ui.key().prevented, true, 'Ctrl+W with no document still suppresses WebView close');
  await ui.open(); assert.equal(ui.counts('open_document'), 2, 'The source registry is cleared when closing');
  ui.cleanup();
}

// Dirty documents offer all three choices. Cancelling or failing save preserves
// the loaded PDF; only a successful export is allowed to close it.
{
  const ui = await fixture(); await ui.open(); await ui.edit();
  const before = ui.counts('close_all_documents');
  ui.closeButton().props.onClick(); await ui.settle();
  assert.ok(ui.button('Save copy and close'));
  ui.button('Keep editing').props.onClick(); await ui.settle();
  assert.equal(ui.pageCount(), 2); assert.equal(ui.counts('close_all_documents'), before);
  ui.key(); await ui.settle();
  const saving = ui.button('Save copy and close').props.onClick(); await ui.settle();
  let exportDialog = ui.component('ExportDialog'); assert.ok(exportDialog);
  assert.equal(ui.button('Save copy and close'), undefined, 'Export replaces the close confirmation instead of stacking dialogs over the PDF preview');
  exportDialog.props.onSaved({ failed: 1, succeeded: 0, results: [] }); await ui.settle();
  assert.equal(ui.pageCount(), 2); assert.equal(ui.counts('close_all_documents'), before);
  exportDialog.props.onClose(); await saving; await ui.settle();
  assert.equal(ui.pageCount(), 2); assert.equal(ui.destroyed, 0);
  assert.equal(ui.button('Save copy and close'), undefined);
  ui.key(); await ui.settle();
  const successfulSave = ui.button('Save copy and close').props.onClick(); await ui.settle();
  exportDialog = ui.component('ExportDialog');
  exportDialog.props.onBusyChange(true); await ui.settle();
  assert.equal(ui.key().prevented, true); assert.equal(ui.counts('close_all_documents'), before);
  const releaseSavedClose = ui.deferClose();
  exportDialog.props.onSaved({ failed: 0, succeeded: 1, results: [{ path: 'C:\\output.pdf' }] });
  // Match ExportDialog.write(): notify onSaved, then release busy in its
  // synchronous finally before the save-copy Promise continuation can run.
  exportDialog.props.onBusyChange(false);
  await ui.settle();
  assert.equal(ui.button('Save copy and close'), undefined, 'The confirmation must not flash back while releasing the saved PDF');
  assert.equal(ui.pageCount(), 2, 'Keep the saved workspace mounted until native release completes');
  releaseSavedClose();
  await successfulSave; await ui.settle();
  assert.equal(ui.pageCount(), 0); assert.equal(ui.counts('close_all_documents'), before + 1); assert.equal(ui.destroyed, 0);
  ui.cleanup();
}

// Native close failure must not clear history or caches. Retry can discard the
// dirty workspace explicitly, and Ctrl+W in the print dialog stays local.
{
  const ui = await fixture(); await ui.open(); await ui.edit();
  const before = ui.counts('close_all_documents'), resets = ui.resets;
  ui.failClose(new Error('close failed'));
  ui.key(); await ui.settle(); ui.button('Close PDF without saving').props.onClick(); await ui.settle();
  assert.equal(ui.pageCount(), 2); assert.equal(ui.nativeDocuments, 1); assert.equal(ui.resets, resets);
  assert.ok(ui.button('Save copy and close'), 'The dirty close decision remains available after failure');
  ui.button('Keep editing').props.onClick(); await ui.settle();
  ui.key('p'); await ui.settle(); assert.ok(ui.component('PrintDialog'));
  assert.equal(ui.key().prevented, true); assert.equal(ui.counts('close_all_documents'), before + 1);
  ui.component('PrintDialog').props.onClose(); await ui.settle();
  ui.failClose(null); ui.key(); await ui.settle(); ui.button('Close PDF without saving').props.onClick(); await ui.settle();
  assert.equal(ui.pageCount(), 0); assert.equal(ui.resets, resets + 1); assert.equal(ui.destroyed, 0);
  ui.cleanup();
}
console.log('PASS: production App buttons/keyboard, dirty/clean close, one native release, busy/window guards, save cancellation/failure/success, failed close preservation, reset/registry release, print-modal shortcut blocking, and Ctrl+W never exits the app');
