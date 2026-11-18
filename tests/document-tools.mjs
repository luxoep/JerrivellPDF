// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, globals = {}) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(compiled, { exports, console, Error, RangeError, ...globals }); return exports;
}
const range = load('../src/pageRanges.ts'), viewer = load('../src/viewerGeometry.ts');
const tools = load('../src/documentTools.ts', { require(name) { if (name === './pageRanges') return range; if (name === './viewerGeometry') return viewer; throw new Error(name); } });
const page = (id, n = 0) => ({ id, documentId: 'fixture', pageIndex: n, sourceName: 'fixture.pdf', width: 600, height: 800, rotation: 0, overlays: [], contentEdits: [], decorations: [] });
const pages = Array.from({ length: 7 }, (_, index) => page(`p${index}`, index));
assert.deepEqual(Array.from(tools.splitPlan(pages, 'every', '3', '', 'report'), part => part.pages.length), [3, 3, 1]);
assert.deepEqual(Array.from(tools.splitPlan(pages, 'oddEven', '', '', 'report'), part => Array.from(part.pages, p => p.pageIndex)), [[0, 2, 4, 6], [1, 3, 5]]);
assert.deepEqual(Array.from(tools.splitPlan(pages, 'ranges', '', '1-2;4,6;7', 'report'), part => Array.from(part.pages, p => p.pageIndex)), [[0, 1], [3, 5], [6]]);
assert.throws(() => tools.splitPlan(pages, 'ranges', '', '1-8', 'report'));
assert.throws(() => tools.splitPlan(Array.from({ length: 201 }, (_, n) => page(String(n))), 'each', '', '', 'report'));
assert.throws(() => tools.splitPlan(pages, 'every', '0', '', 'report'));
assert.equal(tools.safePdfName('../CON?.pdf'), '.._CON_.pdf');
assert.equal(tools.safePdfName('CON.pdf'), '_CON.pdf');
const original = { ...page('original'), overlays: [{ id: 'layer', assetId: 'asset', x: .1, y: .2, width: .3, height: .4, opacity: .7 }], contentEdits: [{ objectIndex: 1, fingerprint: 'native', bounds: { x: .1, y: .2, width: .3, height: .1 } }], decorations: [{ id: 'n', kind: 'number', text: '1', x: .5, y: .9, angle: 0 }] };
const copy = tools.duplicatePage(original, 'copy'); copy.overlays[0].x = .8; copy.contentEdits[0].bounds.x = .7; copy.decorations[0].text = 'copy';
assert.equal(original.overlays[0].x, .1); assert.equal(original.contentEdits[0].bounds.x, .1); assert.equal(original.decorations[0].text, '1'); assert.equal(copy.overlays[0].assetId, 'asset');
let id = 0;
const numbered = tools.numberedPages(pages, new Set(['p1', 'p4']), { kind: 'number', template: '{page}/{total} — {n}', start: 5, fontSize: 12, fontFamily: null, color: '#333333', opacity: 1, angle: 0, placement: 'bottom-right', margin: 20 }, () => `n${++id}`);
assert.equal(numbered[1].decorations[0].text, '2/7 — 5'); assert.equal(numbered[4].decorations[0].text, '5/7 — 6'); assert.equal(numbered[0], pages[0]); assert.equal(pages[1].decorations.length, 0);
const operation = load('../src/pageOperations.ts'); let rotated = numbered[1]; for (let n = 0; n < 4; n++) rotated = operation.rotatePageClockwise(rotated);
assert.ok(Math.abs(rotated.decorations[0].x - numbered[1].decorations[0].x) < 1e-10); assert.equal(rotated.decorations[0].angle, 0);
const object = (index, text, x, y, width = .08, extra = {}) => ({ objectIndex: index, fingerprint: `f${index}`, kind: 'text', text, bounds: { x, y, width, height: .025 }, originalBounds: { x, y, width, height: .025 }, editable: true, deleted: false, fontSize: 16, fontFamily: 'Helvetica', textAngle: 0, ...extra });
const objects = [object(0, 'Hello', .1, .1), object(1, 'world', .192, .101), object(2, 'Column', .65, .1), object(3, 'Next', .1, .2), object(4, 'vertical', .4, .3, .02, { textAngle: 90 }), object(5, 'read only', .1, .4, .1, { editable: false })];
const lines = tools.groupTextLines(objects, 600, 800);
assert.equal(lines.length, 3); assert.equal(lines[0].text, 'Hello world'); assert.equal(lines[0].objects.length, 2); assert.equal(lines[1].text, 'Column'); assert.equal(lines[2].text, 'Next');
assert.equal(objects[0].bounds.x, .1, 'Clustering must not mutate workspace objects');

let host;
const react = {
  useState(initial) { const owner = host, index = host.cursor++; if (!(index in host.slots)) host.slots[index] = typeof initial === 'function' ? initial() : initial; return [host.slots[index], value => owner.slots[index] = typeof value === 'function' ? value(owner.slots[index]) : value]; },
  useRef(initial) { const index = host.cursor++; return host.slots[index] ??= { current: initial }; },
  useMemo(calculate, deps) { const index = host.cursor++, old = host.slots[index]; if (!old || deps.some((value, i) => value !== old.deps[i])) host.slots[index] = { value: calculate(), deps }; return host.slots[index].value; },
  useEffect(effect, deps) { const owner = host, index = host.cursor++, old = host.slots[index]; if (!old || !deps || deps.some((value, i) => value !== old.deps[i])) { old?.cleanup?.(); host.slots[index] = { deps }; host.effects.push(() => owner.slots[index].cleanup = effect()); } },
};
const jsx = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'fragment' };
const text = node => node == null || node === false ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
function walk(node, predicate, result = []) { if (!node || typeof node !== 'object') return result; if (Array.isArray(node)) { node.forEach(child => walk(child, predicate, result)); return result; } if (predicate(node)) result.push(node); walk(node.props?.children, predicate, result); return result; }
const calls = [], busy = [], saved = [], generated = [], applied = [];
let referenceCalls = 0;
let reportResolve, responseMode = 'normal';
const image = { dataUrl: 'data:image/png;base64,fixture', width: 600, height: 800 };
const report = { token: 'export-reviewed', outputs: [{ name: 'review.pdf', pageCount: 2, bytes: 12345 }], totalBytes: 12345, pageCount: 2, structures: { sourceCount: 1, annotationsAndLinks: 1, bookmarks: 1, attachments: 0, signatures: 1, forms: false, protected: false }, risks: [] };
const backend = {
  pageReference: value => (referenceCalls++, { documentId: value.documentId, pageIndex: value.pageIndex, rotation: value.rotation, ...(value.decorations?.length ? { decorations: value.decorations } : {}) }), errorMessage: error => error.message, renderPage: async () => image,
  async backend(command, args) {
    calls.push({ command, args });
    if (command === 'prepare_export') return new Promise(resolve => { reportResolve = resolve; });
    if (command === 'save_prepared_export') return { succeeded: 1, failed: 0, results: [{ path: args.paths[0], pageCount: 2, bytes: 12345, success: true }] };
    if (command === 'generate_pages') return { ...pages[0], id: 'generated', pages: [{ index: 0, width: 600, height: 800, rotation: 0 }], path: 'memory://generated', fileName: 'generated.pdf', fileSize: 10, pageCount: 1, warnings: [] };
    if (command === 'preview_line_edit') return { token: 'line-reviewed', before: image, after: image, bounds: lines[0].bounds, textWidth: responseMode === 'overflow' ? 900 : 100, availableWidth: 110, overflowLine: responseMode === 'overflow', overflowPage: responseMode === 'overflow', canApply: responseMode !== 'overflow' };
    if (command === 'commit_line_preview') return { id: 'new-source', pages: [{ index: 0, width: 600, height: 800 }] };
    return null;
  },
};
const require = name => {
  if(name==='./PreviewZoom')return{PreviewZoom:'PreviewZoom'};if (name === 'react') return react; if (name === 'react/jsx-runtime') return jsx;
  if (name === 'lucide-react') return new Proxy({}, { get: (_, name) => `icon-${String(name)}` });
  if (name === '../i18n') return { useI18n: () => ({ t: (zh, en) => en ?? zh }) };
  if (name === '../backend') return backend; if (name === '../documentTools') return tools;
  if (name === '../viewerGeometry') return viewer; if (name === '../pageRanges') return range;
  if (name === '../usePageImage') return { usePageImage: () => ({ image, loading: false, error: '' }) };
  if (name === './overlayCanvas') return { DEFAULT_FONT_FAMILY: 'Installed Font' };
  if (name === './FontPicker') return { FontPicker: 'FontPicker' }; if (name === './MarkLayer') return { MarkLayer: 'MarkLayer' };
  if (name === '@tauri-apps/plugin-dialog') return { save: async () => 'K:\\output\\review.pdf', open: async () => ['K:\\input\\first.png', 'K:\\input\\second.jpg'] };
  if (name === './PageToolPreview') return {PageToolPreview:'PageToolPreview'};
  if (name.endsWith('.css')) return {}; throw new Error(name);
};
function harness(Component, props) {
  const owner = { cursor: 0, slots: [], effects: [], tree: null };
  const render = () => { host = owner; host.cursor = 0; host.effects = []; host.tree = Component(props); for (const effect of host.effects) effect(); return host.tree; };
  const find = predicate => walk(owner.tree, predicate);
  const button = label => { const values = find(node => node.type === 'button' && (text(node).trim() === label || node.props['aria-label'] === label)); assert.equal(values.length, 1, label); return values[0]; };
  const input = label => { const values = find(node => node.type === 'input' && node.props['aria-label'] === label); assert.equal(values.length, 1, label); return values[0]; };
  const cleanup = () => { for (const slot of owner.slots) slot?.cleanup?.(); };
  render(); render(); return { render, find, button, input, cleanup, props };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const { ExportDialog } = load('../src/components/ExportDialog.tsx', { require });
const review = harness(ExportDialog, { parts: [{ name: 'review.pdf', pages: pages.slice(0, 2) }], onClose() {}, onSaved: value => saved.push(value), onBusyChange: value => busy.push(value) });
assert.equal(review.button('Confirm export').props.disabled, true);
reportResolve(report); await settle(); review.render();
assert.equal(review.button('Confirm export').props.disabled, false);
assert.ok(text(review.find(node => node.props.className === 'export-summary')[0]).includes('12.1 KiB'));
assert.equal(review.find(node => node.type === 'li').filter(node => walk(node, child => child.type === 'button').length).length, 2);
review.button('Confirm export').props.onClick(); review.button('Confirm export').props.onClick(); await settle(); review.render();
assert.equal(calls.filter(call => call.command === 'save_prepared_export').length, 1, 'Double-click cannot write twice');
assert.equal(calls.find(call => call.command === 'save_prepared_export').args.token, 'export-reviewed'); assert.equal(saved.length, 1); review.cleanup();

// A large output keeps the complete immutable export plan, but only mounts
// nearby order entries. Preview navigation must not serialize all pages again.
const largePages = Array.from({ length: 4992 }, (_, n) => ({ ...page(`many-${n}`, n % 156), documentId: `source-${Math.floor(n / 156)}`, sourceName: `A long source document name ${n}.pdf` }));
const beforeReferences = referenceCalls;
const largeReview = harness(ExportDialog, { parts: [{ name: 'large.pdf', pages: largePages }], onClose() {}, onSaved() {}, onBusyChange() {} });
const largeRequest = calls.filter(call => call.command === 'prepare_export').at(-1);
assert.equal(largeRequest.args.parts[0].pages.length, 4992, 'Native preflight still receives every page');
assert.equal(largeRequest.args.parts[0].pages[4991].documentId, 'source-31');
assert.equal(referenceCalls - beforeReferences, 4992, 'The native plan snapshot is built only once');
const orderSurface = { scrollTop: 0, clientHeight: 380 };
let orderList = largeReview.find(node => node.type === 'ol' && node.props.className === 'export-order-window')[0];
orderList.props.ref.current = orderSurface;
const mountedOrder = () => largeReview.find(node => node.type === 'li' && node.props['aria-posinset'] !== undefined);
assert.ok(mountedOrder().length <= 15, '4992 pages must not mount 4992 order buttons');
orderSurface.scrollTop = (4992 * 64) - 380;
orderList.props.onScroll({ currentTarget: orderSurface }); largeReview.render();
assert.equal(mountedOrder().at(-1).props['aria-posinset'], 4992);
assert.equal(mountedOrder().at(-1).props['aria-setsize'], 4992);
walk(mountedOrder().at(-1), node => node.type === 'button')[0].props.onClick(); largeReview.render();
assert.ok(text(largeReview.find(node => node.props.className === 'dt-page-nav')[0]).includes('4992 / 4992'));
largeReview.button('Preview previous page').props.onClick(); largeReview.render();
assert.ok(text(largeReview.find(node => node.props.className === 'dt-page-nav')[0]).includes('4991 / 4992'));
assert.equal(referenceCalls - beforeReferences, 4992, 'Scrolling/preview selection must not resnapshot the export plan');
assert.equal(calls.filter(call => call.command === 'prepare_export').filter(call => call.args.parts[0].name === 'large.pdf').length, 1);
largeReview.cleanup();

const { TextLineEditor } = load('../src/components/TextLineEditor.tsx', { require });
const lineEditor = harness(TextLineEditor, { page: pages[0], objects, loading: false, onClose() {}, onApplied: value => applied.push(value), onBusyChange: value => busy.push(value) });
lineEditor.button('Generate comparison').props.onClick(); await settle(); lineEditor.render();
assert.equal(lineEditor.button('Apply previewed result').props.disabled, false);
lineEditor.input('Text line character spacing').props.onChange({ target: { value: '2.5' } }); lineEditor.render();
assert.equal(lineEditor.button('Apply previewed result').props.disabled, true, 'An edited draft cannot apply a stale native preview');
responseMode = 'overflow'; lineEditor.button('Generate comparison').props.onClick(); await settle(); lineEditor.render();
assert.equal(lineEditor.button('Apply previewed result').props.disabled, true, 'Page overflow must prevent application');
responseMode = 'normal'; lineEditor.button('Generate comparison').props.onClick(); await settle(); lineEditor.render();
lineEditor.button('Apply previewed result').props.onClick(); await settle(); assert.equal(applied.length, 1); lineEditor.cleanup();

const { PageToolsDialog } = load('../src/components/PageToolsDialog.tsx', { require, crypto: { randomUUID: () => `id-${++id}` } });
let nativeBusy = false;
const split = harness(PageToolsDialog, { pages, activeIndex: 0, selectedIds: new Set(), title: 'report.pdf', onClose() {}, onPlan() {}, onGenerated: (...args) => generated.push(args), onExport(parts) { assert.equal(nativeBusy, false, 'Split handoff must release the workspace busy guard'); assert.equal(parts.length, 7); }, onBusyChange(value) { nativeBusy = value; } });
split.button('Split PDFs').props.onClick(); split.render(); split.button('Review split output').props.onClick(); await settle(); split.cleanup();
const imagesDialog = harness(PageToolsDialog, { pages, activeIndex: 1, selectedIds: new Set(), title: 'report.pdf', onClose() {}, onPlan() {}, onGenerated: (...args) => generated.push(args), onExport() {}, onBusyChange() {} });
assert.equal(imagesDialog.find(node => node.type === 'button' && ['Blank pages','Duplicate'].includes(text(node).trim())).length, 0, 'Main-page commands must not be duplicated in the batch dialog');
imagesDialog.button('Choose images').props.onClick(); await settle(); imagesDialog.render();
imagesDialog.button('Apply to workspace').props.onClick(); await settle();
assert.equal(generated.length, 1); assert.equal(generated[0][2], 2); assert.equal(calls.find(call => call.command === 'generate_pages').args.request.kind, 'images'); imagesDialog.cleanup();
console.log('PASS: stable text-line clustering and columns, immutable page copies/decorations, split limits and safe names, export preflight/exact-token write/double-submit, 4992-page virtual order and one-time plan snapshot, stale/overflow line previews and native apply, split modal handoff, image insertion and no duplicate main-page commands');

