// SPDX-License-Identifier: GPL-3.0-or-later
// Actual frontend queue/staging code connected to the installed native worker.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import vm from 'node:vm';
import ts from 'typescript';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const exe=resolve(process.argv[2]??join(root,'release/jerrivell-app/jerrivell-pdf.exe'));
const dll=resolve(process.argv[3]??join(root,'release/jerrivell-app/pdfium/bin/pdfium.dll'));
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const output=join(root,`test-results/${version}/live-worker`);await mkdir(output,{recursive:true});
const worker=spawn(exe,['--pdf-worker','--pdfium-path',dll],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const pending=new Map(),calls=[];let sequence=0,stderr='';
worker.stderr.on('data',chunk=>stderr+=chunk.toString());
const reader=createInterface({input:worker.stdout});reader.on('line',line=>{
  let response;try{response=JSON.parse(line);}catch{return;}
  const item=pending.get(response.id);if(item){pending.delete(response.id);clearTimeout(item.timer);response.error?item.reject(new Error(response.error)):item.resolve(response.result);}
});
const failed=error=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();};
worker.on('error',failed);worker.on('exit',code=>failed(new Error(`Worker ${code}: ${stderr}`)));
function invoke(command,args){calls.push({command,args});return new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout ${command}`));},120000);pending.set(id,{resolve,reject,timer});worker.stdin.write(JSON.stringify({id,command,args})+'\n');
});}
function solid(r,g,b){
  const crc=bytes=>{let n=0xffffffff;for(const byte of bytes){n^=byte;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;};
  const chunk=(type,data)=>{const t=Buffer.from(type),size=Buffer.alloc(4),check=Buffer.alloc(4);size.writeUInt32BE(data.length);check.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([size,t,data,check]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(16);header.writeUInt32BE(16,4);header[8]=8;header[9]=6;
  const pixels=Buffer.alloc(16*65);for(let y=0;y<16;y++)for(let x=0;x<16;x++){const i=y*65+1+x*4;pixels[i]=r;pixels[i+1]=g;pixels[i+2]=b;pixels[i+3]=255;}
  return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const compiled=ts.transpileModule(await readFile(join(root,'src/backend.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const api={},edge=new EventTarget();edge.__TAURI_INTERNALS__={};
vm.runInNewContext(compiled,{exports:api,window:edge,CustomEvent,Error,console,require(name){assert.equal(name,'@tauri-apps/api/core');return{invoke};}});
const hash=data=>createHash('sha256').update(data).digest('hex');
try{
  const source=join(root,'fixtures/sample.pdf'),original=hash(await readFile(source));
  const doc=await api.backend('open_document',{path:source});
  const page={documentId:doc.id,pageIndex:0,rotation:0};
  const base=await api.renderPageLayers(page,800),thumb=await api.renderPageLayers(page,154,true);
  assert.ok(base.foreground.length);const initialRasterCalls=calls.filter(call=>call.command==='render_page_layers').length;
  // An asset is usable only when both the native worker AND the live reader
  // know it. Saving alone cannot detect a fragment that vanishes in the UI.
  const fragment=await api.backend('import_pdf_stamp',{path:join(root,'fixtures/second.pdf'),pageIndex:0,crop:{x:.1,y:.1,width:.7,height:.4},removeWhiteBackground:false,trimTransparentMargins:true});
  assert.equal('image' in fragment,false,'PdfStampInfo has a flat serialized image contract');
  assert.equal(fragment.pageCount,2);
  assert.ok(api.previewImageAsset(fragment.id),'PDF fragments must enter the same live preview cache as imported and generated images');
  assert.equal(hash(api.previewImageAsset(fragment.id).dataUrl),hash(fragment.dataUrl));
  const yellow=api.stageImageAsset(solid(255,220,0)),green=api.stageImageAsset(solid(20,180,80));
  const plan={...page,overlays:[{id:'highlight',assetId:yellow.id,x:.15,y:.155,width:.45,height:.035,opacity:.35,rotation:0,blendMode:'multiply'},{id:'block',assetId:green.id,x:.55,y:.4,width:.12,height:.08,opacity:1,rotation:90,blendMode:'normal'}]};
  const exportPromise=api.backend('prepare_export',{parts:[{name:'immediate.pdf',pages:[api.pageReference(plan)]}]},3);
  for(let i=0;i<20;i++){
    const live={...plan,overlays:[{...plan.overlays[0],x:i/40,opacity:i/25},plan.overlays[1]]};
    assert.equal(await api.renderPageLayers(live,800),base);assert.equal(await api.renderPageLayers(live,154,true),thumb);
  }
  const report=await exportPromise;await Promise.all([yellow.registered,green.registered]);
  assert.equal(calls.filter(call=>call.command==='render_page_layers').length,initialRasterCalls,'Twenty edits update neither native page nor thumbnail');
  assert.ok(!JSON.stringify(calls).includes('jerrivell-preview-'),'Native IPC must never receive unresolved preview identifiers');
  const destination=join(output,'immediate.pdf');const saved=await api.backend('save_prepared_export',{token:report.token,paths:[destination]},3);
  assert.equal(saved.failed,0);assert.equal((await stat(destination)).size,report.totalBytes);
  const reopened=await api.backend('open_document',{path:destination});assert.equal(reopened.pageCount,1);
  const inspection=await api.backend('inspect_page_content',{page:{documentId:reopened.id,pageIndex:0,rotation:0}});
  assert.equal(inspection.objects.filter(item=>item.kind==='image').length,2);
  assert.equal(hash(await readFile(source)),original);
  const image=await api.renderPage(plan,800);await writeFile(join(output,'native-export-preview.png'),Buffer.from(image.dataUrl.split(',')[1],'base64'));
  const summary={status:'PASS',executable:exe,overlayChanges:20,nativeRasterCalls:initialRasterCalls,nativeRasterCallsAfterEdits:initialRasterCalls,
    immediateSaveIncludesBothMarks:true,unresolvedIdsInNativeIpc:false,sourceUnchanged:true,bytes:report.totalBytes};
  api.resetBackendQueue();await api.backend('close_all_documents');assert.equal(api.previewImageAsset(yellow.id),undefined);
  await assert.rejects(api.renderPageLayers(page,800));
  await writeFile(join(output,'results.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
}finally{worker.stdin.end();worker.kill();reader.close();}
