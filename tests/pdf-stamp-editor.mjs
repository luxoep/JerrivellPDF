// SPDX-License-Identifier: MIT OR Apache-2.0
// Actual editor state and geometry, with only React scheduling and native I/O stubbed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(await readFile(new URL('../src/components/OverlayEditor.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const geometry = {};
const imageGeometry = {};
vm.runInNewContext(ts.transpileModule(await readFile(new URL('../src/imageGeometry.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: imageGeometry });
vm.runInNewContext(ts.transpileModule(await readFile(new URL('../src/overlayGeometry.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: geometry });
const fragments = {}; vm.runInNewContext(ts.transpileModule(await readFile(new URL('../src/pdfFragments.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: fragments, require: name => name === './imageGeometry' ? imageGeometry : geometry, crypto: {randomUUID:()=>`fragment-${++ids}`} });
let current;
let library = [];
let calls = [];
let defer;
let ids = 0;
const busy = [];
const changes = [];
const errors = [];
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
const numbers = {}; vm.runInNewContext(ts.transpileModule(await readFile(new URL('../src/useNumberDraft.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: numbers, require: () => react });
const exports = {};
class LibraryError extends Error { constructor(code) { super(code); this.code = code; } }
const png = 'data:image/png;base64,demo';
vm.runInNewContext(compiled, {
  exports, console, crypto: { randomUUID: () => `generated-${++ids}` },
  require(name) {
    if(name==='./FragmentTray')return{FragmentTray:'FragmentTray'}; if(name==='../pdfFragments')return fragments;
    if (name === '../imageGeometry') return imageGeometry;
    if (name === './ImageEditDialog') return {ImageEditDialog:'ImageEditDialog'};
  if (name === './RegionSelection') return {RegionSelection:'RegionSelection'};
  if (name === '../useFragmentPreview') return {useFragmentPreview:()=>({image:null,error:''})};
  if(name==='./PreviewZoom')return{PreviewZoom:'PreviewZoom'};if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'fragment' };
    if (name === '@tauri-apps/plugin-dialog') return { open: async () => 'C:\\demo.pdf', save: async () => null };
    if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => `icon-${String(key)}` });
    if (name === '../i18n') return { useI18n: () => ({ t: (zh, en) => en ?? zh }) };
    if (name === '../backend') return {
      isDesktop: () => true, errorMessage: error => error.message,
      backend: async (command, args) => {
        calls.push({ command, args });
        if (defer) await defer.promise;
        if (command === 'create_image_fragments') return args.crops.map((crop,index)=>({id:`asset-${calls.length}-${index}`,dataUrl:png+JSON.stringify(crop),width:Math.max(1,Math.round(1000*crop.width)),height:Math.max(1,Math.round(1400*crop.height))}));
        return { id: `asset-${calls.length}`, dataUrl: png, width: 1000, height: 1400, pageCount: 3 };
      },
    };
    if (name === '../stampLibrary') return {
      cleanLibraryName: value => value.trim(), LibraryError, MAX_LIBRARY_ITEMS: 20,
      loadStampLibrary: () => library, saveStampLibrary: items => { library = items; }, pngFileName: value => value + '.png',
    };
    if (name === './overlayCanvas') return { DEFAULT_FONT_FAMILY: 'Microsoft YaHei UI', ensureFontReady: async () => {} };
    if (name === './FontPicker') return { FontPicker: 'FontPicker' };
    if (name === 'react-dom') return { flushSync: callback => callback() };
    if (name === '../overlayGeometry') return geometry;
    if (name === '../textFrame') return {};
    if (name === '../useNumberDraft') return numbers;
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected import: ${name}`);
  },
});
const { OverlayEditor, pdfStampCropFromPoints, pdfStampSourceKey, pdfStampPreviewKey } = exports;
const plain = value => JSON.parse(JSON.stringify(value));
assert.deepEqual(plain(pdfStampCropFromPoints({ x: .8, y: .9 }, { x: .2, y: .3 })), { x: .2, y: .3, width: .6000000000000001, height: .6000000000000001 });
assert.deepEqual(plain(pdfStampCropFromPoints({ x: -.5, y: 2 }, { x: 2, y: -1 })), { x: 0, y: 0, width: 1, height: 1 });
assert.equal(pdfStampCropFromPoints({ x: .1, y: .1 }, { x: .101, y: .101 }), null);
assert.equal(pdfStampCropFromPoints({ x: NaN, y: .1 }, { x: .8, y: .5 }), null);
assert.equal(pdfStampSourceKey('a', '01'), pdfStampSourceKey('a', '1'));
assert.notEqual(pdfStampPreviewKey('a', '1', null, false, true), pdfStampPreviewKey('a', '1', null, true, true));

const props = {
  pageWidth: 595, pageHeight: 842, overlays: [], disabled: false,
  onChange: next => { props.overlays = next; changes.push(next); },
  onError: value => errors.push(value), onClose() {}, onBusyChange: value => busy.push(value),
};
const host = { slots: [], effects: [], pending: [], cursor: 0, tree: null };
function render() {
  current = host; host.cursor = 0; host.pending = [];
  host.tree = OverlayEditor(props);
  for (const effect of host.pending) effect();
  return host.tree;
}
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
function walk(node, predicate, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (Array.isArray(node)) { for (const child of node) walk(child, predicate, result); return result; }
  if (predicate(node)) result.push(node);
  walk(node.props?.children, predicate, result); return result;
}
function button(label) {
  const result = walk(host.tree, node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
  assert.equal(result.length, 1, `Expected one button ${label}`); return result[0];
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function click(label) { button(label).props.onClick(); await settle(); render(); }
render(); await click('Stamp'); await click('PDF fragment');
await click('Choose source PDF');
assert.equal(calls.length, 1);
assert.deepEqual(plain(calls[0]), { command: 'import_pdf_stamp', args: { path: 'C:\\demo.pdf', pageIndex: 0, crop: null, removeWhiteBackground: false, trimTransparentMargins: false } });
const selection=()=>walk(host.tree,node=>node.type?.name==='PdfStampSelection')[0];
const crop = { x: .2, y: .3, width: .4, height: .2 }, second={x:.7,y:.1,width:.2,height:.1};
selection().props.onChange(imageGeometry.selectionUnion([crop,second]));render();
assert.equal(calls.length,1,'Selection previews never reopen PDFs or consume native assets');
assert.equal(walk(host.tree,node=>node.type?.name==='PdfFragmentPreview').length,2);
await click('Insert each fragment');
assert.equal(props.overlays.length,2);assert.equal(changes.length,1,'A multi-insert is one undoable commit');
assert.ok(props.overlays.every(item=>item.blendMode==='multiply'));assert.notEqual(props.overlays[0].id,props.overlays[1].id);
assert.deepEqual(plain(calls.at(-1).args.crops),[crop,second]);assert.equal(calls.at(-1).command,'create_image_fragments');
assert.equal(calls.filter(call=>call.command==='import_pdf_stamp').length,1);
let tray=walk(host.tree,node=>node.type==='FragmentTray')[0];assert.equal(tray.props.items.length,2,'Generated items remain after modal closes');
assert.notEqual(tray.props.items[0].image.width,tray.props.items[1].image.width);
await click('Open PDF fragment workspace');await click('Create fragment list');
tray=walk(host.tree,node=>node.type==='FragmentTray')[0];assert.equal(tray.props.items.length,2,'Repeated generation preserves the same tray items');
await click('Open PDF fragment workspace');
const combine=walk(host.tree,node=>node.type==='label'&&text(node).includes('Combine regions into one item'))[0];
walk(combine,node=>node.type==='input')[0].props.onChange({target:{checked:true}});render();
assert.equal(walk(host.tree,node=>node.type?.name==='PdfFragmentPreview').length,1);
await click('Insert each fragment');assert.equal(props.overlays.length,3);assert.equal(calls.at(-1).args.crops.length,1);assert.equal(calls.at(-1).args.crops[0].regions.length,2);
await click('Open PDF fragment workspace');
walk(host.tree,node=>node.type==='label'&&text(node).includes('Combine regions into one item'))[0].props.children[0].props.onChange({target:{checked:false}});render();
selection().props.onChange({...crop,x:.1});render();
const white=walk(host.tree,node=>node.type==='label'&&text(node).includes('Make near-white transparent'))[0];
walk(white,node=>node.type==='input')[0].props.onChange({target:{checked:true}});render();
await click('Save to library');assert.equal(library.length,1);assert.equal(library[0].blendMode,'multiply');assert.ok(!('assetId'in library[0]));
assert.equal(calls.at(-1).args.removeWhiteBackground,true);assert.equal(calls.at(-1).args.crops[0].x,.1);
walk(host.tree,node=>node.type==='input'&&node.props['aria-label']==='PDF fragment source page')[0].props.onChange({target:{value:'2'}});render();
assert.equal(button('Insert each fragment').props.disabled,true);assert.equal(button('Create fragment list').props.disabled,true);
await click('Load page');assert.equal(calls.at(-1).args.pageIndex,1);assert.equal(calls.at(-1).args.crop,null);
await click('Create fragment list');assert.deepEqual(plain(calls.at(-1).args.crops),[{x:0,y:0,width:1,height:1}]);
const existing=props.overlays;props.overlays=Array.from({length:30},(_,n)=>({...existing[0],id:`full-${n}`}));render();
await click('Open PDF fragment workspace');const count=calls.length;await click('Insert each fragment');
assert.equal(calls.length,count,'Capacity must be checked before native generation');assert.equal(props.overlays.length,30);assert.ok(errors.pop().includes('30'));
props.overlays=existing;render();await click('Close fragment workspace');await click('Library');await click('Place');
assert.equal(props.overlays.at(-1).blendMode,'multiply');assert.equal(errors.length,0);
assert.ok(busy.every((value,index)=>value===(index%2===0)),'Every async operation releases busy once');
// A late native result must not change the tray or workspace after unmount.
await click('Stamp');await click('Open PDF fragment workspace');
defer={};defer.promise=new Promise(resolve=>{defer.resolve=resolve;});
button('Create fragment list').props.onClick();const busyStart=busy.length,changeCount=changes.length;
for(const effect of host.effects)effect?.cleanup?.();defer.resolve();await settle();
assert.equal(busy.length,busyStart+1);assert.equal(busy.at(-1),false);assert.equal(changes.length,changeCount);
console.log('PASS: independent multi-fragment crops/previews, atomic insert, persistent tray/dedup, explicit union, whole-page/page-switch guards, library blend, capacity and late-result protection');
