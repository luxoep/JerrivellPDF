// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, globals = {}) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, console, ...globals });
  return exports;
}
const view = load('../src/viewerGeometry.ts');
const page = (id, width = 600, height = 800, rotation = 0) => ({ id, documentId: 'fixture', pageIndex: Number(id) || 0, width, height, rotation, sourceName: 'fixture.pdf' });
const pages = [page('a'), page('b', 500, 900, 90), page('c', 300, 300), page('d'), page('e')];
const size = { width: 900, height: 700 };
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-7, `${label}: ${actual} / ${expected}`);
const fitted = view.buildDocumentLayout(pages, size, 'fit');
assert.equal(fitted.pages.length, 5);
for (const row of fitted.pages) assert.equal(row.width, 852);
near(fitted.pages[1].height, 852 * 500 / 900, 'Rotated physical aspect ratio');
for (let index = 1; index < pages.length; index++) near(fitted.pages[index].top - fitted.pages[index - 1].top - fitted.pages[index - 1].height, view.PAGE_GAP, 'Continuous page gap');
for (const row of fitted.pages) assert.equal(view.pageAtPosition(fitted.pages, row.top + row.height / 2).id, row.id);
assert.equal(view.pageAtPosition([], 10), undefined);
assert.equal(view.pageAtPosition(fitted.pages, -100).id, 'a');
assert.equal(view.pageAtPosition(fitted.pages, 1e10).id, 'e');
for (const viewport of [size, { width: 290, height: 400 }, { width: 1800, height: 1100 }]) {
  const whole = view.buildDocumentLayout(pages, viewport, 'page');
  for (const row of whole.pages) { assert.ok(row.width <= viewport.width - 48 + .001); assert.ok(row.height <= viewport.height - 68 + .001); }
}
const anchor = view.captureViewAnchor(fitted, { left: 0, top: fitted.pages[1].top + 50 }, { x: 210, y: 220 });
const enlarged = view.buildDocumentLayout(pages, size, 180);
const restored = view.restoreViewAnchor(enlarged, anchor);
const recaptured = view.captureViewAnchor(enlarged, restored, { x: 210, y: 220 });
assert.equal(recaptured.id, anchor.id); near(recaptured.x, anchor.x, 'Pointer horizontal anchor'); near(recaptured.y, anchor.y, 'Pointer vertical anchor');
assert.equal(view.restoreViewAnchor(view.buildDocumentLayout([], size, 100), anchor), null);
assert.ok(view.wheelZoom(100, -100) > 100); assert.ok(view.wheelZoom(100, 100) < 100);
assert.equal(view.wheelZoom(400, -200), 400); assert.equal(view.wheelZoom(25, 200), 25);
assert.equal(view.wheelZoom(100, 1, 1), view.wheelZoom(100, 16, 0));
assert.equal(view.clampZoom(NaN), 100);
const stress = view.buildDocumentLayout(Array.from({ length: 5000 }, (_, index) => page(String(index))), size, 'fit');
assert.equal(view.pageAtPosition(stress.pages, stress.pages[4998].top + 50).index, 4998);

const ids = values => Array.from(values, value => value.id);
assert.deepEqual(ids(view.reorderPages(pages, 'a', 'c', 'after', new Set())), ['b', 'c', 'a', 'd', 'e']);
assert.deepEqual(ids(view.reorderPages(pages, 'e', 'a', 'before', new Set())), ['e', 'a', 'b', 'c', 'd']);
assert.deepEqual(ids(view.reorderPages(pages, 'b', 'e', 'after', new Set(['d', 'b']))), ['a', 'c', 'e', 'b', 'd']);
assert.deepEqual(ids(view.reorderPages(pages, 'd', 'a', 'before', new Set(['d', 'b']))), ['b', 'd', 'a', 'c', 'e']);
assert.equal(view.reorderPages(pages, 'a', 'b', 'before', new Set()), pages, 'No-op move must not add history');
assert.equal(view.reorderPages(pages, 'a', 'b', 'after', new Set(['a', 'b'])), pages, 'Dropping onto the selected block must be a no-op');
assert.equal(view.reorderPages(pages, 'missing', 'b', 'after', new Set()), pages);
assert.deepEqual(ids(pages), ['a', 'b', 'c', 'd', 'e'], 'Sorting must not mutate undo snapshots');

const canvasCalls = [];
const context = new Proxy({}, { get: (target, key) => target[key] ?? ((...args) => canvasCalls.push([key, ...args])), set: (target, key, value) => { target[key] = value; canvasCalls.push(['set', key, value]); return true; } });
let renderedCanvas;
const marks = load('../src/markGeometry.ts', { document: { createElement: () => renderedCanvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,fixture' } } });
const settings = { tool: 'highlight', color: '#ffcc00', lineWidth: 2, opacity: .35 };
const rectangle = marks.createMarkGeometry([{ x: .8, y: .6 }, { x: .1, y: .2 }], settings, 600, 800);
near(rectangle.bounds.x, .1, 'Reverse-drawn left'); near(rectangle.bounds.width, .7, 'Reverse-drawn width');
assert.equal(marks.createMarkGeometry([{ x: .1, y: .1 }, { x: .1001, y: .1001 }], settings, 600, 800), null, 'Tiny clicks must not create marks');
assert.equal(marks.createMarkGeometry([{ x: NaN, y: 0 }, { x: 1, y: 1 }], settings, 600, 800), null);
assert.equal(marks.createMarkGeometry([{ x: .1, y: .1 }, { x: .2, y: .2 }], { ...settings, tool: 'select' }, 600, 800), null);
for (const tool of ['highlight', 'block', 'rectangle', 'ellipse', 'underline', 'strikeout', 'arrow', 'pen']) {
  const geometry = marks.createMarkGeometry([{ x: -.1, y: -.1 }, { x: .3, y: .6 }, { x: 1.2, y: 1.2 }], { ...settings, tool }, 900, 500);
  assert.ok(geometry);
  assert.ok(geometry.bounds.x >= 0 && geometry.bounds.y >= 0 && geometry.bounds.x + geometry.bounds.width <= 1.0000001 && geometry.bounds.y + geometry.bounds.height <= 1.0000001, tool);
  canvasCalls.length = 0; marks.createMarkPng(geometry, '#ff5500');
  assert.ok(renderedCanvas.width <= 1800 && renderedCanvas.height <= 1800);
  if (tool === 'block' || tool === 'highlight') assert.ok(canvasCalls.some(call => call[0] === 'fillRect'));
  else assert.ok(canvasCalls.some(call => call[0] === 'stroke' || call[0] === 'strokeRect'));
  assert.ok(!canvasCalls.some(call => call[0] === 'set' && call[1] === 'globalAlpha'), 'Opacity is applied once by the PDF layer, not baked into the PNG again');
}
const line = marks.createMarkGeometry([{ x: .2, y: .3 }, { x: .8, y: .3 }], { ...settings, tool: 'underline' }, 600, 800);
assert.ok(line.bounds.height > 0 && line.bounds.height < .02, 'Horizontal lines need a positive tightly bounded image');
const square = marks.constrainedMarkPoint({ x: .1, y: .2 }, { x: .8, y: .3 }, 'rectangle', true, 600, 800);
near((square.x - .1) * 600, (square.y - .2) * 800, 'Shift square in physical page units');
assert.equal(marks.constrainedMarkPoint({ x: .1, y: .2 }, { x: .8, y: .3 }, 'underline', true, 600, 800).y, .2);

// Execute real React pointer handlers without a browser; capture/cancel and disabled
// transitions must not accidentally commit partial strokes or mutate the target page.
let currentHost;
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
const react = {
  useRef(initial) { const index = currentHost.cursor++; return currentHost.slots[index] ??= { current: initial }; },
  useState(initial) { const host = currentHost, index = host.cursor++; if (!(index in host.slots)) host.slots[index] = typeof initial === 'function' ? initial() : initial; return [host.slots[index], value => host.slots[index] = typeof value === 'function' ? value(host.slots[index]) : value]; },
  useEffect(effect, deps) { const host = currentHost, index = host.cursor++; const old = host.slots[index]; if (!old || !deps || deps.some((value, position) => value !== old.deps[position])) { old?.cleanup?.(); host.slots[index] = { deps }; host.effects.push(() => { host.slots[index].cleanup = effect(); }); } },
};
const listeners = new Map();
const host = { cursor: 0, slots: [], effects: [] };
const layer = load('../src/components/MarkLayer.tsx', {
  require(name) { if (name === 'react') return react; if (name === 'react/jsx-runtime') return jsx; if (name === '../markGeometry') return marks; if (name === '../i18n') return { useI18n: () => ({ t: (zh, en) => en ?? zh }) }; throw new Error(name); },
  window: { addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) },
});
const commits = [], begin = [];
const props = { settings, pageWidth: 600, pageHeight: 800, disabled: false, onBegin: () => begin.push(true), onComplete: (...args) => commits.push(args) };
const render = () => { currentHost = host; host.cursor = 0; host.effects = []; const tree = layer.MarkLayer(props); for (const effect of host.effects) effect(); return tree; };
const captured = new Set();
const surface = { getBoundingClientRect: () => ({ left: 100, top: 200, width: 600, height: 800 }), setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id), releasePointerCapture: id => captured.delete(id) };
const event = (x, y, extra = {}) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, currentTarget: surface, preventDefault() {}, stopPropagation() {}, shiftKey: false, ...extra });
let tree = render();
tree.props.onPointerDown(event(160, 280)); tree = render();
tree.props.onPointerMove(event(400, 440)); tree = render();
tree.props.onPointerUp(event(400, 440)); tree = render();
assert.equal(commits.length, 1); assert.equal(begin.length, 1); assert.equal(captured.size, 0);
near(commits[0][0].bounds.x, .1, 'Pointer mapped to page coordinate'); near(commits[0][0].bounds.width, .4, 'Pointer drag width');
tree.props.onPointerDown(event(160, 280)); tree.props.onPointerMove(event(400, 440)); tree.props.onPointerCancel(event(400, 440)); tree = render();
assert.equal(commits.length, 1, 'Pointer cancel must not create a history entry');
tree.props.onPointerDown(event(160, 280)); tree.props.onPointerMove(event(400, 440)); listeners.get('keydown')({ key: 'Escape' }); tree = render(); tree.props.onPointerUp(event(400, 440)); tree = render();
assert.equal(commits.length, 1, 'Escape must discard the active drawing');
tree.props.onPointerDown(event(160, 280)); tree.props.onPointerMove(event(400, 440)); props.disabled = true; tree = render(); tree.props.onPointerUp(event(400, 440));
assert.equal(commits.length, 1, 'Becoming busy must cancel pending placement');
// Exercise the viewer's actual native wheel listener and resize/scroll callbacks.
react.useMemo = (calculate, deps) => { const index = currentHost.cursor++, old = currentHost.slots[index]; if (!old || deps.some((value, position) => value !== old.deps[position])) currentHost.slots[index] = { deps, value: calculate() }; return currentHost.slots[index].value; };
react.useLayoutEffect = (effect, deps) => {
  const host = currentHost, index = host.cursor++, old = host.slots[index];
  if (!old || deps.some((value, position) => value !== old.deps[position])) { old?.cleanup?.(); host.slots[index] = { deps }; host.layoutEffects.push(() => { host.slots[index].cleanup = effect(); }); }
};
const viewportListeners = new Map(), viewportOptions = new Map(), zooms = [], activePages = [];
let resizeCallback, rafCallback;
const viewport = { clientWidth: 900, clientHeight: 700, scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => ({ left: 100, top: 50, width: 900, height: 700 }), addEventListener(name, handler, options) { viewportListeners.set(name, handler); viewportOptions.set(name, options); }, removeEventListener(name) { viewportListeners.delete(name); } };
const viewerModule = load('../src/components/PdfViewer.tsx', {
  require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'lucide-react') return { CircleAlert: 'CircleAlert', LoaderCircle: 'LoaderCircle' };
    if (name === '../viewerGeometry') return view;
    if (name === '../usePageImage') return { usePageImage() { throw new Error('Offscreen viewer test must not request real rasters'); } };
    if (name === '../i18n') return { useI18n: () => ({ t: (zh, en) => en ?? zh }) };
    if (name.endsWith('.css')) return {};
    throw new Error(name);
  },
  window: { devicePixelRatio: 1 },
  ResizeObserver: class { constructor(handler) { resizeCallback = handler; } observe() {} disconnect() {} },
  requestAnimationFrame: handler => { rafCallback = handler; return 1; }, cancelAnimationFrame() {},
});
const viewerHost = { cursor: 0, slots: [], effects: [], layoutEffects: [] };
const viewerProps = { pages: Array.from({ length: 200 }, (_, index) => page(String(index))), zoom: 'fit', navigation: null, onZoom(value) { zooms.push(value); viewerProps.zoom = value; }, onSize() {}, onActiveChange: id => activePages.push(id), controls: () => null };
function renderViewer() {
  currentHost = viewerHost; viewerHost.cursor = 0; viewerHost.effects = []; viewerHost.layoutEffects = [];
  const tree = viewerModule.PdfViewer(viewerProps); tree.props.ref.current = viewport;
  for (const effect of viewerHost.layoutEffects) effect(); for (const effect of viewerHost.effects) effect(); return tree;
}
let viewerTree = renderViewer(); resizeCallback(); viewerTree = renderViewer(); viewerTree = renderViewer();
assert.equal(viewport.scrollTop, 0, 'The first real viewport measurement must not crop the top of the opening page');
assert.equal(viewportOptions.get('wheel').passive, false, 'Ctrl+wheel must be cancellable');
let prevented = false;
const wheel = { ctrlKey: false, metaKey: false, deltaY: 120, deltaMode: 0, clientX: 400, clientY: 250, buttons: 0, preventDefault() { prevented = true; } };
viewportListeners.get('wheel')(wheel); assert.equal(prevented, false); assert.equal(zooms.length, 0, 'Ordinary wheel must keep native continuous scrolling');
const beforePoint = view.captureViewAnchor(view.buildDocumentLayout(viewerProps.pages, size, 'fit'), { left: 0, top: 0 }, { x: 300, y: 200 });
viewportListeners.get('wheel')({ ...wheel, ctrlKey: true, deltaY: -120 }); assert.equal(prevented, true); assert.equal(zooms.length, 1); viewerTree = renderViewer();
const afterPoint = view.captureViewAnchor(view.buildDocumentLayout(viewerProps.pages, size, viewerProps.zoom), { left: viewport.scrollLeft, top: viewport.scrollTop }, { x: 300, y: 200 });
assert.equal(afterPoint.id, beforePoint.id); near(afterPoint.x, beforePoint.x, 'Native wheel horizontal anchoring'); near(afterPoint.y, beforePoint.y, 'Native wheel vertical anchoring');
const scrollLayout = view.buildDocumentLayout(viewerProps.pages, size, viewerProps.zoom);
viewport.scrollTop = scrollLayout.pages[6].top; viewerTree.props.onScroll(); rafCallback(); viewerTree = renderViewer();
assert.equal(activePages.at(-1), '6', 'Wheel scrolling must update the active page without jumping back to its top');
assert.ok(viewerTree.props.children.props.children.length <= 5, 'Only nearby pages should mount raster components');
viewerProps.navigation = { id: '150', sequence: 1 }; viewerTree = renderViewer();
near(viewport.scrollTop, scrollLayout.pages[150].top - 24, 'Thumbnail/page-number navigation scrolls the continuous document');
viewport.clientWidth = 700; viewport.clientHeight = 500; viewerProps.zoom = 'page'; resizeCallback(); viewerTree = renderViewer(); viewerTree = renderViewer();
assert.ok(Number.isFinite(viewport.scrollTop) && viewport.scrollTop > 0, 'Resize and fit-page retain document position');
viewerProps.pages = [page('short', 600, 20), page('tall')]; viewerProps.zoom = 'fit'; viewerProps.navigation = { id: 'short', sequence: 2 }; activePages.length = 0; viewerTree = renderViewer();
viewerTree.props.onScroll(); rafCallback(); assert.equal(activePages.length, 0, 'Navigation to a short page stays selected until the user actually scrolls');

const sortListeners = new Map(), moves = [];
const thumbnailModule = load('../src/components/PageThumbnails.tsx', {
  require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => `icon-${String(key)}` });
    if (name === '../usePageImage') return {};
    if (name === '../i18n') return { useI18n: () => ({ t: (zh, en) => en ?? zh }) };
    throw new Error(name);
  },
  window: { addEventListener: (name, handler) => sortListeners.set(name, handler), removeEventListener: name => sortListeners.delete(name) },
  requestAnimationFrame: handler => { rafCallback = handler; return 1; }, cancelAnimationFrame() {},
});
const sortHost = { cursor: 0, slots: [], effects: [] };
const pane = { scrollTop: 0, getBoundingClientRect: () => ({ left: 100, right: 350, top: 100, bottom: 750, height: 650 }), querySelectorAll: () => pages.map((page, index) => ({ dataset: { thumbnailId: page.id }, getBoundingClientRect: () => ({ top: 110 + index * 120 - pane.scrollTop, bottom: 220 + index * 120 - pane.scrollTop, height: 110 }) })) };
const sortProps = { pages, activeId: 'a', selection: new Set(['a', 'c']), busy: false, onSelect() {}, onToggle() {}, onAdd() {}, onReorder: (...args) => moves.push(args) };
function renderSort() { currentHost = sortHost; sortHost.cursor = 0; sortHost.effects = []; const tree = thumbnailModule.PageThumbnails(sortProps); tree.props.ref.current = pane; for (const effect of sortHost.effects) effect(); return tree; }
let sortTree = renderSort();
const sortGesture = () => sortTree.props.children[0][0].props.gesture;
sortGesture().begin(event(180, 150), 'a'); sortGesture().move(event(180, 152)); sortGesture().finish(event(180, 152)); sortTree = renderSort();
assert.equal(moves.length, 0, 'A click must not start page sorting');
assert.equal(sortGesture().suppressClick(), false);
sortGesture().begin(event(180, 150), 'a'); sortGesture().move(event(180, 450)); sortTree = renderSort();
assert.equal(sortTree.props.children[0][0].props.dragged, true); assert.equal(sortTree.props.children[0][2].props.dragged, true, 'Selected pages move together');
sortGesture().finish(event(180, 450)); sortTree = renderSort();
assert.deepEqual(Array.from(moves[0]), ['a', 'c', 'after']); assert.equal(sortGesture().suppressClick(), true, 'The synthetic click after a drag must not reset selection');
sortGesture().begin(event(180, 150), 'a'); sortGesture().move(event(180, 600)); sortGesture().finish(event(180, 600), true); sortTree = renderSort();
assert.equal(moves.length, 1, 'Pointer cancellation must leave page order unchanged');
sortGesture().begin(event(180, 150), 'a'); sortGesture().move(event(180, 730)); rafCallback(); assert.ok(pane.scrollTop > 0, 'Dragging at the lower edge auto-scrolls the page sidebar');
sortListeners.get('keydown')({ key: 'Escape' }); sortTree = renderSort(); sortGesture().finish(event(180, 730)); assert.equal(moves.length, 1, 'Escape must cancel a pending sort');
sortProps.busy = true; sortTree = renderSort(); sortGesture().begin(event(180, 150), 'a'); sortGesture().move(event(180, 600)); sortGesture().finish(event(180, 600)); assert.equal(moves.length, 1, 'Busy workspaces must reject reordering');
console.log('PASS: continuous mixed-page layout, 5000-page lookup, fit width/page, native Ctrl+wheel and pointer anchors, viewport resize/scroll/navigation, virtual rasters, stable group sorting with pointer capture/auto-scroll/cancel, eight mark raster paths and pointer/cancel/Escape/busy gestures');
