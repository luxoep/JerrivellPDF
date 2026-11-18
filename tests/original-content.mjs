// SPDX-License-Identifier: GPL-3.0-or-later
// Real content plan helpers and component callbacks; native validation is mocked.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const transpile = async file => ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const helpers = {};
vm.runInNewContext(await transpile('../src/originalContent.ts'), { exports: helpers, Error });
const plain = value => JSON.parse(JSON.stringify(value));
const object = { objectIndex: 3, fingerprint: 'source-text', kind: 'text', bounds: { x: .1, y: .2, width: .3, height: .04 }, originalBounds: { x: .1, y: .2, width: .3, height: .04 }, text: 'Original text', originalText: 'Original text', fontFamily: 'Helvetica', fontSize: 12, fillColor: '#112233', editable: true, deleted: false };
const first = helpers.upsertContentEdit([], object, { text: 'Updated text' });
assert.equal(first[0].objectIndex, 3); assert.equal(first[0].fingerprint, 'source-text');
assert.equal('bounds' in first[0], false, 'Text-only changes must retain natural native glyph width');
const moved = helpers.upsertContentEdit(first, object, { bounds: { x: .2, y: .3, width: .3, height: .04 } });
assert.equal(moved[0].text, 'Updated text'); assert.equal(first[0].bounds, undefined);
const resetFont = helpers.upsertContentEdit([{ ...moved[0], fontFamily: 'Installed font' }], object, { fontFamily: undefined });
assert.equal('fontFamily' in resetFont[0], false); assert.equal(resetFont[0].text, 'Updated text');
assert.deepEqual(plain(helpers.removeContentEdit(moved, object)), []);
assert.equal(helpers.removeContentEdit(moved, { ...object, fingerprint: 'other-source' }).length, 1);
assert.deepEqual(plain(helpers.upsertContentEdit([{ objectIndex: 3, fingerprint: object.fingerprint, bounds: object.bounds }], object, { bounds: undefined })), [], 'Clearing the only action must remove the no-op plan');
const precise = helpers.geometryFromMillimeters({ x: '21', y: '29.7', width: '42', height: '59.4' }, 210 * helpers.POINTS_PER_MILLIMETER, 297 * helpers.POINTS_PER_MILLIMETER);
for (const [key, value] of Object.entries({ x: .1, y: .1, width: .2, height: .2 })) assert.ok(Math.abs(precise[key] - value) < 1e-12);
for (const patch of [{ x: '' }, { x: '-1' }, { width: '0' }, { width: '300' }, { height: 'NaN' }]) {
  assert.throws(() => helpers.geometryFromMillimeters({ x: '21', y: '29.7', width: '42', height: '59.4', ...patch }, 595, 842), /CONTENT_INVALID_BOUNDS/);
}
assert.ok(Math.abs(helpers.contentStep(595.2755905511812, false) - .1 / 210) < 1e-12);
assert.ok(Math.abs(helpers.contentStep(595.2755905511812, true) - 1 / 210) < 1e-12);
assert.deepEqual(plain(helpers.translatedContentBounds({ x: .8, y: .8, width: .2, height: .2 }, .5, -.9)), { x: .8, y: 0, width: .2, height: .2 });

let active;
const react = {
  useState(initial) { const host = active, slot = host.cursor++; if (!(slot in host.slots)) host.slots[slot] = typeof initial === 'function' ? initial() : initial; return [host.slots[slot], value => { host.slots[slot] = typeof value === 'function' ? value(host.slots[slot]) : value; }]; },
  useRef(initial) { const host = active, slot = host.cursor++; return host.slots[slot] ??= { current: initial }; },
  useEffect(effect, deps) { const host = active, slot = host.cursor++, previous = host.effects[slot]; if (!previous || deps.some((value, index) => value !== previous.deps[index])) host.pending.push(() => { previous?.cleanup?.(); host.effects[slot] = { deps, cleanup: effect() }; }); },
};
const jsx = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'fragment' };
let changeReply = async () => true;
let importReply = async () => ({ id: 'replacement-asset' });
const calls = [], changes = [], busy = [], errors = [], copied = [];
const require = name => {
  if (name === 'react') return react;
  if (name === 'react/jsx-runtime') return jsx;
  if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => `icon-${String(key)}` });
  if (name === '../i18n') return { useI18n: () => ({ t: (zh, en) => en ?? zh }) };
  if (name === '../originalContent') return helpers;
  if (name === '../backend') return { errorMessage: error => error.message, backend: async (command, args) => { calls.push({ command, args }); return importReply(); } };
  if (name === '@tauri-apps/plugin-dialog') return { open: async () => 'C:\\authorized.png' };
  if (name === './FontPicker') return { FontPicker: 'FontPicker' };
  if (name === './overlayCanvas') return { DEFAULT_FONT_FAMILY: 'Microsoft YaHei UI' };
  if (name.endsWith('.css')) return {};
  throw new Error(`Unexpected import ${name}`);
};
const editor = {}, handles = {};
vm.runInNewContext(await transpile('../src/components/OriginalContentEditor.tsx'), { exports: editor, require, console, Error, navigator: { clipboard: { writeText: async text => copied.push(text) } } });
vm.runInNewContext(await transpile('../src/components/OriginalContentHandles.tsx'), { exports: handles, require, console, Error });
const hostFor = () => ({ slots: [], effects: [], pending: [], cursor: 0, tree: null });
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
function walk(node, predicate, found = []) { if (!node || typeof node !== 'object') return found; if (Array.isArray(node)) { for (const child of node) walk(child, predicate, found); return found; } if (predicate(node)) found.push(node); walk(node.props?.children, predicate, found); return found; }
function render(component, props, host) { active = host; host.cursor = 0; host.pending = []; host.tree = component(props); for (const effect of host.pending) effect(); return host.tree; }
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };
const props = { pageWidth: 595.2755905511812, pageHeight: 841.8897637795277, objects: [{ ...object }], contentEdits: [], selectedId: '3', onSelect(id) { props.selectedId = id; }, onChange(next) { changes.push(plain(next)); return changeReply(next); }, onError(message) { errors.push(message); }, onBusyChange(value) { busy.push(value); }, onClose() {} };
let host = hostFor();
const rerender = () => render(editor.OriginalContentEditor, props, host);
const button = label => { const found = walk(host.tree, node => node.type === 'button' && text(node).trim() === label); assert.equal(found.length, 1, label); return found[0]; };
rerender(); rerender();
const originalText = walk(host.tree, node => node.type === 'textarea')[0];
originalText.props.onChange({ target: { value: 'Updated content' } }); rerender();
const validation = deferred(); changeReply = () => validation.promise;
button('Apply original content changes').props.onClick(); button('Apply original content changes').props.onClick(); await settle(); rerender();
assert.equal(changes.length, 1, 'Double click must wait for native validation');
assert.equal(changes[0][0].text, 'Updated content'); assert.equal('bounds' in changes[0][0], false);
assert.deepEqual(busy, [true]);
validation.resolve(false); await settle(); rerender();
assert.deepEqual(busy, [true, false]);
assert.equal(walk(host.tree, node => node.type === 'textarea')[0].props.value, 'Updated content', 'Rejected native validation must retain the draft');

changeReply = async () => true;
const fontToggle = walk(host.tree, node => node.type === 'label' && text(node).includes('Replace with an installed font'))[0];
walk(fontToggle, node => node.type === 'input')[0].props.onChange({ target: { checked: true } }); rerender();
walk(host.tree, node => node.type === 'FontPicker')[0].props.onChange('仿宋'); rerender();
button('Apply original content changes').props.onClick(); await settle(); rerender();
assert.equal(changes.at(-1)[0].fontFamily, '仿宋'); assert.equal('bounds' in changes.at(-1)[0], false);
const xField = walk(host.tree, node => node.type === 'input' && node.props['aria-label'] === 'Left mm')[0];
xField.props.onChange({ target: { value: '42' } }); rerender();
button('Apply original content changes').props.onClick(); await settle(); rerender();
assert.ok(Math.abs(changes.at(-1)[0].bounds.x - .2) < 1e-12);
assert.ok(Math.abs(changes.at(-1)[0].bounds.width - object.bounds.width) < 1e-3);
props.contentEdits = [{ objectIndex: 3, fingerprint: object.fingerprint, text: 'Revised', fontFamily: '仿宋', bounds: { x: .2, y: .2, width: .3, height: .04 } }];
props.objects = [{ ...object, text: 'Revised', fontFamily: '仿宋', bounds: { x: .2, y: .2, width: .3, height: .04 } }]; rerender(); rerender();
button('Clear manual placement and size').props.onClick(); await settle(); rerender();
assert.equal('bounds' in changes.at(-1)[0], false); assert.equal(changes.at(-1)[0].text, 'Revised'); assert.equal(changes.at(-1)[0].fontFamily, '仿宋');
const countBeforeInvalid = changes.length;
walk(host.tree, node => node.type === 'textarea')[0].props.onChange({ target: { value: 'Two\nlines' } }); rerender();
button('Apply original content changes').props.onClick(); await settle(); rerender();
assert.equal(changes.length, countBeforeInvalid); assert.ok(errors.at(-1).includes('one line'));
await button('Copy text').props.onClick(); assert.equal(copied.at(-1), 'Two\nlines');

// Tombstones remain selectable; restoring and resetting have distinct plans.
props.contentEdits = [{ objectIndex: 3, fingerprint: object.fingerprint, text: 'Changed', deleted: true }];
props.objects = [{ ...object, text: 'Changed', deleted: true }]; rerender(); rerender();
assert.equal(button('Apply original content changes').props.disabled, true);
button('Restore object').props.onClick(); await settle(); rerender();
assert.equal(changes.at(-1)[0].deleted, false); assert.equal(changes.at(-1)[0].text, 'Changed');
button('Reset to original').props.onClick(); await settle(); rerender(); assert.deepEqual(changes.at(-1), []);

// Replacing an existing image records its asset and waits for native validation.
props.contentEdits = []; props.objects = [{ ...object, kind: 'image', text: undefined, originalText: undefined }]; rerender(); rerender();
button('Replace image, keep placement').props.onClick(); await settle(); rerender();
assert.equal(calls.at(-1).command, 'import_image'); assert.equal(changes.at(-1)[0].replacementAssetId, 'replacement-asset');
assert.equal('bounds' in changes.at(-1)[0], false);
const late = deferred(); importReply = () => late.promise;
const beforeUnmountChanges = changes.length, beforeUnmountBusy = busy.length;
button('Replace image, keep placement').props.onClick(); await settle();
for (const effect of host.effects) effect?.cleanup?.();
late.resolve({ id: 'late-asset' }); await settle();
assert.equal(changes.length, beforeUnmountChanges); assert.deepEqual(busy.slice(beforeUnmountBusy), [true, false]);

// Original-object handles consume unsupported/disabled keys and bind gestures
// to one inspection so a stale drag never edits a newer page plan.
let handleChanges = [];
const handleProps = { objects: [{ ...object }], contentEdits: [], selectedId: '3', onSelect() {}, onChange(next) { handleChanges.push(plain(next)); return true; }, pageWidth: props.pageWidth, pageHeight: props.pageHeight, inspectionKey: 'first' };
const handleHost = hostFor();
const renderHandles = () => render(handles.OriginalContentHandles, handleProps, handleHost);
renderHandles(); renderHandles();
const keyEvent = key => ({ key, shiftKey: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
let handle = walk(handleHost.tree, node => node.props.role === 'button')[0];
const arrow = keyEvent('ArrowRight'); handle.props.onKeyDown(arrow);
assert.ok(arrow.prevented && arrow.stopped); assert.ok(Math.abs(handleChanges.at(-1)[0].bounds.x - .1 - .1 / 210) < 1e-12);
handleProps.objects = [{ ...object, editable: false }]; renderHandles(); handle = walk(handleHost.tree, node => node.props.role === 'button')[0];
const beforeUnsupported = handleChanges.length;
for (const key of ['Delete', 'Backspace', 'ArrowRight']) { const event = keyEvent(key); handle.props.onKeyDown(event); assert.ok(event.prevented && event.stopped); }
assert.equal(handleChanges.length, beforeUnsupported);
handleProps.objects = [{ ...object }]; renderHandles();
handleHost.tree.props.ref.current = { getBoundingClientRect: () => ({ width: 1000, height: 1000 }) };
const pointerTarget = { focus() {}, setPointerCapture() {}, hasPointerCapture() { return true; }, releasePointerCapture() {} };
const pointer = (x, y) => ({ button: 0, pointerId: 7, clientX: x, clientY: y, currentTarget: pointerTarget, preventDefault() {}, stopPropagation() {} });
handle = walk(handleHost.tree, node => node.props.role === 'button')[0];
handle.props.onPointerDown(pointer(100, 200)); handle.props.onPointerMove(pointer(200, 300));
handleProps.inspectionKey = 'new-inspection'; renderHandles();
handle.props.onPointerUp(pointer(200, 300));
assert.equal(handleChanges.length, beforeUnsupported, 'Changed inspection must invalidate an in-flight gesture');
console.log('PASS: immutable original-content patches, native-validation wait/retry, text/font vs geometry semantics, tombstone restore/reset, image replacement, unmount cleanup and stale/unsupported handle boundaries');
