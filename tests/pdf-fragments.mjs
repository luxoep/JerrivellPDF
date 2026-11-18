// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
async function load(path, require = () => {}) {
  const exports = {}; vm.runInNewContext(ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, require, crypto: { randomUUID } }); return exports;
}
const geometry = await load('../src/imageGeometry.ts'), overlay = await load('../src/overlayGeometry.ts');
const fragments = await load('../src/pdfFragments.ts', name => name === './imageGeometry' ? geometry : overlay);
const navigation = await load('../src/workspaceDocuments.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const regions = [{x:.1,y:.1,width:.2,height:.2}, geometry.selectionFromPoints([{x:.5,y:.2},{x:.8,y:.2},{x:.6,y:.6}], 'polygon')];
const union = geometry.selectionUnion(regions);
assert.deepEqual(plain(fragments.fragmentSelections(union, false)), plain(regions));
assert.deepEqual(plain(fragments.fragmentSelections(union, true)), [plain(union)]);
assert.deepEqual(plain(fragments.fragmentSelections(null, false)), [{x:0,y:0,width:1,height:1}]);
const item = index => ({id:`fragment-${index}`,key:`source-${index}`,name:`Region ${index}`,image:{id:`asset-${index}`,width:index===0?100:300,height:index===0?300:100,dataUrl:`data:image/png;base64,${index}`},blendMode:'multiply'});
const first = {...item(0),name:'Renamed by user'}, current = [first, item(1)];
const merged = fragments.mergeFragments(current, [item(0),item(2)]);
assert.equal(merged.length,3);assert.equal(merged[0],first);assert.equal(current.length,2);
assert.deepEqual(plain(fragments.moveFragment(merged,'fragment-2','fragment-0').map(item=>item.id)),['fragment-2','fragment-0','fragment-1']);
assert.deepEqual(plain(fragments.moveFragment(merged,'fragment-0','fragment-2',true).map(item=>item.id)),['fragment-1','fragment-2','fragment-0']);
assert.equal(fragments.moveFragment(merged,'missing','fragment-0'),merged);
assert.throws(()=>fragments.mergeFragments([],Array.from({length:49},(_,i)=>item(i))),/FRAGMENT_COUNT_LIMIT/);
const placed = fragments.fragmentOverlays(current,595,842,[],{x:0,y:1});
assert.equal(placed.length,2);assert.notEqual(placed[0].id,placed[1].id);
for(const overlay of placed){assert.equal(overlay.x,0);assert.ok(overlay.y+overlay.height<=1.000001);assert.equal(overlay.blendMode,'multiply');}
assert.ok(placed[0].height>placed[1].height);
assert.throws(()=>fragments.fragmentOverlays(current,595,842,Array.from({length:29},()=>placed[0])),/FRAGMENT_PAGE_LIMIT/);
assert.throws(()=>fragments.fragmentOverlays([{...item(0),image:{...item(0).image,width:5000,height:5000}}],595,842,[]),/FRAGMENT_PIXEL_LIMIT/);
const pages=[{id:'p1',documentId:'a',sourceName:'same.pdf'},{id:'p2',documentId:'b',sourceName:'same.pdf'},{id:'p3',documentId:'a',sourceName:'same.pdf'}];
assert.deepEqual(plain(navigation.workspaceDocuments(pages)),[{id:'a',name:'same.pdf',pages:2,firstPageId:'p1'},{id:'b',name:'same.pdf',pages:1,firstPageId:'p2'}]);
assert.equal(navigation.workspaceDocuments(pages.slice(1))[1].firstPageId,'p3');
assert.deepEqual(plain(navigation.workspaceDocuments([])),[]);
console.log('PASS: independent/combined/freeform fragments, tray identity/name preservation, reorder, atomic capacity, drop bounds and live multi-PDF names with identical filenames');
