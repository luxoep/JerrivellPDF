// SPDX-License-Identifier: MIT OR Apache-2.0
// Native comparison, independent main PDF worker, cancellation and source safety.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {drawing,pdfObjects,rasterDrawing,formDrawing} from './compare-fixtures.mjs';
const root=process.cwd(),version=JSON.parse(await readFile('package.json','utf8')).version;
const exe=path.resolve(process.argv[2]??'src-tauri/target/debug/jerrivell-pdf.exe'),dll=path.resolve(process.argv[3]??'src-tauri/resources/pdfium/bin/pdfium.dll');
const out=path.resolve(process.argv[4]??`test-results/${version}/compare-native-${Date.now()}`);await mkdir(out,{recursive:true});
function worker(flag){const child=spawn(exe,[flag,'--pdfium-path',dll],{stdio:['pipe','pipe','pipe'],windowsHide:true});const pending=new Map(),states=new Map();let id=0,stderr='';child.stderr.on('data',value=>stderr+=value);const lines=createInterface({input:child.stdout});lines.on('line',line=>{const reply=JSON.parse(line);if(reply.progress)states.set(reply.progress.jobId,reply.progress);const p=pending.get(reply.id);if(p){pending.delete(reply.id);clearTimeout(p.timer);reply.error?p.reject(Error(reply.error)):p.resolve(reply.result)}});child.on('exit',code=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error(`worker exited ${code}; ${stderr}`))}pending.clear()});return{child,states,call(command,args={}){return new Promise((resolve,reject)=>{const request=++id;const timer=setTimeout(()=>{pending.delete(request);reject(Error('native comparison timed out'))},120000);pending.set(request,{resolve,reject,timer});child.stdin.write(JSON.stringify({id:request,command,args})+'\n')})},close(){child.stdin.end();child.kill()}}}
const compare=worker('--compare-worker'),main=worker('--pdf-worker'),checks=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
const original=drawing(),modified=drawing({changed:true});const old=path.join(out,'Original 中文 old.pdf'),newer=path.join(out,'New drawing.pdf');await writeFile(old,original);await writeFile(newer,modified);
const options={pageA:0,pageB:0,dpi:150,threshold:0,offsetXmm:0,offsetYmm:0,ignored:[]};
async function waitJob(id, client = compare){const end=Date.now()+120000;while(Date.now()<end){const p=client.states.get(id);if(p&&p.status!=='running')return p;await new Promise(r=>setTimeout(r,25))}throw Error('job timed out')}
async function run(input, client = compare){const jobId=randomUUID();await client.call('start',{jobId,options:input});const state=await waitJob(jobId, client);assert.equal(state.status,'complete',state.error);return state.report}

function assertSameRegion(actual, expected) {
 const {bounds, point, ...counts} = actual;
 const {bounds: expectedBounds, point: expectedPoint, ...expectedCounts} = expected;
 assert.deepEqual(counts, expectedCounts);
 // Serializing and parsing JSON can shift a floating-point value by a rounding unit.
 // This margin is many orders of magnitude smaller than a pixel in the analysis.
 for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(bounds[key] - expectedBounds[key]) <= 1e-10, key);
 for (let index = 0; index < 2; index++) assert.ok(Math.abs(point[index] - expectedPoint[index]) <= 1e-10);
}

function assertSameReview(actual, expected) {
 assert.equal(actual.length, expected.length);
 actual.forEach((entry, index) => {
  assert.equal(entry.reviewed, expected[index].reviewed);
  assert.equal(entry.note, expected[index].note);
  assertSameRegion(entry.region, expected[index].region);
 });
}

async function reviewProjectRoundTrip() {
 const opts = {...options, scaleMode:'normalized', offsetXmm:.125, ignored:[{x:0,y:0,width:.01,height:.01}]};
 const report = await run(opts);
 assert.ok(report.regions.length >= 2);
 const project = path.join(out, '图纸复核.jvcmp');
 const selectedRegion = report.regions[0];
 const review = [{region:selectedRegion, reviewed:true, note:'已核对孔位与公差'},
  {region:report.regions[1], reviewed:false, note:'待核对新版'}];
 const save = {path:project, options:opts, jobId:report.jobId,
  review:review.map(({region, reviewed, note}) => ({regionId:region.id, reviewed, note})),
  selectedRegionId:selectedRegion.id};
 const receipt = await compare.call('save_project', save);
 const saved = await readFile(project);
 assert.equal(receipt.fileName, path.basename(project));
 assert.equal(receipt.bytes, saved.length);
 assert.ok(saved.toString('utf8').includes(hash(original)));
 assert.ok(saved.toString('utf8').includes(hash(modified)));
 assert.ok(!saved.includes('%PDF-') && !saved.includes('data:image'));
 await assert.rejects(compare.call('save_project',save), /PROJECT_EXISTS/);
 assert.deepEqual(await readFile(project), saved);
 await assert.rejects(compare.call('save_project',{...save, jobId:randomUUID(), overwrite:true}));
 assert.deepEqual(await readFile(project), saved);
 const resumed = worker('--compare-worker');
 try {
  const result = await resumed.call('open_project',{path:project});
  assert.deepEqual(result.options, opts);
  assert.equal(result.a.fileName,path.basename(old));
  assert.equal(result.b.fileName,path.basename(newer));
  assertSameReview(result.review, review);
  assertSameRegion(result.selectedRegion, selectedRegion);
  const repeated = await run(result.options,resumed);
  assert.deepEqual(repeated.regions,report.regions);
  await writeFile(newer,original);
  try {
   await assert.rejects(resumed.call('open_project',{path:project}), /PROJECT_SOURCE_B_CHANGED/);
   const retained = path.join(out, 'retained-after-project-error.csv');
   await resumed.call('export',{jobId:repeated.jobId,path:retained,kind:'csv',reviewed:[selectedRegion.id]});
   assert.ok((await readFile(retained)).length > 150);
   const moved = path.join(out, 'Relocated new drawing.pdf');
   await writeFile(moved,modified);
   const relocated = await resumed.call('open_project',{path:project,sourceBPath:moved});
   assert.equal(relocated.b.fileName,path.basename(moved));
   assertSameReview(relocated.review,review);
  } finally {
   await writeFile(newer,modified);
  }
 } finally {
  resumed.close();
 }
 assert.equal(hash(await readFile(old)),hash(original));
 assert.equal(hash(await readFile(newer)),hash(modified));
 checks.push('review project round trip in a fresh worker, fingerprints and notes, changed source rejected, identical relocation, old work preserved on failed open');
}
let result;
try{
 const source=await main.call('open_document',{path:old});const nativePage={documentId:source.id,pageIndex:0,rotation:0};
 await compare.call('open',{side:'a',path:old});await compare.call('open',{side:'b',path:old});let r=await run(options);assert.equal(r.changedPixels,0);assert.equal(r.regions.length,0);checks.push('identical mechanical drawing / tiled strict zero');
 await compare.call('open',{side:'b',path:newer});r=await run(options);assert.ok(r.changedPixels>10);assert.ok(r.regions.some(v=>v.pixels<20),'small dot survives');assert.ok(r.regions.length>=3);assert.equal(r.regions.reduce((n,v)=>n+v.pixels,0),r.changedPixels);checks.push('hole shift, dimension text, tiny dot and added line / complete component counts');
 const {mask,...reportMetadata}=r;await writeFile(path.join(out,'report-metadata.json'),JSON.stringify(reportMetadata,null,2));
 const preview=await compare.call('preview',{options,width:1000});assert.equal(preview.a.width,preview.b.width);assert.equal(preview.a.height,preview.b.height);assert.notEqual(preview.a.dataUrl,preview.b.dataUrl);checks.push('synchronized same-scale previews');
 const detail=await compare.call('preview',{options,width:640,rect:r.regions[0].bounds});assert.ok(detail.a.width>0);checks.push('native local detail rendering');
 await compare.call('export',{jobId:r.jobId,path:path.join(out,'report.png'),kind:'png',reviewed:[]});await compare.call('export',{jobId:r.jobId,path:path.join(out,'report.csv'),kind:'csv',reviewed:[r.regions[0].id]});assert.ok((await readFile(path.join(out,'report.png'))).length>100);await assert.rejects(compare.call('export',{jobId:r.jobId,path:path.join(out,'report.csv'),kind:'csv'}),/新文件名|覆盖/);await assert.rejects(compare.call('export',{jobId:r.jobId,path:old,kind:'png'}));checks.push('local PNG/CSV, review list, no overwrite');
 await reviewProjectRoundTrip();
 const excluded=await run({...options,ignored:[{x:0,y:0,width:1,height:1}]});assert.equal(excluded.changedPixels,0);assert.ok(excluded.ignoredPixels>0);checks.push('explicit ignored areas / qualified zero');
 await writeFile(newer,drawing({shift:12}));await compare.call('open',{side:'b',path:newer});const aligned=await run({...options,offsetXmm:-12*25.4/72,threshold:16});assert.equal(aligned.changedPixels,0);assert.equal(aligned.uncovered,true);checks.push('manual translation at explicit AA tolerance 16 keeps scale and marks uncovered paper');
 await writeFile(newer,pdfObjects('BT /F1 12 Tf 50 60 Td (ROTATED) Tj ET',400,200,90,true));await compare.call('open',{side:'a',path:newer});await compare.call('open',{side:'b',path:newer});assert.equal((await run(options)).changedPixels,0);checks.push('intrinsic rotation and CropBox');
 for(const [name,make] of [['scanned image',rasterDrawing],['AcroForm appearance',formDrawing]]){const fa=path.join(out,`${name}-a.pdf`),fb=path.join(out,`${name}-b.pdf`);await writeFile(fa,make(false));await writeFile(fb,make(true));await compare.call('open',{side:'a',path:fa});await compare.call('open',{side:'b',path:fa});assert.equal((await run(options)).changedPixels,0);await compare.call('open',{side:'b',path:fb});assert.ok((await run(options)).changedPixels>0,`${name} visible changes must be rendered`);checks.push(`${name} strict self zero and controlled visible change`)}
 // Cancellation is read on a control thread, not queued behind the long job.
 const huge=path.join(out,'A0 original.pdf');await writeFile(huge,drawing({width:2384,height:3370}));await compare.call('open',{side:'a',path:huge});await compare.call('open',{side:'b',path:huge});const cancelId=randomUUID();await compare.call('start',{jobId:cancelId,options:{...options,dpi:300}});const start=Date.now();const accepted=await compare.call('cancel',{jobId:cancelId});assert.equal(accepted.accepted,true);assert.equal((await waitJob(cancelId)).status,'cancelled');assert.ok(Date.now()-start<5000);checks.push('large tiled job cancellation through independent control reader');
 await assert.rejects(compare.call('export',{jobId:cancelId,path:path.join(out,'invalid.csv'),kind:'csv'}));await assert.rejects(compare.call('start',{jobId:randomUUID(),options:{...options,dpi:999}}));checks.push('cancelled/invalid jobs never export a complete conclusion');
 const before=await main.call('render_page',{page:nativePage,targetWidth:500});compare.close();const after=await main.call('render_page',{page:nativePage,targetWidth:500});assert.equal(hash(before.dataUrl),hash(after.dataUrl));assert.equal((await main.call('get_backend_status')).engineReady,true);checks.push('killing comparison leaves main PDF source, rendering and backend intact');
 assert.equal(hash(await readFile(old)),hash(original));result={status:'PASS',checks,output:out,mainBackendSurvived:true};
}finally{compare.close();main.close()}
await writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
