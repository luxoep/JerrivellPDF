import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(relative, extra = {}) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, Error, RangeError, console, ...extra });
  return exports;
}
const ranges = load('../src/pageRanges.ts');
const parse = (...args) => Array.from(ranges.parsePageRange(...args));
assert.deepEqual(parse('5, 1-3，2; 7', 7), [0, 1, 2, 4, 6]);
assert.deepEqual(parse(' 1 - 3、5 ', 5), [0, 1, 2, 4]);
assert.deepEqual(parse('', 3, true), [0, 1, 2]);
assert.deepEqual(parse('5000', 5000), [4999]);
for (const [input, count, code] of [['', 3, 'EMPTY'], ['0', 3, 'BOUNDS'], ['4', 3, 'BOUNDS'], ['3-1', 3, 'ORDER'], ['1.5', 3, 'FORMAT'], ['1-x', 3, 'FORMAT'], ['1'.repeat(1025), 3, 'TOO_LONG']]) {
  assert.throws(() => parse(input, count), error => error.code === code);
}

const operations = load('../src/pageOperations.ts');
const page = { id: 'p', documentId: 'd', pageIndex: 0, rotation: 0, width: 600, height: 800, sourceName: 'example.pdf', overlays: [{ id: 'o', assetId: 'a', x: 0.2, y: 0.3, width: 0.4, height: 0.2, opacity: 0.7 }] };
const rotated = operations.rotatePageClockwise(page);
assert.equal(rotated.rotation, 90);
assert.equal(rotated.overlays[0].rotation, 90);
assert.ok(Math.abs(rotated.overlays[0].x - 0.5) < 1e-10);
assert.equal(rotated.overlays[0].y, 0.2);
assert.equal(rotated.overlays[0].width, 0.2);
assert.equal(rotated.overlays[0].height, 0.4);
assert.equal(page.rotation, 0); assert.equal(page.overlays[0].rotation, undefined);
const blended = operations.rotatePageClockwise({ ...page, overlays: [{ ...page.overlays[0], blendMode: 'multiply' }] });
assert.equal(blended.overlays[0].blendMode, 'multiply', 'Page rotation must preserve the fragment blend mode');
let full = page;
for (let i = 0; i < 4; i++) full = operations.rotatePageClockwise(full);
for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(full.overlays[0][key] - page.overlays[0][key]) < 1e-10, key);
assert.equal(full.rotation, 0); assert.equal(full.overlays[0].rotation, 0);
const edge = operations.rotatePageClockwise({ ...page, overlays: [{ ...page.overlays[0], y: 0.8, height: 0.2 }] });
assert.ok(edge.overlays[0].x >= 0);

// Original-content edits keep source identities while explicit screen-space
// bounds rotate with the page. Natural text size must remain unconstrained.
const originalPage = { ...page, contentEdits: [
  { objectIndex: 3, fingerprint: 'source', text: 'Revised', bounds: { x: .1, y: .2, width: .3, height: .15 } },
  { objectIndex: 5, fingerprint: 'text', text: 'Natural', fontSize: 20 },
] };
const originalRotated = operations.rotatePageClockwise(originalPage);
assert.equal(originalRotated.contentEdits[0].fingerprint, 'source');
assert.ok(Math.abs(originalRotated.contentEdits[0].bounds.x - .65) < 1e-10);
assert.equal(originalRotated.contentEdits[0].bounds.y, .1);
assert.equal(originalRotated.contentEdits[0].bounds.width, .15);
assert.equal(originalRotated.contentEdits[0].bounds.height, .3);
assert.equal(originalRotated.contentEdits[1].bounds, undefined);
originalRotated.contentEdits[0].bounds.x = .5;
assert.equal(originalPage.contentEdits[0].bounds.x, .1, 'Rotated bounds must not mutate history');
let originalFullTurn = originalPage;
for (let i = 0; i < 4; i++) originalFullTurn = operations.rotatePageClockwise(originalFullTurn);
for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(originalFullTurn.contentEdits[0].bounds[key] - originalPage.contentEdits[0].bounds[key]) < 1e-10, key);

const stored = new Map([['rivuleaf.language', 'en-US']]);
const i18n = load('../src/i18n.tsx', {
  localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
  require(name) {
    if (name === 'react') return { createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value, useState: initial => [initial, () => {}], useEffect: () => {} };
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) };
    throw new Error(name);
  },
});
assert.equal(i18n.translate('保存副本'), 'Save copy');
assert.equal(i18n.translate('第 12 页缩略图'), 'Page 12 thumbnail');
assert.equal(i18n.translate('文档第 2 页'), 'Document page 2');
assert.equal(i18n.translate('已保存 3 页 · 中文合同.pdf'), 'Saved 3 pages · 中文合同.pdf');
assert.equal(i18n.translate('中文合同.pdf'), '中文合同.pdf');
assert.equal(i18n.translate('custom', 'Custom translation'), 'Custom translation');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let translatedLabels = 0;
function walk(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
    const value = node.arguments[0].text;
    if (/[\u3400-\u9fff]/.test(value)) { assert.notEqual(i18n.translate(value), value, `Missing English label: ${value}`); translatedLabels++; }
  }
  ts.forEachChild(node, walk);
}
walk(ast);
const provider = i18n.I18nProvider({ children: null });
provider.props.value.setLanguage('zh-CN');
assert.equal(stored.get('rivuleaf.language'), 'zh-CN');
assert.equal(i18n.translate('保存副本'), '保存副本');
provider.props.value.setLanguage('en-US');
assert.equal(i18n.translate('保存副本'), 'Save copy');
console.log(`PASS: page ranges, immutable overlay rotation, language persistence and ${translatedLabels} translated UI labels`);
