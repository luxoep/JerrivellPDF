// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const plain = value => JSON.parse(JSON.stringify(value));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function load(file, globals = {}) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, console, ...globals });
  return exports;
}
const canvasCalls = [];
const context = new Proxy({}, { get: (target, key) => target[key] ?? ((...args) => canvasCalls.push([key, ...args])), set: (target, key, value) => { target[key] = value; return true; } });
const marks = load('../src/markGeometry.ts', { document: { createElement: () => ({ getContext: () => context, toDataURL: () => 'data:image/png;base64,fixture' }) } });
const settings = { tool: 'polyarrow', color: '#436b84', opacity: .8, lineWidth: 2, lineStyle: 'dashed', arrowHeads: 'both' };
const points = [{ x: .1, y: .8 }, { x: .6, y: .2 }, { x: .9, y: .2 }];
const mark = marks.createMarkGeometry(points, settings, 600, 800);
assert.deepEqual(plain(mark.points), points, 'All bends must survive geometry creation');
const paths = marks.markArrowPaths(mark);
assert.equal(paths.length, 2);
near(paths[1][1].x, 540); near(paths[1][1].y, 160);
near(paths[1][0].y - 160, 160 - paths[1][2].y);
assert.ok(paths[1][0].x < 540 && paths[1][2].x < 540, 'The terminal arrow follows the horizontal last segment, not the start/end diagonal');
const startWingCenter = { x: (paths[0][0].x + paths[0][2].x) / 2, y: (paths[0][0].y + paths[0][2].y) / 2 };
assert.ok(startWingCenter.x > 60 && startWingCenter.y < 640, 'The start arrow faces away from its adjacent diagonal segment');
const duplicatedEnd = marks.markArrowPaths({ ...mark, points: [...points, points.at(-1)] });
assert.deepEqual(plain(duplicatedEnd), plain(paths), 'A duplicate terminal node must not flip arrow direction');
assert.equal(marks.markArrowPaths({ ...mark, arrowHeads: 'none' }).length, 0);
assert.equal(marks.createMarkGeometry(points, { ...settings, tool: 'callout', arrowHeads: undefined }, 600, 800).arrowHeads, 'start');
assert.equal(marks.createMarkGeometry(points, { ...settings, tool: 'polyline', arrowHeads: undefined }, 600, 800).arrowHeads, 'none');
assert.equal(marks.createMarkGeometry(points, { ...settings, tool: 'arrow' }, 600, 800).points.length, 2, 'Straight tools retain their existing two-endpoint behavior');
assert.equal(marks.createMarkGeometry(points, settings, Infinity, 800), null);
assert.equal(marks.createMarkGeometry([{x: NaN, y: .2}, points[1]], settings, 600, 800), null);
assert.equal(marks.createMarkGeometry(points, { ...settings, lineWidth: NaN }, 600, 800).lineWidth, 2);
const snap = marks.constrainedMarkPoint({x:.1,y:.1}, {x:.4,y:.36}, 'polyarrow', true, 600, 800);
near((snap.x - .1) * 600, (snap.y - .1) * 800);
const source = { geometry: mark, color: settings.color }, original = JSON.stringify(source), bounds = mark.bounds;
const target = { x: .2, y: .15, width: bounds.width / 2, height: bounds.height / 3 };
const transformed = marks.transformMarkSource(source, bounds, target);
assert.deepEqual(Object.keys(transformed.geometry.bounds).sort(), ['height','width','x','y']);
for (const path of marks.markArrowPaths(transformed.geometry)) for (const point of path) {
  const box=transformed.geometry.bounds;
  assert.ok(point.x>=box.x*600 && point.x<=(box.x+box.width)*600);
  assert.ok(point.y>=box.y*800 && point.y<=(box.y+box.height)*800);
}
for (let i = 0; i < points.length; i++) {
  near(transformed.geometry.points[i].x, target.x + (points[i].x - bounds.x) / 2);
  near(transformed.geometry.points[i].y, target.y + (points[i].y - bounds.y) / 3);
}
assert.equal(JSON.stringify(source), original, 'Moving a mark must not mutate its history snapshot');
assert.equal(marks.transformMarkSource(source, { ...bounds, width: 0 }, target), source);
assert.equal(marks.transformMarkSource(source, bounds, { ...target, x: NaN }), source);
const thick=marks.createMarkGeometry([{x:.3,y:.3},{x:.5,y:.5}],{...settings,tool:'arrow',lineWidth:12,arrowHeads:'end'},600,800);
const small=marks.transformMarkSource({geometry:thick,color:settings.color},thick.bounds,{...thick.bounds,width:thick.bounds.width/4,height:thick.bounds.height/4}).geometry;
for(const path of marks.markArrowPaths(small))for(const point of path){const b=small.bounds;assert.ok(point.x-6>=b.x*600&&point.x+6<=(b.x+b.width)*600);assert.ok(point.y-6>=b.y*800&&point.y+6<=(b.y+b.height)*800);}
canvasCalls.length = 0; marks.createMarkPng(mark, settings.color);
assert.equal(canvasCalls.filter(call => call[0] === 'stroke').length, 3, 'Raster export must include one path and two arrowheads');
assert.deepEqual(plain(canvasCalls.filter(call => call[0] === 'setLineDash').map(call => call[1])), [[14, 8], []], 'Arrowheads are solid even on dashed paths');

let currentHost;
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
const react = {
  useRef(initial) { const index = currentHost.cursor++; return currentHost.slots[index] ??= { current: initial }; },
  useState(initial) { const host = currentHost, index = host.cursor++; if (!(index in host.slots)) host.slots[index] = typeof initial === 'function' ? initial() : initial; return [host.slots[index], value => host.slots[index] = typeof value === 'function' ? value(host.slots[index]) : value]; },
  useEffect(effect, deps) { const host = currentHost, index = host.cursor++, old = host.slots[index]; if (!old || !deps || deps.some((value, i) => value !== old.deps[i])) { old?.cleanup?.(); host.slots[index] = { deps }; host.effects.push(() => { host.slots[index].cleanup = effect(); }); } },
};
const listeners = new Map();
const globals = {
  require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return jsx;
    if (name === '../markGeometry') return marks;
    if (name === '../overlayGeometry') return { overlayStep: (dimension, shift) => (shift ? 2.834645669 : .2834645669) / dimension };
    if (name === '../i18n') return { useI18n: () => ({ t: (zh, en) => en ?? zh }) };
    if (name.endsWith('.css')) return {};
    throw new Error(name);
  },
  window: { addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) },
};
const layer = load('../src/components/MarkLayer.tsx', globals);
const captured = new Set();
const surface = { getBoundingClientRect: () => ({ left: 100, top: 200, width: 600, height: 800 }), setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id), releasePointerCapture: id => captured.delete(id), focus() {} };
const event = (x, y, extra = {}) => ({ button: 0, pointerId: 1, detail: 1, clientX: 100 + x * 600, clientY: 200 + y * 800, currentTarget: surface, shiftKey: false, preventDefault() {}, stopPropagation() {}, ...extra });
function renderer(Component, props) {
  const host = { cursor: 0, slots: [], effects: [] };
  return () => { currentHost = host; host.cursor = 0; host.effects = []; const tree = Component(props); if (tree?.props.ref) tree.props.ref.current = surface; for (const effect of host.effects) effect(); return tree; };
}
const commits = [], begins = [];
const props = { settings, pageWidth: 600, pageHeight: 800, disabled: false, onBegin: () => begins.push(1), onComplete: (...args) => commits.push(args) };
const render = renderer(layer.MarkLayer, props);
let tree = render();
const click = (x, y, extra) => { tree.props.onPointerDown(event(x,y,extra)); tree.props.onPointerUp(event(x,y,extra)); tree = render(); };
click(.1,.8); tree.props.onPointerMove(event(.6,.2)); tree = render();
assert.equal(commits.length, 0, 'Hover and pointer release must not commit a multi-point path');
click(.6,.2); click(.9,.2);
assert.equal(begins.length, 1, 'A path begins once, not once per node');
listeners.get('keydown')({ key: 'Backspace', preventDefault() {}, stopPropagation() {} }); tree = render();
click(.85,.3); listeners.get('keydown')({ key: 'Enter', preventDefault() {}, stopPropagation() {} }); tree = render();
assert.equal(commits.length, 1); assert.deepEqual(plain(commits[0][0].points), [points[0], points[1], {x:.85,y:.3}]);
assert.equal(captured.size, 0, 'Multi-point clicks do not retain pointer capture');
click(.1,.8); click(.6,.2); click(.9,.2); click(.9,.2, { detail: 2 }); tree.props.onDoubleClick(event(.9,.2)); tree = render();
assert.equal(commits.length, 2); assert.equal(commits[1][0].points.length, 3, 'Double-click completion must not duplicate the last node');
click(.1,.8); click(.6,.2); listeners.get('keydown')({ key: 'Escape' }); tree = render();
assert.equal(commits.length, 2);
click(.1,.8); click(.6,.2); props.disabled = true; tree = render(); listeners.get('keydown')({ key: 'Enter' }); tree = render();
assert.equal(commits.length, 2, 'Busy transitions cancel a pending path');
props.disabled = false; tree = render(); click(.1,.8); props.settings = { ...settings, tool: 'line' }; tree = render();
listeners.get('keydown')({ key: 'Enter' }); assert.equal(commits.length, 2, 'Switching tools cancels pending nodes');

const handles = load('../src/components/EditableMarkHandles.tsx', globals), edits = [], previews = [];
const item = { id: 'path', assetId: 'raster', ...mark.bounds, opacity: .8, markSource: source };
const editProps = { item, pageWidth: 600, pageHeight: 800, disabled: false, onPreview: value => previews.push(value), onChange: value => { edits.push(value); editProps.item = value; } };
const renderHandles = renderer(handles.EditableMarkHandles, editProps);
let editing = renderHandles();
const node = index => editing.props.children[1][index];
node(0).props.onPointerDown(event(.1,.8)); node(0).props.onPointerMove(event(.2,.7)); editing = renderHandles();
assert.equal(edits.length, 0, 'Dragging nodes only previews until release');
assert.equal(previews.at(-1).markSource.geometry.points[0].x, .2);
node(0).props.onPointerUp(event(.2,.7)); editing = renderHandles();
assert.equal(edits.length, 1); near(edits[0].markSource.geometry.points[0].x,.2); assert.equal(previews.at(-1), null);
node(1).props.onPointerDown(event(.6,.2)); node(1).props.onPointerMove(event(.4,.4)); node(1).props.onPointerCancel(event(.4,.4)); editing = renderHandles();
assert.equal(edits.length, 1, 'Cancelled node drag leaves history unchanged');
editing.props.children[0].props.children[0].props.onDoubleClick(event(.4,.45)); editing = renderHandles();
assert.equal(edits.length, 2); assert.equal(edits[1].markSource.geometry.points.length, 4);
node(1).props.onDoubleClick(event(.4,.45)); editing = renderHandles();
assert.equal(edits.at(-1).markSource.geometry.points.length, 3, 'Nodes remain individually removable after insertion');
assert.equal(JSON.stringify(source), original, 'Path editing must keep prior source snapshots immutable');
const straight = { ...item, markSource: { ...source, geometry: { ...mark, tool: 'arrow', points: [points[0], points[2]] } } };
editProps.item = straight; editing = renderHandles(); editing.props.children[0].props.children[0].props.onDoubleClick(event(.5,.5)); editing = renderHandles();
assert.equal(edits.at(-1).markSource.geometry.tool, 'polyarrow');
assert.equal(edits.at(-1).markSource.geometry.points.length, 3, 'A new node on a straight arrow upgrades it to a bent arrow');
editProps.item = { ...item, id: 'callout', leaderFor: 'text', markSource: { ...source, geometry: { ...mark, tool: 'callout', arrowHeads: 'start' } } }; editing = renderHandles();
const before = edits.length;
node(2).props.onPointerDown(event(.9,.2)); node(2).props.onPointerMove(event(.7,.4)); node(2).props.onPointerUp(event(.7,.4)); node(2).props.onDoubleClick(event(.9,.2));
node(1).props.onDoubleClick(event(.6,.2)); editing = renderHandles();
assert.equal(edits.length, before, 'Linked callouts preserve their anchored endpoint and at least three nodes');
for(const key of ['Delete','Backspace','ArrowLeft','ArrowRight','ArrowUp','ArrowDown']){
  let prevented=false,stopped=false;node(2).props.onKeyDown({key,preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
  assert.ok(prevented&&stopped,'A fixed endpoint must not leak page deletion/navigation shortcuts');
}
node(1).props.onPointerDown(event(.6,.2));node(1).props.onPointerMove(event(.65,.4));editing=renderHandles();
near(previews.at(-1).markSource.geometry.points[1].y,.2);node(1).props.onPointerUp(event(.65,.4));editing=renderHandles();
near(edits.at(-1).markSource.geometry.points[1].y,.2);
editProps.disabled = true; assert.equal(renderHandles(), null);
editProps.disabled = false; editProps.item = { ...item, locked: true }; assert.equal(renderHandles(), null);
console.log('PASS: multi-node creation, Enter/double-click completion, Backspace/Escape/tool/busy cancellation, adjacent-segment arrowheads, stable transforms, solid arrow export, editable node drag/insert/delete, one commit per drag and linked/locked endpoint guards');
