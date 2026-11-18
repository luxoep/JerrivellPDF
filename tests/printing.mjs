// SPDX-License-Identifier: MIT OR Apache-2.0
// Compile actual TypeScript modules; fake only React scheduling/native I/O.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function load(relative, context = {}) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, Error, RangeError, console, ...context });
  return exports;
}
const ranges = await load('../src/pageRanges.ts');
const printing = await load('../src/printing.ts', {
  require(name) { if (name === './pageRanges') return ranges; throw new Error(name); },
});
const plain = value => JSON.parse(JSON.stringify(value));
const pages = Array.from({ length: 6 }, (_, index) => ({
  id: `workspace-${index}`, documentId: index % 2 ? 'second-pdf' : 'first-pdf',
  // Deliberately different and repeated original indices: UI filters must use
  // the workspace order, even after merging, duplicating and reordering pages.
  pageIndex: [12, 0, 12, 7, 0, 2][index], rotation: index === 2 ? 90 : 0,
  width: 595, height: 842, sourceName: 'demo.pdf',
  overlays: index === 4 ? [{ id: 'fragment', assetId: 'asset-3', x: .1, y: .2, width: .3, height: .1, opacity: .8, blendMode: 'multiply' }] : [],
}));
const choose = (scope = 'all', range = '', subset = 'all', reverse = false, selected = new Set(['workspace-1', 'workspace-4']), current = 4, input = pages) =>
  plain(printing.selectPrintIndices(input, current, selected, scope, range, subset, reverse));

assert.deepEqual(choose(), [0, 1, 2, 3, 4, 5]);
assert.deepEqual(choose('current'), [4]);
assert.deepEqual(choose('selected'), [1, 4]);
assert.deepEqual(choose('range', '6, 1-3，2'), [0, 1, 2, 5]);
assert.deepEqual(choose('all', '', 'odd'), [0, 2, 4]);
assert.deepEqual(choose('all', '', 'even', true), [5, 3, 1]);
assert.deepEqual(choose('selected', '', 'odd', true), [4]);
assert.deepEqual(choose('selected', '', 'even'), [1]);
assert.deepEqual(choose('range', '1-6', 'odd', true), [4, 2, 0]);
assert.deepEqual(choose('current', '', 'even'), []);
assert.deepEqual(choose('selected', '', 'all', false, new Set()), []);
assert.deepEqual(choose('selected', '', 'all', false, new Set(['stale-id'])), []);
assert.deepEqual(choose('current', '', 'all', false, new Set(), -1), []);
assert.deepEqual(choose('current', '', 'all', false, new Set(), 99), []);
assert.deepEqual(choose('all', '', 'all', false, new Set(), 0, []), []);
for (const [value, code] of [['', 'EMPTY'], ['0', 'BOUNDS'], ['7', 'BOUNDS'], ['4-2', 'ORDER'], ['1.5', 'FORMAT'], ['1,', 'FORMAT'], ['-1', 'FORMAT'], ['1'.repeat(1025), 'TOO_LONG']]) {
  assert.throws(() => choose('range', value), reason => reason.code === code);
}
assert.deepEqual(pages.map(page => page.pageIndex), [12, 0, 12, 7, 0, 2], 'Filtering/reversal must not mutate pages');
for (const [input, expected] of [['1', 1], ['99', 99], ['09', 9], ['0', null], ['100', null], ['', null], ['-1', null], ['1.5', null], ['1e2', null], [' 1', null], ['NaN', null], ['Infinity', null]]) {
  assert.equal(printing.validPrintCopies(input), expected, input);
}

let current;
const react = {
  useState(initial) {
    const host = current, slot = host.cursor++;
    if (!(slot in host.slots)) host.slots[slot] = typeof initial === 'function' ? initial() : initial;
    return [host.slots[slot], value => { host.slots[slot] = typeof value === 'function' ? value(host.slots[slot]) : value; }];
  },
  useRef(value) {
    const host = current, slot = host.cursor++;
    return host.slots[slot] ??= { current: value };
  },
  useMemo(factory, deps) {
    const host = current, slot = host.cursor++, previous = host.slots[slot];
    if (!previous || deps.some((value, index) => value !== previous.deps[index])) host.slots[slot] = { deps, value: factory() };
    return host.slots[slot].value;
  },
  useEffect(effect, deps) {
    const host = current, slot = host.cursor++, previous = host.effects[slot];
    if (!previous || deps.some((value, index) => value !== previous.deps[index])) host.pending.push(() => {
      previous?.cleanup?.(); host.effects[slot] = { deps, cleanup: effect() };
    });
  },
};
const renders = [], calls = [];
let printReply = () => Promise.resolve({ status: 'cancelled', pageCount: 0, copies: 1 });
const { PrintDialog } = await load('../src/components/PrintDialog.tsx', {
  document: { activeElement: null }, HTMLElement: class HTMLElement {},
  require(name) {
    if(name==='./PreviewZoom')return{PreviewZoom:'PreviewZoom'};if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'fragment' };
    if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => `icon-${String(key)}` });
    if (name === '../i18n') return { useI18n: () => ({ t: (zh, en) => en ?? zh }) };
    if (name === '../printing') return printing;
    if (name.endsWith('.css')) return {};
    if (name === '../backend') return {
      errorMessage: error => error.message ?? String(error),
      pageReference: ({ documentId, pageIndex, rotation, overlays }) => ({ documentId, pageIndex, rotation, ...(overlays?.length ? { overlays: overlays.map(item => ({ ...item })) } : {}) }),
      renderPage: (page, width) => new Promise((resolve, reject) => { renders.push({ page, width, resolve, reject }); }),
      backend: (command, args, priority) => { calls.push({ command, args, priority }); return printReply(); },
    };
    throw new Error(`Unexpected import: ${name}`);
  },
});
function mount(selectedIds = new Set()) {
  const host = { slots: [], effects: [], pending: [], cursor: 0, tree: null, busy: [], notices: [], closed: 0 };
  host.props = { pages, activeIndex: 4, selectedIds, title: 'Unicode 中文.pdf',
    onBusyChange: value => host.busy.push(value), onNotify: (...value) => host.notices.push(value), onClose: () => host.closed++ };
  host.render = () => {
    current = host; host.cursor = 0; host.pending = [];
    host.tree = PrintDialog(host.props);
    for (const effect of host.pending) effect();
    return host.tree;
  };
  host.unmount = () => { for (const effect of host.effects) effect?.cleanup?.(); };
  host.render(); return host;
}
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
function walk(node, predicate, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (Array.isArray(node)) { for (const child of node) walk(child, predicate, result); return result; }
  if (predicate(node)) result.push(node);
  walk(node.props?.children, predicate, result); return result;
}
function button(host, label) {
  const found = walk(host.tree, node => node.type === 'button' && text(node) === label);
  assert.equal(found.length, 1, `Expected one ${label} button`); return found[0];
}
function select(host, value, next) {
  const found = walk(host.tree, node => node.type === 'select' && node.props.value === value);
  // Some settings share 'all', so use the first matching select: page scope
  // appears before page subset in the actual component tree.
  assert.ok(found.length); found[0].props.onChange({ target: { value: next } }); host.render();
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// A slow old preview must not replace the currently requested workspace page.
let host = mount();
const oldPreview = renders.at(-1);
select(host, 'all', 'current');
const currentPreview = renders.at(-1);
assert.equal(currentPreview.page.id, 'workspace-4');
oldPreview.resolve({ dataUrl: 'old-page', width: 700, height: 990 }); await settle(); host.render();
assert.equal(walk(host.tree, node => node.type === 'img').length, 0);
currentPreview.resolve({ dataUrl: 'current-page', width: 700, height: 990 }); await settle(); host.render();
assert.equal(walk(host.tree, node => node.type === 'img')[0].props.src, 'current-page');

// Explicit paper/color are independent settings and change the preview without a native render.
const renderCount = renders.length;
const paperSetting = walk(host.tree, node => node.type === 'select' && node.props['aria-label'] === 'Paper size')[0];
paperSetting.props.onChange({target:{value:'a3'}});host.render();
const colorSetting = walk(host.tree, node => node.type === 'select' && node.props['aria-label'] === 'Print color')[0];
colorSetting.props.onChange({target:{value:'grayscale'}});host.render();
assert.equal(walk(host.tree,node=>node.type==='img')[0].props.style.filter,'grayscale(1)');
assert.equal(renders.length,renderCount,'Paper/color do not rerender the PDF for a preview');
// Native cancellation is normal, keeps the dialog open and releases busy once.
const beforeCalls = calls.length;
const pendingCancel = deferred(); printReply = () => pendingCancel.promise;
button(host, 'Choose printer and print').props.onClick();
button(host, 'Choose printer and print').props.onClick();
host.render();
assert.equal(calls.length, beforeCalls + 1, 'Double-click must submit only one native job');
assert.equal(button(host, 'Choose printer and print').props.disabled, true);
assert.deepEqual(host.busy, [true]);
assert.deepEqual(plain(calls.at(-1).args.pages), [{ documentId: 'first-pdf', pageIndex: 0, rotation: 0, overlays: pages[4].overlays }]);
assert.equal(calls.at(-1).args.options.copies, 1);
assert.equal(calls.at(-1).args.options.paperSize, 'a3');assert.equal(calls.at(-1).args.options.color, 'grayscale');
assert.equal(calls.at(-1).args.jobName, 'Unicode 中文.pdf');
let escapePrevented = 0, escapeStopped = 0;
walk(host.tree, node => node.props?.role === 'dialog')[0].props.onKeyDown({ key: 'Escape', preventDefault: () => escapePrevented++, stopPropagation: () => escapeStopped++ });
assert.equal(host.closed, 0, 'Escape cannot dismiss a live native job');
assert.equal(escapePrevented, 1); assert.equal(escapeStopped, 1);
pendingCancel.resolve({ status: 'cancelled', pageCount: 0, copies: 1 }); await settle(); host.render();
assert.deepEqual(host.busy, [true, false]);
assert.equal(host.closed, 0);
assert.equal(host.notices.at(-1)[1], 'info');
assert.equal(button(host, 'Choose printer and print').props.disabled, false);

// Native failure is retryable; no false success and no closed dialog.
printReply = async () => { throw new Error('printer unavailable'); };
button(host, 'Choose printer and print').props.onClick(); await settle(); host.render();
assert.deepEqual(host.busy, [true, false, true, false]);
assert.equal(host.closed, 0);
assert.ok(text(host.tree).includes('printer unavailable'));
assert.equal(host.notices.filter(value => value[1] === 'success').length, 0);

// Print success reports submission to Windows rather than physical output.
printReply = async () => ({ status: 'printed', pageCount: 1, copies: 1 });
button(host, 'Choose printer and print').props.onClick(); await settle(); host.render();
assert.equal(host.closed, 1);
assert.equal(host.notices.at(-1)[1], 'success');
assert.ok(host.notices.at(-1)[0].includes('Windows print queue'));
host.unmount();

// Empty custom input, invalid copies and an empty odd/even intersection disable
// submission rather than silently printing all pages.
host = mount(); select(host, 'all', 'range');
assert.equal(button(host, 'Choose printer and print').props.disabled, true);
let rangeInput = walk(host.tree, node => node.type === 'input' && node.props.placeholder === '1-3,5')[0];
rangeInput.props.onChange({ target: { value: '2,6' } }); host.render();
assert.equal(button(host, 'Choose printer and print').props.disabled, false);
const subsetSelect = walk(host.tree, node => node.type === 'select' && node.props.value === 'all')[0];
subsetSelect.props.onChange({ target: { value: 'odd' } }); host.render();
assert.equal(button(host, 'Choose printer and print').props.disabled, true);
assert.ok(text(host.tree).includes('No pages match these settings.'));
subsetSelect.props.onChange({ target: { value: 'all' } }); host.render();
const copiesInput = walk(host.tree, node => node.type === 'input' && node.props.type === 'number')[0];
copiesInput.props.onChange({ target: { value: '100' } }); host.render();
assert.equal(button(host, 'Choose printer and print').props.disabled, true);
copiesInput.props.onChange({ target: { value: '99' } }); host.render();
assert.equal(button(host, 'Choose printer and print').props.disabled, false);
host.unmount();

// The product cap is 10,000 output pages, independent of the 99-copy limit.
host = mount();
host.props.pages = Array.from({ length: 5000 }, (_, index) => ({ ...pages[index % pages.length], id: `cap-${index}` }));
host.render();
let capCopies = walk(host.tree, node => node.type === 'input' && node.props.type === 'number')[0];
capCopies.props.onChange({ target: { value: '2' } }); host.render();
assert.equal(button(host, 'Choose printer and print').props.disabled, false, 'Exactly 10,000 output pages is permitted');
capCopies.props.onChange({ target: { value: '3' } }); host.render();
assert.equal(button(host, 'Choose printer and print').props.disabled, true, 'Output above 10,000 pages must not submit');
host.props.pages = [...host.props.pages, { ...pages[0], id: 'cap-5000' }];
capCopies.props.onChange({ target: { value: '1' } }); host.render();
assert.equal(button(host, 'Choose printer and print').props.disabled, true, 'More than 5000 selected pages must not submit');
host.unmount();

// Unmounting during a native operation suppresses late UI success while still
// balancing the externally owned busy state exactly once.
host = mount(new Set(['workspace-1', 'workspace-4']));
const late = deferred(); printReply = () => late.promise;
button(host, 'Choose printer and print').props.onClick();
host.unmount(); late.resolve({ status: 'printed', pageCount: 2, copies: 1 }); await settle();
assert.deepEqual(host.busy, [true, false]);
assert.equal(host.notices.length, 0); assert.equal(host.closed, 0);

console.log('PASS: workspace print ranges, odd/even and reverse order, invalid input/copies, stale preview isolation, double-submit guard, native cancel/error/success, and unmount busy cleanup');
