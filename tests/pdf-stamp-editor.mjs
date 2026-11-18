// SPDX-License-Identifier: MIT OR Apache-2.0
// Actual editor state and geometry, with only React scheduling and native I/O stubbed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(await readFile(new URL('../src/components/OverlayEditor.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const geometry = {};
const imageGeometry = {};
vm.runInNewContext(ts.transpileModule(await readFile(new URL('../src/imageGeometry.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: imageGeometry });
vm.runInNewContext(ts.transpileModule(await readFile(new URL('../src/overlayGeometry.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: geometry });
let current;
let library = [];
let calls = [];
let defer;
let ids = 0;
const busy = [];
const changes = [];
const errors = [];
const react = {
  useState(initial) {
    const host = current, slot = host.cursor++;
    if (!(slot in host.slots)) host.slots[slot] = typeof initial === 'function' ? initial() : initial;
    return [host.slots[slot], value => { host.slots[slot] = typeof value === 'function' ? value(host.slots[slot]) : value; }];
  },
  useRef(value) {
    const host = current, slot = host.cursor++;
    return host.slots[slot] ??= { current: value };
  },
  useMemo(factory, deps) {
    const host = current, slot = host.cursor++, previous = host.slots[slot];
    if (!previous || deps.some((value, index) => value !== previous.deps[index])) host.slots[slot] = { deps, value: factory() };
    return host.slots[slot].value;
  },
  useEffect(effect, deps) {
    const host = current, slot = host.cursor++, previous = host.effects[slot];
    if (!previous || deps.some((value, index) => value !== previous.deps[index])) host.pending.push(() => {
      previous?.cleanup?.(); host.effects[slot] = { deps, cleanup: effect() };
    });
  },
};
const exports = {};
class LibraryError extends Error { constructor(code) { super(code); this.code = code; } }
const png = 'data:image/png;base64,demo';
vm.runInNewContext(compiled, {
  exports, console, crypto: { randomUUID: () => `generated-${++ids}` },
  require(name) {
    if (name === '../imageGeometry') return imageGeometry;
    if (name === './ImageEditDialog') return {ImageEditDialog:'ImageEditDialog'};
  if (name === './RegionSelection') return {RegionSelection:'RegionSelection'};
  if (name === '../useFragmentPreview') return {useFragmentPreview:()=>({image:null,error:''})};
  if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'fragment' };
    if (name === '@tauri-apps/plugin-dialog') return { open: async () => 'C:\\demo.pdf', save: async () => null };
    if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => `icon-${String(key)}` });
    if (name === '../i18n') return { useI18n: () => ({ t: (zh, en) => en ?? zh }) };
    if (name === '../backend') return {
      isDesktop: () => true, errorMessage: error => error.message,
      backend: async (command, args) => {
        calls.push({ command, args });
        if (defer) await defer.promise;
        return { id: `asset-${calls.length}`, dataUrl: png, width: 1000, height: 1400, pageCount: 3 };
      },
    };
    if (name === '../stampLibrary') return {
      cleanLibraryName: value => value.trim(), LibraryError, MAX_LIBRARY_ITEMS: 20,
      loadStampLibrary: () => library, saveStampLibrary: items => { library = items; }, pngFileName: value => value + '.png',
    };
    if (name === './overlayCanvas') return { DEFAULT_FONT_FAMILY: 'Microsoft YaHei UI', ensureFontReady: async () => {} };
    if (name === './FontPicker') return { FontPicker: 'FontPicker' };
    if (name === '../overlayGeometry') return geometry;
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected import: ${name}`);
  },
});
const { OverlayEditor, pdfStampCropFromPoints, pdfStampSourceKey, pdfStampPreviewKey } = exports;
const plain = value => JSON.parse(JSON.stringify(value));
assert.deepEqual(plain(pdfStampCropFromPoints({ x: .8, y: .9 }, { x: .2, y: .3 })), { x: .2, y: .3, width: .6000000000000001, height: .6000000000000001 });
assert.deepEqual(plain(pdfStampCropFromPoints({ x: -.5, y: 2 }, { x: 2, y: -1 })), { x: 0, y: 0, width: 1, height: 1 });
assert.equal(pdfStampCropFromPoints({ x: .1, y: .1 }, { x: .101, y: .101 }), null);
assert.equal(pdfStampCropFromPoints({ x: NaN, y: .1 }, { x: .8, y: .5 }), null);
assert.equal(pdfStampSourceKey('a', '01'), pdfStampSourceKey('a', '1'));
assert.notEqual(pdfStampPreviewKey('a', '1', null, false, true), pdfStampPreviewKey('a', '1', null, true, true));

const props = {
  pageWidth: 595, pageHeight: 842, overlays: [], disabled: false,
  onChange: next => { props.overlays = next; changes.push(next); },
  onError: value => errors.push(value), onClose() {}, onBusyChange: value => busy.push(value),
};
const host = { slots: [], effects: [], pending: [], cursor: 0, tree: null };
function render() {
  current = host; host.cursor = 0; host.pending = [];
  host.tree = OverlayEditor(props);
  for (const effect of host.pending) effect();
  return host.tree;
}
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
function walk(node, predicate, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (Array.isArray(node)) { for (const child of node) walk(child, predicate, result); return result; }
  if (predicate(node)) result.push(node);
  walk(node.props?.children, predicate, result); return result;
}
function button(label) {
  const result = walk(host.tree, node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
  assert.equal(result.length, 1, `Expected one button ${label}`); return result[0];
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function click(label) { button(label).props.onClick(); await settle(); render(); }
render(); await click('Stamp'); await click('PDF fragment');
await click('Choose source PDF');
assert.equal(calls.length, 1);
assert.deepEqual(plain(calls[0]), { command: 'import_pdf_stamp', args: { path: 'C:\\demo.pdf', pageIndex: 0, crop: null, removeWhiteBackground: false, trimTransparentMargins: false } });
assert.equal(button('Overlay on this page').props.disabled, false, 'Placement generates the current fragment on demand');
const crop = { x: .2, y: .3, width: .4, height: .2 };
walk(host.tree, node => node.type?.name === 'PdfStampSelection')[0].props.onChange(crop); render();
await click('Update fragment preview');
assert.deepEqual(plain(calls.at(-1).args), { path: 'C:\\demo.pdf', pageIndex: 0, crop, removeWhiteBackground: false, trimTransparentMargins: true });
assert.equal(button('Overlay on this page').props.disabled, false);
// Blend changes are placement metadata and do not invalidate the fragment pixels.
const blendSelect = walk(host.tree, node => node.type === 'select' && node.props['aria-label'] === 'Fragment blend mode')[0];
blendSelect.props.onChange({ target: { value: 'normal' } }); render();
assert.equal(button('Overlay on this page').props.disabled, false);
await click('Overlay on this page');
assert.equal(props.overlays.length, 1); assert.equal(props.overlays[0].blendMode, 'normal');
assert.equal(props.overlays[0].assetId, 'asset-2');
// Placement closes the workspace. Reopen it; stale pixels are regenerated on use.
await click('Open PDF fragment workspace');
walk(host.tree, node => node.type?.name === 'PdfStampSelection')[0].props.onChange({ ...crop, x: .1 }); render();
assert.equal(button('Overlay on this page').props.disabled, false);
const white = walk(host.tree, node => node.type === 'label' && text(node).includes('Make near-white transparent'))[0];
walk(white, node => node.type === 'input')[0].props.onChange({ target: { checked: true } }); render();
// No explicit native preview update: saving must use the new crop and processing flags.
// Persist Multiply and restore it when placing an item from the library.
walk(host.tree, node => node.type === 'select' && node.props['aria-label'] === 'Fragment blend mode')[0].props.onChange({ target: { value: 'multiply' } }); render();
await click('Save to library');
assert.equal(calls.at(-1).args.removeWhiteBackground,true); assert.equal(calls.at(-1).args.crop.x,.1);
assert.equal(library.length, 1); assert.equal(library[0].blendMode, 'multiply');
assert.ok(!('assetId' in library[0]));
// Switching source page cannot reuse the previous page or its selected crop.
walk(host.tree, node => node.type === 'input' && node.props['aria-label'] === 'PDF fragment source page')[0].props.onChange({ target: { value: '2' } }); render();
assert.equal(button('Update fragment preview').props.disabled, true);
assert.equal(button('Overlay on this page').props.disabled, true);
await click('Load page');
assert.equal(calls.at(-1).args.pageIndex, 1); assert.equal(calls.at(-1).args.crop, null);
await click('Update fragment preview'); assert.equal(calls.at(-1).args.crop, null);
await click('Close fragment workspace'); await click('Library'); await click('Place');
assert.equal(props.overlays.at(-1).blendMode, 'multiply');
assert.equal(errors.length, 0);
assert.ok(busy.every((value, index) => value === (index % 2 === 0)), 'Every async operation releases busy exactly once');

// An unmounted editor must not commit a late native preview or keep busy set.
await click('Stamp'); await click('Open PDF fragment workspace');
defer = {}; defer.promise = new Promise(resolve => { defer.resolve = resolve; });
button('Update fragment preview').props.onClick();
const busyStart = busy.length;
for (const effect of host.effects) effect?.cleanup?.();
defer.resolve(); await settle();
assert.equal(busy.length, busyStart + 1); assert.equal(busy.at(-1), false);
assert.equal(changes.length, 2);
assert.equal(library.length, 1);
console.log('PASS: PDF crop geometry, whole-page loading, stale preview rejection, blend placement/library, page changes and async unmount protection');
