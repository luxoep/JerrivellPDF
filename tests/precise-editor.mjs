// SPDX-License-Identifier: MIT OR Apache-2.0
// Real editor/handle callbacks, with React scheduling and native asset I/O stubbed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const transpile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const geometry = {};
const imageGeometry = {};
vm.runInNewContext(await transpile('../src/imageGeometry.ts'), { exports: imageGeometry });
vm.runInNewContext(await transpile('../src/overlayGeometry.ts'), { exports: geometry });
let activeHost;
const react = {
  useState(initial) { const host = activeHost, slot = host.cursor++; if (!(slot in host.slots)) host.slots[slot] = typeof initial === 'function' ? initial() : initial; return [host.slots[slot], value => { host.slots[slot] = typeof value === 'function' ? value(host.slots[slot]) : value; }]; },
  useRef(initial) { const host = activeHost, slot = host.cursor++; return host.slots[slot] ??= { current: initial }; },
  useMemo(factory, deps) { const host = activeHost, slot = host.cursor++, previous = host.slots[slot]; if (!previous || deps.some((value, index) => value !== previous.deps[index])) host.slots[slot] = { deps, value: factory() }; return host.slots[slot].value; },
  useEffect(effect, deps) { const host = activeHost, slot = host.cursor++, previous = host.effects[slot]; if (!previous || deps.some((value, index) => value !== previous.deps[index])) host.pending.push(() => { previous?.cleanup?.(); host.effects[slot] = { deps, cleanup: effect() }; }); },
};
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
function walk(node, predicate, found = []) { if (!node || typeof node !== 'object') return found; if (Array.isArray(node)) { for (const child of node) walk(child, predicate, found); return found; } if (predicate(node)) found.push(node); walk(node.props?.children, predicate, found); return found; }
const hostFor = () => ({ slots: [], effects: [], pending: [], cursor: 0, tree: null });
const jsx = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'fragment' };
let nextId = 0;
const changes = [], errors = [], selected = [], calls = [], drawnFonts = [];
const canvas = {
  DEFAULT_FONT_FAMILY: 'Microsoft YaHei UI', ensureFontReady: async (...args) => { drawnFonts.push(['ready', ...args]); },
  createTextPng: (...args) => { drawnFonts.push(['text', ...args]); return { dataUrl: 'data:image/png;base64,AA==', width: 200, height: 100 }; },
};
const require = name => {
  if (name === '../imageGeometry') return imageGeometry;
  if (name === './ImageEditDialog') return {ImageEditDialog:'ImageEditDialog'};
  if (name === './RegionSelection') return {RegionSelection:'RegionSelection'};
  if (name === '../useFragmentPreview') return {useFragmentPreview:()=>({image:null,error:''})};
  if (name === './OriginalObjectPreview') return {OriginalObjectPreview:'OriginalObjectPreview'};
  if(name==='./PreviewZoom')return{PreviewZoom:'PreviewZoom'};if (name === 'react') return react;
  if (name === 'react/jsx-runtime') return jsx;
  if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => `icon-${String(key)}` });
  if (name === '../i18n') return { useI18n: () => ({ t: (zh, en) => en ?? zh }) };
  if (name === '../backend') return { isDesktop: () => true, errorMessage: error => error.message, backend: async (command, args) => { calls.push({ command, args }); return { id: 'registered', dataUrl: 'data:image/png;base64,AA==', width: 200, height: 100 }; } };
  if (name === '@tauri-apps/plugin-dialog') return {};
  if (name === './overlayCanvas') return canvas;
  if (name === './FontPicker') return { FontPicker: 'FontPicker' };
  if (name === '../overlayGeometry') return geometry;
  if (name === '../stampLibrary') return { loadStampLibrary: () => [], saveStampLibrary() {}, LibraryError: class extends Error {}, MAX_LIBRARY_ITEMS: 20 };
  if (name.endsWith('.css')) return {};
  throw new Error(`Unexpected import ${name}`);
};
const editorExports = {};
vm.runInNewContext(await transpile('../src/components/OverlayEditor.tsx'), { exports: editorExports, require, crypto: { randomUUID: () => `copy-${++nextId}` }, console, Error });
const { OverlayEditor } = editorExports;
const props = { pageWidth: 595.2755905511812, pageHeight: 841.8897637795277, overlays: [{ id: 'source', assetId: 'existing-asset', x: .2, y: .25, width: .1, height: .05, opacity: .7, blendMode: 'multiply', rotation: 0 }], selectedId: 'source', onChange(next) { changes.push(next); props.overlays = next; }, onSelect(id) { selected.push(id); props.selectedId = id; }, onError(message) { errors.push(message); }, onClose() {} };
const host = hostFor();
function render(component = OverlayEditor, componentProps = props, target = host) { activeHost = target; target.cursor = 0; target.pending = []; target.tree = component(componentProps); for (const effect of target.pending) effect(); return target.tree; }
function button(label) { const found = walk(host.tree, node => node.type === 'button' && text(node) === label); assert.equal(found.length, 1, label); return found[0]; }
const settle = () => new Promise(resolve => setImmediate(resolve));
async function click(label) { button(label).props.onClick(); await settle(); render(); }
render(); render();
assert.equal(walk(host.tree, node => node.type === 'select' && node.props['aria-label'] === 'Position and size units')[0].props.value, 'mm');
// A precise field converts a 30 mm coordinate to normalized page units.
let field = walk(host.tree, node => node.type?.name === 'MeasureField' && node.props.label === 'Left')[0];
const fieldHost = hostFor(); render(field.type, field.props, fieldHost);
walk(fieldHost.tree, node => node.type === 'input')[0].props.onChange({ target: { value: '30' } });
render(field.type, field.props, fieldHost);
walk(fieldHost.tree, node => node.type === 'input')[0].props.onBlur(); render();
assert.equal(button('Apply position and size').props.disabled, false);
await click('Apply position and size');
assert.ok(Math.abs(props.overlays[0].x - 30 / 210) < 1e-10);
await click('Center horizontally'); assert.ok(Math.abs(props.overlays[0].x - .45) < 1e-10);
await click('Rotate 90°'); assert.equal(props.overlays[0].rotation, 90);
assert.ok(Math.abs(props.overlays[0].width * props.pageWidth - .05 * props.pageHeight) < 1e-10);
await click('Duplicate object');
assert.equal(props.overlays.length, 2); assert.equal(props.overlays[1].assetId, 'existing-asset'); assert.equal(props.overlays[1].blendMode, 'multiply'); assert.equal(props.selectedId, props.overlays[1].id);
assert.equal(calls.length, 0, 'Precise editing and duplication must reuse existing assets, with no native registration');
let lock = walk(host.tree, node => node.type === 'label' && text(node).includes('Lock object against movement'))[0];
walk(lock, node => node.type === 'input')[0].props.onChange({ target: { checked: true } }); render(); render();
assert.equal(props.overlays[1].locked, true); assert.equal(button('Rotate 90°').props.disabled, true); assert.equal(button('Remove').props.disabled, true);
const before = changes.length;
const event = key => ({ key, target: { tagName: 'BUTTON' }, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
let arrow = event('ArrowRight'); host.tree.props.onKeyDown(arrow); assert.ok(arrow.prevented && arrow.stopped); assert.equal(changes.length, before);
let del = event('Delete'); host.tree.props.onKeyDown(del); assert.ok(del.prevented && del.stopped); assert.equal(changes.length, before);
// Text input retains normal typing shortcuts; selected local font reaches font load and PNG drawing.
let font = walk(host.tree, node => node.type === 'FontPicker')[0]; font.props.onChange('仿宋'); render();
walk(host.tree, node => node.type === 'textarea')[0].props.onChange({ target: { value: '本机字体 ABC' } }); render();
await click('Add to this page');
assert.ok(drawnFonts.some(args => args[0] === 'ready' && args[1] === '仿宋'));
assert.ok(drawnFonts.some(args => args[0] === 'text' && args[5] === '仿宋'));
assert.equal(errors.length, 0);
// Locked/disabled page handles consume navigation/deletion rather than bubbling into page actions.
const handleExports = {};
vm.runInNewContext(await transpile('../src/components/OverlayHandles.tsx'), { exports: handleExports, require });
for (const disabled of [false, true]) {
  const handleHost = hostFor();
  render(handleExports.OverlayHandles, { overlays: [{ ...props.overlays[0], locked: true }], onChange() { throw new Error('Locked handle changed content'); }, disabled, pageWidth: props.pageWidth, pageHeight: props.pageHeight }, handleHost);
  const handle = walk(handleHost.tree, node => node.props.role === 'button')[0];
  for (const key of ['ArrowLeft', 'Delete', 'Backspace']) { const keyEvent = event(key); handle.props.onKeyDown(keyEvent); assert.ok(keyEvent.prevented && keyEvent.stopped); }
}
console.log('PASS: millimeter field commit, page alignment, physical rotation, immutable asset duplication, synchronized selection, lock/event boundaries and selected-font drawing');
