// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function module(name,extra={}){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/compare/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,...extra});return exports;}
const {validateReport,detailBounds,optionsKey}=module('types');
const report={jobId:'test',options:{pageA:0,pageB:0,dpi:300,threshold:0,offsetXmm:0,offsetYmm:0,ignored:[]},widthPt:600,heightPt:800,originXPt:0,originYPt:0,pixelWidth:2500,pixelHeight:3333,changedPixels:1,ignoredPixels:0,uncovered:false,regions:[{id:1,bounds:{x:.9,y:.9,width:.001,height:.001},pixels:1,added:1,removed:0,changed:0,point:[.9,.9]}],mask:{dataUrl:'data:image/png;base64,OWN_TEST',width:600,height:800},tileCount:12};
assert.equal(validateReport(report,'test'),report,'A single pixel must remain a valid finding');
assert.equal(optionsKey(report.options),optionsKey(Object.fromEntries(Object.entries(report.options).reverse())),'Rust IPC property ordering cannot make a completed result stale');
assert.notEqual(optionsKey(report.options),optionsKey({...report.options,offsetXmm:1}));
for(const mutate of [r=>r.jobId='previous',r=>r.changedPixels=0,r=>r.regions[0].pixels=0,r=>r.regions[0].added=2,r=>r.regions.push({...r.regions[0]}),r=>r.regions[0].bounds.x=NaN,r=>r.regions[0].point=[2,0],r=>r.ignoredPixels=Number.MAX_SAFE_INTEGER,r=>r.mask.dataUrl='https://example.com/image.png',r=>r.pixelWidth=60001,r=>r.options.offsetXmm=Infinity,r=>r.options.ignored=Array(17).fill({x:0,y:0,width:1,height:1})]){const copy=structuredClone(report);mutate(copy);assert.throws(()=>validateReport(copy,'test'),/COMPARE_RESPONSE_INVALID/);}
for(const [x,y] of [[0,0],[.999,0],[0,.999],[.999,.999]]){const region={...report.regions[0],bounds:{x,y,width:.001,height:.001}};const rect=detailBounds(region,report);assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=1.000001&&rect.y+rect.height<=1.000001);assert.ok(rect.width>.025,'Tiny findings get readable detail crops');}
let resetEvents=0,rejectOld,held=false;const invoked=[];
const client=module('client',{Event,window:{dispatchEvent(){resetEvents++}},require(){return{invoke(command,args){invoked.push(command);if(command==='compare_reset')return Promise.resolve();if(held)return new Promise((_,reject)=>rejectOld=reject);return Promise.reject(Error('COMPARE_RESET: owned test'));}}}});
await assert.rejects(client.compareCall('preview'),/COMPARE_RESET/);assert.equal(resetEvents,1);
held=true;const old=client.compareCall('preview');await client.compareReset();rejectOld(Error('COMPARE_RESET: late reply'));await assert.rejects(old);assert.equal(resetEvents,1,'An old failed request cannot invalidate a replacement comparison');assert.ok(invoked.every(v=>v.startsWith('compare_')),'No main-editor commands are used');
const cap=JSON.parse(readFileSync(new URL('../src-tauri/capabilities/compare.json',import.meta.url),'utf8'));
assert.deepEqual(cap.windows,['compare']);assert.ok(!cap.permissions.some(p=>/allow-(open-document|print-document|save-document|destroy|register-pdf-integration)/.test(p)),'Comparison window cannot mutate, print or close the main workspace');
console.log('PASS: single-pixel report completeness, stale/malformed/foreign-image rejection, bounded detail crops, independent reset generations and comparison-only capabilities');
