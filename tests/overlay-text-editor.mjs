// SPDX-License-Identifier: MIT OR Apache-2.0
// Render the production editor and canvas layout. Only React scheduling,
// browser fonts/canvas commands and native asset registration are controlled.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const tick = () => new Promise(resolve => setImmediate(resolve));
function load(path, require, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require, console, Intl, ...globals });
  return exports;
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} / ${expected}`);
function walk(node, predicate, output = []) {
  if (!node || typeof node !== 'object') return output;
  if (Array.isArray(node)) { for (const child of node) walk(child, predicate, output); return output; }
  if (predicate(node)) output.push(node);
  walk(node.props?.children, predicate, output); return output;
}
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
const changed = (old, next) => !old || next.some((value, n) => !Object.is(value, old[n]));
const geometry = load('../src/overlayGeometry.ts');
const imageGeometry = load('../src/imageGeometry.ts');
let ids = 0;
async function fixture(overlays = []) {
  const slots = [], effects = [], timers = new Map(), fontTimeouts = new Map(), canvasResults = [], nativeCalls = [], fontLoads = [], busy = [], errors = [], changes = [];
  let cursor = 0, pending = [], tree, needsRender = true, timerSequence = 0, deferFont = false;
  const react = {
    useState(initial) { const n = cursor++; if (!(n in slots)) slots[n] = typeof initial === 'function' ? initial() : initial; return [slots[n], value => { const next = typeof value === 'function' ? value(slots[n]) : value; if (!Object.is(next, slots[n])) { slots[n] = next; needsRender = true; } }]; },
    useRef(initial) { const n = cursor++; return slots[n] ??= { current: initial }; },
    useMemo(factory, deps) { const n = cursor++; if (changed(slots[n]?.deps, deps)) slots[n] = { deps, value: factory() }; return slots[n].value; },
    useEffect(callback, deps) { const n = cursor++; if (changed(effects[n]?.deps, deps)) pending.push(() => { effects[n]?.cleanup?.(); effects[n] = { deps, cleanup: callback() }; }); },
  };
  const document = {
    fonts: { load(font, sample) { let resolve; const request = { font, sample, resolve: () => resolve([]) }; const promise = new Promise(done => resolve = done); fontLoads.push(request); if (!deferFont) request.resolve(); return promise; } },
    createElement(type) {
      assert.equal(type, 'canvas');
      const draws = [], strokes = [], context = {
        font: '', fillStyle: '', strokeStyle: '',
        measureText(value) { const size = Number.parseFloat(this.font.match(/([\d.]+)px/)?.[1] ?? '24'); return { width: [...value].length * size * .6 }; },
        fillText(value, x, y) { draws.push({ value, x, y, font: this.font, color: this.fillStyle }); },
        beginPath() {}, moveTo(x, y) { this.from = [x, y]; }, lineTo(x, y) { strokes.push([this.from, [x, y]]); }, stroke() {},
      };
      return { width: 0, height: 0, getContext: () => context,
        toDataURL() { const result = { width: this.width, height: this.height, draws, strokes }; canvasResults.push(result); return `data:image/png;base64,${Buffer.from(JSON.stringify(result)).toString('base64')}`; },
      };
    },
  };
  const window = { setTimeout(callback, delay) { assert.ok([160,400].includes(delay)); const id = ++timerSequence; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); } };
  const canvas = load('../src/components/overlayCanvas.ts', () => {}, { document,
    setTimeout(callback) { const id = ++timerSequence; fontTimeouts.set(id, callback); return id; }, clearTimeout(id) { fontTimeouts.delete(id); },
  });
  const textFrame = load('../src/textFrame.ts', name => {
    if (name === './overlayGeometry') return geometry;
    if (name === './components/overlayCanvas') return canvas;
    throw new Error(name);
  });
  const props = { pageWidth: 500, pageHeight: 700, overlays, selectedId: overlays.at(-1)?.id ?? '', disabled: false,
    onChange(next) { changes.push({ before: props.overlays, after: next }); props.overlays = next; needsRender = true; },
    onSelect(id) { props.selectedId = id; needsRender = true; }, onBusyChange: value => busy.push(value),
    onError: error => errors.push(error), onClose() {},
  };
  class LibraryError extends Error {}
  const numbers = load('../src/useNumberDraft.ts', () => react);
  const fragments = load('../src/pdfFragments.ts', name => name === './imageGeometry' ? imageGeometry : geometry, {crypto:{randomUUID:()=>`fragment-${++ids}`}});
  const editor = load('../src/components/OverlayEditor.tsx', name => {
    if (name === 'react') return react;
    if (name === 'react-dom') return { flushSync: callback => callback() };
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name === './overlayCanvas') return canvas;
    if (name === '../overlayGeometry') return geometry;
    if (name === '../textFrame') return textFrame;
    if (name === '../useNumberDraft') return numbers;
    if(name==='./FragmentTray')return{FragmentTray:'FragmentTray'}; if(name==='../pdfFragments')return fragments;
    if (name === '../imageGeometry') return imageGeometry;
    if (name === '../useFragmentPreview') return { useFragmentPreview: () => ({ image: null, error: '' }) };
    if (name === '../i18n') return { useI18n: () => ({ t: (zh, en) => en ?? zh }) };
    if (name === '../stampLibrary') return { LibraryError, loadStampLibrary: () => [], MAX_LIBRARY_ITEMS: 20, cleanLibraryName: value => value.trim() };
    if (name === '../backend') return { isDesktop: () => true, errorMessage: error => String(error.message ?? error),
      async backend(command, args) { assert.equal(command, 'register_image', 'Text editing only registers PNG assets; it never mutates original PDF objects'); nativeCalls.push({ command, args }); const image = JSON.parse(Buffer.from(args.dataUrl.split(',')[1], 'base64').toString()); return { id: `asset-${++ids}`, dataUrl: args.dataUrl, width: image.width, height: image.height }; },
    };
    if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) });
    if (name === './PreviewZoom') return { PreviewZoom: 'PreviewZoom' };
    if (name === './FontPicker') return { FontPicker: 'FontPicker' };
    if (name === './RegionSelection') return { RegionSelection: 'RegionSelection' };
    if (name === './ImageEditDialog') return { ImageEditDialog: 'ImageEditDialog' };
    if (name === '@tauri-apps/plugin-dialog' || name.endsWith('.css')) return {};
    throw new Error(name);
  }, { window, crypto: { randomUUID: () => `overlay-${++ids}` }, Error });
  function render() { if (!needsRender) return tree; needsRender = false; cursor = 0; pending = []; tree = editor.OverlayEditor(props); for (const effect of pending) effect(); return tree; }
  async function settle() { for (let n = 0; n < 8; n++) { render(); await tick(); if (!needsRender && n > 1) break; } render(); }
  function find(predicate) { render(); return walk(tree, predicate)[0]; }
  const button = label => find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
  const control = label => { const field = find(node => node.type === 'label' && text(node).startsWith(label)); assert.ok(field, `Missing field: ${label}`); return walk(field, node => ['input', 'textarea', 'select'].includes(node.type))[0]; };
  const change = (label, value) => { const node = control(label); node.props.onChange({ target: typeof value === 'boolean' ? { checked: value } : { value: String(value) } }); render(); };
  async function click(label) { const node = button(label); assert.ok(node, `Missing button: ${label}`); assert.equal(Boolean(node.props.disabled), false, `Disabled button: ${label}`); node.props.onClick(); await settle(); }
  const preview = () => find(node => node.type === 'PreviewZoom' && node.props.resetKey === 'added-text');
  await settle();
  return { props, render, settle, button, change, click, preview, nativeCalls, fontLoads, busy, errors, changes, canvasResults,
    setText(value) { find(node => node.type === 'textarea').props.onChange({ target: { value } }); render(); },
    setFont(value) { find(node => node.type === 'FontPicker').props.onChange(value); render(); },
    setOverlays(value) { props.overlays = value; needsRender = true; render(); },
    blurText() { find(node => node.type === 'section' && node.props['data-inline-text-edit']).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); render(); },
    runTimers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    deferFonts(value = true) { deferFont = value; },
    cleanup() { for (const effect of effects) effect?.cleanup?.(); },
  };
}

// Live formatting remains local. Exported physical size is raster pixels / 2
// points, preserving the requested font size rather than scaling it to 30%.
{
  const ui = await fixture(); ui.setText('First line\n中文 second line');
  ui.change('Size (pt)', 18); ui.change('Bold', true); ui.change('Italic', true);
  ui.change('Underline', true); ui.change('Strikeout', true);
  ui.change('Character spacing (pt)', 1); ui.change('Line spacing', 1.8);
  ui.change('Line alignment', 'center'); ui.change('Box width (mm)', 70); ui.setFont('User font');
  ui.runTimers(); await ui.settle();
  assert.ok(ui.preview()); assert.equal(ui.nativeCalls.length, 0, 'Realtime preview must not use worker IPC');
  assert.ok(ui.canvasResults.at(-1).draws.every(draw => draw.font === 'italic 600 36px "User font", sans-serif'));
  await ui.click('Add to this page');
  assert.equal(ui.props.overlays.length, 1); const item = ui.props.overlays[0];
  assert.equal(item.textSource.content, 'First line\n中文 second line'); assert.equal(item.textSource.fontSize, 18);
  assert.equal(item.textSource.alignment, 'center'); assert.equal(item.textSource.wrapWidth, undefined);
  near(item.textSource.frame.width, Math.ceil(70 * geometry.POINTS_PER_MM * 2) / 2); assert.equal(item.textSource.frame.autoHeight, true);
  const image = JSON.parse(Buffer.from(ui.nativeCalls[0].args.dataUrl.split(',')[1], 'base64').toString());
  near(item.width * ui.props.pageWidth, image.width / 2);
  near(item.height * ui.props.pageHeight, image.height / 2);
  assert.deepEqual(ui.busy, [true, false]); assert.deepEqual(ui.errors, []);
  const backend = load('../src/backend.ts', name => { assert.equal(name, '@tauri-apps/api/core'); return {}; }, { window: {} });
  const reference = backend.pageReference({ documentId: 'pdf', pageIndex: 0, rotation: 0, overlays: [{ ...item, locked: true }] });
  assert.equal(reference.overlays[0].textSource, undefined); assert.equal(reference.overlays[0].locked, undefined);
  assert.equal(reference.overlays[0].assetId, item.assetId);
  ui.cleanup();
}

// Updating a rotated selection preserves its identity/compositing and applies
// the PNG's *rotated physical* dimensions. Old snapshots stay safe for undo.
for (const rotation of [90, 270]) {
  const before = { id: 'selected', assetId: 'previous-asset', x: .5, y: .2, width: .2, height: .3, opacity: .42, rotation, blendMode: 'multiply',
    textSource: { content: 'Original', color: '#234567', fontSize: 12, bold: false, fontFamily: 'Arial', italic: true, alignment: 'right', charSpacing: .5, lineHeight: 1.6 } };
  const originalSnapshot = JSON.stringify(before);
  const ui = await fixture([before]);
  assert.equal(ui.button('Update selected text'), undefined);
  assert.equal(ui.button('Load selected text'), undefined);
  ui.setText('Updated\nTwo lines'); assert.equal(ui.changes.length, 0);
  ui.runTimers(); await ui.settle();
  ui.runTimers(); await ui.settle();
  const after = ui.props.overlays[0], image = ui.canvasResults.at(-1);
  assert.equal(ui.changes.length, 1); assert.equal(ui.nativeCalls.length, 0, 'The normal workspace commit stages the resulting raster');
  assert.equal(after.id, before.id); assert.equal(after.opacity, .42); assert.equal(after.rotation, rotation); assert.equal(after.blendMode, 'multiply');
  assert.equal(after.textSource.content, 'Updated\nTwo lines'); assert.equal(after.textSource.fontSize, 12);
  near(after.width * ui.props.pageWidth, image.height / 2);
  near(after.height * ui.props.pageHeight, image.width / 2);
  assert.equal(JSON.stringify(before), originalSnapshot, 'Updating must not mutate the undo snapshot');
  ui.setOverlays(ui.changes[0].before); await ui.settle();
  ui.runTimers(); await ui.settle(); ui.runTimers(); await ui.settle(); assert.ok(ui.preview());
  assert.equal(ui.changes.length, 1, 'Undo must not trigger a new automatic text update');
  assert.equal(ui.props.overlays[0].assetId, 'previous-asset'); assert.equal(ui.props.overlays[0].textSource.content, 'Original');
  ui.cleanup();
}

// A long, unwrapped line can fit the page but exceed the default x=.12.
// Move the box into bounds without shrinking its exact physical font size.
{
  const ui = await fixture(); ui.change('Wrap to box width', false); ui.setText('X'.repeat(30));
  await ui.click('Add to this page'); assert.deepEqual(ui.errors, []);
  const item = ui.props.overlays[0]; near(item.width, 30 * 24 * .6 / ui.props.pageWidth);
  assert.ok(item.x + item.width <= 1, 'New text must stay within the native worker page bounds');
  const image = JSON.parse(Buffer.from(ui.nativeCalls[0].args.dataUrl.split(',')[1], 'base64').toString());
  near(item.width * ui.props.pageWidth, image.width / 2); ui.cleanup();
}

// Page-side drag changes must flow back into the editor. Changing the content
// after a drag must retain the new container, not restore stale width/height.
{
  const source = { content: 'Original text', color: '#234567', fontSize: 12, bold: false, fontFamily: 'Arial',
    frame: { width: 240, height: 70, autoHeight: true } };
  const ui = await fixture([{ id: 'selected', assetId: 'old', x: .1, y: .1, width: .48, height: .1, opacity: 1, textSource: source }]);
  ui.setOverlays([{ ...ui.props.overlays[0], width: .3, textSource: { ...source, frame: { width: 150, height: 70, autoHeight: true } } }]);
  await ui.settle(); ui.setText('Changed after dragging'); ui.runTimers(); await ui.settle(); ui.blurText(); await ui.settle();
  near(ui.props.overlays[0].textSource.frame.width, 150);
  assert.equal(ui.props.overlays[0].textSource.fontSize, 12);
  const image = ui.canvasResults.at(-1);
  assert.equal(image.width, 300); ui.cleanup();
}

// Fixed frame overflow is visible and blocked before asset registration. The
// full input remains in the editor, with no automatic font shrink or truncation.
{
  const ui = await fixture(); ui.setText('A long paragraph '.repeat(15));
  ui.change('Box width (mm)', 40); ui.change('Grow height to fit text', false); ui.change('Box height (mm)', 10);
  ui.runTimers(); await ui.settle();
  assert.equal(ui.button('Add to this page').props.disabled, true);
  assert.equal(ui.nativeCalls.length, 0); assert.equal(ui.props.overlays.length, 0);
  ui.change('Grow height to fit text', true); ui.runTimers(); await ui.settle();
  assert.equal(ui.button('Add to this page').props.disabled, false); ui.cleanup();
}

// A slow old font cannot repaint over a newer text/font choice. Also release a
// pending insertion on unmount without adding an object to the replaced page.
{
  const ui = await fixture(); ui.deferFonts(); ui.setText('OLD preview'); ui.runTimers();
  const old = ui.fontLoads.at(-1); ui.setText('NEW preview'); ui.setFont('Next font'); ui.runTimers();
  const fresh = ui.fontLoads.at(-1); fresh.resolve(); await ui.settle();
  const expected = ui.preview().props.children.props.src;
  old.resolve(); await ui.settle(); assert.equal(ui.preview().props.children.props.src, expected);
  assert.ok(ui.canvasResults.at(-1).draws.some(draw => draw.value === 'NEW preview'));
  const before = ui.nativeCalls.length; ui.button('Add to this page').props.onClick(); await ui.settle();
  const inserting = ui.fontLoads.at(-1); ui.cleanup(); inserting.resolve(); await tick();
  assert.equal(ui.nativeCalls.length, before); assert.equal(ui.props.overlays.length, 0); assert.deepEqual(ui.busy, [true, false]);
}
console.log('PASS: production text editor controls, local multiline/style preview, exact physical point size, text metadata excluded from worker, rotated selection updates, immutable undo snapshots, valid placement bounds, stale font cancellation and pending insertion cleanup');
