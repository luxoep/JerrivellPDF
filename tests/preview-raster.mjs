// SPDX-License-Identifier: MIT OR Apache-2.0
// Exercise the real page-tool component, paint commands and ResizeObserver
// lifecycle. A clean source replacement must erase every preceding bitmap.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const frames = new Map(), resizeListeners = new Set(), observers = [];
let nextFrame = 0;
const host = { devicePixelRatio: 1.25,
  requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
  cancelAnimationFrame(id) { frames.delete(id); },
  addEventListener(type, callback) { assert.equal(type, 'resize'); resizeListeners.add(callback); },
  removeEventListener(type, callback) { assert.equal(type, 'resize'); resizeListeners.delete(callback); },
};
class ResizeObserver {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe(target) { this.target = target; }
  disconnect() { this.disconnected = true; }
}
function load(path, require = () => {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require, ResizeObserver, window: host });
  return exports;
}
const raster = load('../src/previewRaster.ts');
const calls = [], context = {
  setTransform(...args) { calls.push(['transform', ...args]); },
  clearRect(...args) { calls.push(['clear', ...args]); },
  fillRect(...args) { calls.push(['fill', this.fillStyle, ...args]); },
  drawImage(...args) { calls.push(['draw', ...args]); },
};
let bounds = { width: 398.285714, height: 563.428571 };
const canvas = { width: 0, height: 0, ownerDocument: { defaultView: host },
  getBoundingClientRect: () => bounds,
  getContext(type) { assert.equal(type, '2d'); return context; },
};
const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
const first = { src: 'decoded-page-before' }, second = { src: 'decoded-page-after' };
let destroy = raster.createPreviewRasterPainter(canvas, first);
assert.equal(frames.size, 1);
for (let n = 0; n < 50; n++) observers.at(-1).callback();
assert.equal(frames.size, 1, 'Repeated layout observations coalesce into one local paint');
flush();
assert.equal(canvas.width, 498); assert.equal(canvas.height, 704);
assert.deepEqual(calls.map(call => call[0]), ['transform', 'clear', 'fill', 'draw']);
assert.equal(calls.at(-1)[1], first);
assert.equal(context.imageSmoothingQuality, 'high');
assert.equal(context.imageSmoothingEnabled, true);

// The same canvas is reused. A changed page clears old content even when its
// backing dimensions did not change, and never leaves two raster DOM layers.
destroy(); calls.length = 0;
destroy = raster.createPreviewRasterPainter(canvas, second); flush();
assert.deepEqual(calls.map(call => call[0]), ['transform', 'clear', 'fill', 'draw']);
assert.equal(calls.at(-1)[1], second);
assert.deepEqual(calls[1], ['clear', 0, 0, 498, 704]);

// A zoom changes displayed bounds only; the decoded source remains identical.
bounds = { width: 799.5, height: 1131.25 };
observers.at(-1).callback(); flush();
assert.equal(canvas.width, 999); assert.equal(canvas.height, 1414);
assert.equal(calls.at(-1)[1], second);
host.devicePixelRatio = 2; for (const callback of resizeListeners) callback(); flush();
assert.equal(canvas.width, 1599); assert.equal(canvas.height, 2263);
bounds = { width: 10000, height: 14000 }; observers.at(-1).callback(); flush();
assert.equal(canvas.height, 4096); assert.ok(canvas.width <= 4096);
observers.at(-1).callback(); assert.equal(frames.size, 1); destroy();
assert.equal(frames.size, 0); assert.equal(resizeListeners.size, 0);
assert.ok(observers.every(observer => observer.disconnected));

// Mount the production canvas component instead of duplicating its lifecycle.
const effects = []; let ref;
const react = { useRef(value) { return ref = { current: value }; }, useEffect(callback) { effects.push(callback); } };
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const tool = load('../src/components/PageToolPreview.tsx', name => {
  if (name === 'react') return react;
  if (name === 'react/jsx-runtime') return jsx;
  if (name === '../previewRaster') return raster;
  if (name === 'lucide-react' || name === '../backend' || name === '../viewerGeometry' || name === '../i18n' || name === './MarkLayer' || name === './PreviewZoom') return {};
  throw new Error(name);
});
const tree = tool.PageToolRaster({ source: second, label: 'Result page preview' });
assert.equal(tree.type, 'canvas'); assert.equal(tree.props.role, 'img');
assert.equal(tree.props['aria-label'], 'Result page preview');
assert.equal(tree.props.children, undefined, 'There is no image underneath the canvas');
ref.current = canvas;
const cleanup = effects[0](); assert.equal(frames.size, 1); flush();
assert.equal(calls.at(-1)[1], second); cleanup();
assert.equal(frames.size, 0); assert.equal(resizeListeners.size, 0);
console.log('PASS: production canvas mount, a single raster layer, exact displayed device resolution, high-quality local scaling, clear-before-replace, one frame per burst, DPR changes, bounded zoom memory, and full cleanup');

// Opening animations must not make the PDF surface translucent or move it.
const polish = readFileSync(new URL('../src/ui-polish.css', import.meta.url), 'utf8');
for (const name of ['jerrivell-overlay-enter', 'jerrivell-dialog-enter']) {
  const start = polish.indexOf(`@keyframes ${name}`);
  assert.ok(start >= 0);
  const end = polish.indexOf('\n}', start) + 2;
  const frames = polish.slice(start, end);
  assert.ok(!/opacity\s*:|transform\s*:|filter\s*:/.test(frames), `${name}: no translucent/moving/blurred PDF surface at any frame`);
}
assert.ok(!polish.includes('jerrivell-preview-enter'), 'No separate whole-preview opacity fade');
console.log('PASS: production dialog animations keep every PDF surface opaque and stationary');
