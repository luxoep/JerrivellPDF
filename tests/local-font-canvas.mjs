// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const fonts = [], draws = [], loads = [];
const context = {
  set font(value) { fonts.push(value); },
  get font() { return fonts.at(-1); },
  measureText: text => ({ width: text.length * 20 }),
  fillText: (...args) => draws.push(args),
  beginPath() {}, arc() {}, stroke() {}, strokeRect() {}, fill() {}, moveTo() {}, lineTo() {}, closePath() {}, save() {}, restore() {}, translate() {}, rotate() {},
};
const document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,AA==' }),
  fonts: { load: async (...args) => { loads.push(args); return []; } },
};
const output = {};
vm.runInNewContext(ts.transpileModule(await readFile(new URL('../src/components/overlayCanvas.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: output, document, setTimeout, clearTimeout });
const { cssFontFamily, createTextPng, createStampPng, ensureFontReady } = output;
assert.equal(cssFontFamily('仿宋'), '"仿宋", sans-serif');
assert.equal(cssFontFamily('Quoted "Font"'), '"Quoted \\"Font\\"", sans-serif');
assert.equal(cssFontFamily('\n\r'), '"Microsoft YaHei UI", sans-serif');
await ensureFontReady('仿宋', '中文 TEST', true);
assert.equal(loads.length, 1);
assert.equal(loads[0][0], '600 24px "仿宋", sans-serif');
assert.equal(loads[0][1], '中文 TEST');
createTextPng('第一行\nSecond line', '#222222', 18, false, '楷体');
assert.ok(fonts.every(value => value.includes('"楷体"')));
assert.deepEqual(draws.map(args => args[0]), ['第一行', 'Second line']);
fonts.length = 0; draws.length = 0;
createStampPng('本机文字图章', 'TEST', '#b00000', 'round', '仿宋');
assert.ok(fonts.length && fonts.every(value => value.includes('"仿宋"')));
fonts.length = 0;
createStampPng('Custom stamp', 'TEST', '#b00000', 'rectangle', 'Times New Roman');
assert.ok(fonts.length && fonts.every(value => value.includes('"Times New Roman"')));
console.log('PASS: safe local-family quoting, font readiness, text/multiline drawing and both stamp layouts use the selected family');
