// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

let draws = [], strokes = [], point = null, font = '', loads = [];
const context = {
  set font(value) { font = value; }, get font() { return font; },
  measureText: text => ({ width: Array.from(text).length * 12 }),
  fillText: (text, x, y) => draws.push({ text, x, y, font }),
  beginPath() {}, moveTo(x, y) { point = [x, y]; },
  lineTo(x, y) { strokes.push([point, [x, y]]); }, stroke() {},
};
const document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,AA==' }),
  fonts: { load: async (...args) => { loads.push(args); return []; } },
};
const module = {};
vm.runInNewContext(ts.transpileModule(await readFile(new URL('../src/components/overlayCanvas.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: module, document, Intl, setTimeout, clearTimeout });
const render = (text, options = {}) => { draws = []; strokes = []; return module.createTextPng(text, '#123456', 12, true, 'Arial', options); };

const natural = render('ABCD\nEF');
assert.equal(natural.lineCount, 2);
assert.deepEqual(draws.map(draw => draw.text), ['ABCD', 'EF']);
assert.ok(draws.every(draw => draw.font === '600 24px "Arial", sans-serif'), 'Requested size stays exact; no automatic font shrinking');
const leftX = draws[1].x;
render('ABCD\nEF', { alignment: 'center', lineHeight: 2, italic: true, underline: true, strikeout: true });
assert.equal(draws[1].x, leftX + 12);
assert.equal(draws[1].y - draws[0].y, 48);
assert.ok(draws.every(draw => draw.font.startsWith('italic 600 24px')));
assert.equal(strokes.length, 4);
assert.equal(strokes[0][1][0] - strokes[0][0][0], 48);
render('ABCD\nEF', { alignment: 'right' });
assert.equal(draws[1].x, leftX + 24);

const wrapped = render('one two three\n中文测试文字\n\nnext', { wrapWidth: 30 });
assert.ok(wrapped.lineCount > 4);
assert.equal(draws.map(draw => draw.text).join(''), 'one two three中文测试文字next', 'Wrapping preserves every character and explicit blank lines');
assert.ok(draws.some(draw => draw.text === ''));
render('A👩‍💻B', { charSpacing: 2 });
assert.deepEqual(draws.map(draw => draw.text), ['A', '👩‍💻', 'B'], 'Spacing preserves grapheme clusters');
assert.equal(draws[1].x - draws[0].x, 16);
const moreThanOldLimit = render(Array.from({ length: 21 }, () => 'Line').join('\n'));
assert.equal(moreThanOldLimit.lineCount, 21, 'Old twenty-line silent truncation is removed');
for (const [text, options] of [['X'.repeat(4001), {}], ['AB', { wrapWidth: 1 }], ['A', { lineHeight: NaN }], [Array(82).fill('X').join('\n'), {}]]) {
  assert.throws(() => render(text, options), /TEXT_LAYOUT_LIMIT/);
}
await module.ensureFontReady('Arial', 'Italic', true, true);
assert.equal(loads[0][0], 'italic 600 24px "Arial", sans-serif');
console.log('PASS: multiline wrapping, alignment, leading, grapheme spacing, real canvas styles, exact point size and explicit overflow limits');
