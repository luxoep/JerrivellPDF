// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, require = () => {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require, document, Intl });
  return exports;
}
let paints = 0, encodes = 0, largestSurface = 0;
const document = { createElement() {
  const context = { font: '',
    measureText(text) { return { width: [...text].length * Number(this.font.match(/([\d.]+)px/)?.[1] ?? 24) * .6 }; },
    fillText() { paints++; }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  };
  let width = 0, height = 0;
  return { get width() { return width; }, set width(value) { width = value; largestSurface = Math.max(largestSurface, width * height); },
    get height() { return height; }, set height(value) { height = value; largestSurface = Math.max(largestSurface, width * height); },
    getContext: () => context, toDataURL() { encodes++; return `data:image/png;base64,${encodes}`; } };
} };
const geometry = load('../src/overlayGeometry.ts');
const canvas = load('../src/components/overlayCanvas.ts');
const frame = load('../src/textFrame.ts', name => {
  if (name === './overlayGeometry') return geometry;
  if (name === './components/overlayCanvas') return canvas;
  throw new Error(name);
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const initial = { id: 'text', assetId: 'previous', x: .1, y: .1, width: .5, height: .1, opacity: .7,
  textSource: { content: 'Flexible text frame with 中文内容 and exact font size', color: '#123456', fontSize: 12, bold: true, fontFamily: 'Arial',
    italic: true, charSpacing: .5, lineHeight: 1.45, alignment: 'center', frame: { width: 250, height: 70, autoHeight: true } } };
const before = JSON.stringify(initial);

// A width-only resize reflows; fonts/styles and the original undo snapshot stay unchanged.
const narrower = frame.resizeTextFrame(initial, { ...initial, width: .25 }, 500, 700);
assert.equal(narrower.textSource.fontSize, 12); assert.equal(narrower.textSource.italic, true);
assert.equal(narrower.textSource.frame.autoHeight, true); near(narrower.textSource.frame.width, 125);
const measured = frame.measureTextFrame(narrower, 500, 700);
assert.equal(paints, 0); assert.equal(encodes, 0); assert.equal(largestSurface, 1, 'Dragging must not allocate a full-size raster');
const wide = frame.measureTextFrame(initial, 500, 700);
assert.ok(measured.lineCount > wide.lineCount); assert.ok(measured.overlay.height > wide.overlay.height);
assert.equal(measured.overflow, false);
const rendered = frame.renderTextFrame(narrower, 500, 700);
near(rendered.overlay.width, measured.overlay.width); near(rendered.overlay.height, measured.overlay.height);
assert.equal(rendered.lineCount, measured.lineCount); assert.equal(encodes, 1);
assert.ok(paints > 0); assert.equal(rendered.overlay.textSource.fontSize, 12);
near(rendered.overlay.width * 500, rendered.width / 2); near(rendered.overlay.height * 700, rendered.height / 2);

// Explicitly shortening the height never shrinks the font. Overflow is a result
// the gesture commit must reject; its complete content remains in the model.
const short = frame.resizeTextFrame(initial, { ...initial, width: .25, height: .03 }, 500, 700);
assert.equal(short.textSource.frame.autoHeight, false);
const overflow = frame.measureTextFrame(short, 500, 700);
assert.equal(overflow.overflow, true); assert.ok(overflow.requiredHeight > short.textSource.frame.height);
assert.equal(overflow.overlay.textSource.content, initial.textSource.content); assert.equal(overflow.overlay.textSource.fontSize, 12);

// Rotated frames swap physical axes, so a visible width edit changes logical height.
const quarter = { ...initial, rotation: 90, width: .14, height: 250 / 700 };
const quarterMeasure = frame.measureTextFrame(quarter, 500, 700);
near(quarterMeasure.overlay.width * 500, quarterMeasure.height / 2);
near(quarterMeasure.overlay.height * 700, quarterMeasure.width / 2);
const quarterResize = frame.resizeTextFrame(quarter, { ...quarter, width: .2 }, 500, 700);
near(quarterResize.textSource.frame.height, 100); assert.equal(quarterResize.textSource.frame.autoHeight, false);

const offPage = frame.measureTextFrame({ ...initial, x: .9 }, 500, 700);
assert.equal(offPage.pageOverflow, true); assert.equal(offPage.overflow, true);
assert.equal(offPage.overlay.x, .9, 'Measurement must not hide overflow by moving the requested frame');
const legacy = frame.measureTextFrame({ ...initial, textSource: { ...initial.textSource, frame: undefined, wrapWidth: 120 } }, 500, 700);
assert.equal(legacy.overlay.textSource.fontSize, 12); assert.ok(legacy.overlay.textSource.frame);
assert.equal(JSON.stringify(initial), before, 'Text reflow leaves existing history entries untouched');
console.log('PASS: exact-size text reflow, width/height semantics, explicit overflow, rotated physical axes, immutable sources and measure-only drag without raster allocation or PNG encoding');
