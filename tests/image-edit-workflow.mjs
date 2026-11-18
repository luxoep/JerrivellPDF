// SPDX-License-Identifier: GPL-3.0-or-later
// Real UI state/events -> real asset bridge -> native PDFium -> save/reopen.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import vm from 'node:vm';
import ts from 'typescript';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const exe=resolve(process.argv[2]??join(root,'src-tauri/target/release/jerrivell-pdf.exe')),dll=resolve(process.argv[3]??join(root,'src-tauri/resources/pdfium/bin/pdfium.dll'));
const output=resolve(process.argv[4]??join(root,`test-results/${version}/image-edit-workflow`));await mkdir(output,{recursive:true});
const child=spawn(exe,['--pdf-worker','--pdfium-path',dll],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const pending=new Map(),calls=[];let sequence=0,stderr='';child.stderr.on('data',value=>stderr+=value);
const lines=createInterface({input:child.stdout});lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const item=pending.get(value.id);if(item){clearTimeout(item.timer);pending.delete(value.id);value.error?item.reject(new Error(value.error)):item.resolve(value.result);}});
function fail(error){for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();}child.on('error',fail);child.on('exit',code=>fail(new Error(`Worker ${code}: ${stderr}`)));
function invoke(command,args){calls.push({command,args});return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(command+' timed out'));},120000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,command,args})+'\n');});}
const edge=new EventTarget();edge.__TAURI_INTERNALS__={};edge.setTimeout=setTimeout;edge.clearTimeout=clearTimeout;
async function load(path,require,extra={}){const exports={},source=await readFile(join(root,path),'utf8');vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require,console,Error,window:edge,CustomEvent,crypto:{randomUUID},Image:class{async decode(){}},...extra},{filename:path});return exports;}
const api=await load('src/backend.ts',name=>{assert.equal(name,'@tauri-apps/api/core');return{invoke};});
const geometry=await load('src/imageGeometry.ts',()=>{}),view=await load('src/viewerGeometry.ts',()=>{}),content=await load('src/originalContent.ts',()=>{});
const jsx={jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key}),Fragment:'fragment'};
let host;
const react={
 useState(initial){const current=host,n=current.cursor++;if(!(n in current.slots))current.slots[n]=typeof initial==='function'?initial():initial;return[current.slots[n],value=>current.slots[n]=typeof value==='function'?value(current.slots[n]):value];},
 useRef(initial){const n=host.cursor++;return host.slots[n]??={current:initial};},
 useEffect(effect,deps){const current=host,n=current.cursor++,old=current.effects[n];if(!old||deps.some((value,i)=>value!==old.deps[i]))current.pending.push(()=>{old?.cleanup?.();current.effects[n]={deps,cleanup:effect()};});},
};
const i18n={useI18n:()=>({t:(zh,en)=>en??zh})};
const live=await load('src/components/LivePageImage.tsx',name=>{if(name==='react/jsx-runtime')return jsx;if(name==='../backend')return api;if(name==='../viewerGeometry')return view;throw new Error(name);});
const editor=await load('src/components/ImageEditDialog.tsx',name=>{if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;if(name==='../backend')return api;if(name==='../imageGeometry')return geometry;if(name==='../i18n')return i18n;if(name==='./RegionSelection')return{RegionSelection:'RegionSelection'};if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});if(name.endsWith('.css'))return{};throw new Error(name);});
const objectPreview=await load('src/components/OriginalObjectPreview.tsx',name=>{if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;if(name==='../backend')return api;if(name==='./LivePageImage')return live;if(name==='../i18n')return i18n;throw new Error(name);});
const originalEditor=await load('src/components/OriginalContentEditor.tsx',name=>{if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;if(name==='../backend')return api;if(name==='../originalContent')return content;if(name==='../i18n')return i18n;if(name==='./ImageEditDialog')return editor;if(name==='./FontPicker')return{FontPicker:'FontPicker'};if(name==='./overlayCanvas')return{DEFAULT_FONT_FAMILY:'Microsoft YaHei UI'};if(name==='@tauri-apps/plugin-dialog')return{open:async()=>null};if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});if(name.endsWith('.css'))return{};throw new Error(name);});
const label=node=>node==null||typeof node==='boolean'?'':typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(label).join(''):label(node.props?.children);
function find(node,predicate,result=[]){if(!node||typeof node!=='object')return result;if(Array.isArray(node)){for(const value of node)find(value,predicate,result);return result;}if(predicate(node))result.push(node);find(node.props?.children,predicate,result);return result;}
function harness(Component,props){const state={cursor:0,slots:[],effects:[],pending:[],tree:null};return{state,render(){host=state;state.cursor=0;state.pending=[];state.tree=Component(props);for(const effect of state.pending)effect();return state.tree;},button(name){const nodes=find(state.tree,node=>node.type==='button'&&(label(node).trim()===name||node.props['aria-label']===name));assert.equal(nodes.length,1,`button ${name}`);return nodes[0];},cleanup(){for(const effect of state.effects)effect?.cleanup?.();}};}
function png(){const width=160,height=120,scan=Buffer.alloc((width*4+1)*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(width*4+1)+1+x*4;scan.set(x<80?[210,35,69,255]:[54,188,120,255],i);}function chunk(type,data){const tag=Buffer.from(type),body=Buffer.concat([tag,data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let n=0;n<8;n++)crc=crc>>>1^(crc&1?0xedb88320:0);}const size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([size,body,sum]);}const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);}
const hash=value=>createHash('sha256').update(value).digest('hex');
async function save(plan,name){const path=join(output,name),before=await api.renderPage(plan,800);const report=await api.backend('prepare_export',{parts:[{name,pages:[api.pageReference(plan)]}]},3);assert.equal((await api.backend('save_prepared_export',{token:report.token,paths:[path]},3)).failed,0);const reopened=await api.backend('open_document',{path}),ref={documentId:reopened.id,pageIndex:0,rotation:0};assert.equal(hash((await api.renderPage(ref,800)).dataUrl),hash(before.dataUrl),'Saved pixels match the actual export preview');return{reopened,ref};}
async function exportPng(asset,name){await api.backend('export_image',{assetId:asset.id,outputPath:join(output,name)});}
try{
 const doc=await api.backend('open_document',{path:join(root,'fixtures/sample.pdf')}),sourceHash=hash(await readFile(join(root,'fixtures/sample.pdf')));
 const page={id:'page',documentId:doc.id,pageIndex:0,rotation:0,width:595,height:842,sourceName:'sample.pdf',overlays:[]};
 const asset=await api.backend('register_image',{dataUrl:'data:image/png;base64,'+png().toString('base64')});await exportPng(asset,'source.png');const thumb=await api.backend('preview_image',{path:join(output,'source.png')});assert.equal(thumb.width,160);assert.equal(thumb.height,120);assert.ok(!('id' in thumb),'Thumbnail previews do not allocate native image assets');
 const crop={x:0,y:0,width:1,height:1,points:[{x:0,y:0},{x:1,y:0},{x:1,y:.4},{x:.4,y:.4},{x:.4,y:1},{x:0,y:1}]};
 const applied=[],busy=[];let closed=0;
 const ui=harness(editor.ImageEditDialog,{image:asset,title:'Original synthetic image',onApply:image=>applied.push(image),onClose:()=>closed++,onBusyChange:value=>busy.push(value)});ui.render();
 find(ui.state.tree,node=>node.type==='RegionSelection')[0].props.onChange(crop);ui.render();
 ui.button('Eraser').props.onClick();ui.render();
 const surface={getBoundingClientRect:()=>({left:0,top:0,width:160,height:120}),setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}};
 const point=(x,y)=>({button:0,pointerId:1,clientX:x,clientY:y,currentTarget:surface,preventDefault(){}});
 let svg=find(ui.state.tree,node=>node.props.className==='pixel-erase-surface')[0];const before=calls.length;
 svg.props.onPointerDown(point(20,20));svg.props.onPointerMove(point(50,50));svg.props.onPointerUp(point(50,50));ui.render();
 assert.equal(calls.length,before,'Crop and eraser gestures make no native calls');
 ui.button('Undo edit').props.onClick();ui.render();assert.equal(find(ui.state.tree,node=>node.type==='polyline').length,0,'Local undo removes a stroke without changing the source image');
 svg=find(ui.state.tree,node=>node.props.className==='pixel-erase-surface')[0];svg.props.onPointerDown(point(20,20));svg.props.onPointerMove(point(50,50));svg.props.onPointerUp(point(50,50));ui.render();
 const applyButton=ui.button('Apply edits');assert.equal(applyButton.props.disabled,false);await applyButton.props.onClick();while(busy.at(-1))await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(closed,1);assert.equal(applied.length,1);assert.equal(calls.filter(c=>c.command==='edit_image_asset').length,1);const edited=applied[0];assert.ok(api.previewImageAsset(edited.id));await exportPng(edited,'cropped-erased.png');ui.cleanup();
 const plan={...page,overlays:[{id:'image',assetId:edited.id,x:.1,y:.1,width:.4,height:.25,opacity:1,blendMode:'normal'}]};
 const viewTree=live.LivePageImage({page:plan,layers:await api.renderPageLayers(page,800),label:'Page'});assert.equal(find(viewTree,node=>node.props['data-live-overlay']==='image').length,1);
 const saved=await save(plan,'edited-overlay.pdf');let inspection=await api.backend('inspect_page_content',{page:saved.ref});const imageObject=inspection.objects.find(o=>o.kind==='image');assert.ok(imageObject?.editable);
 let originalChanges=0;const originalProps={page:saved.ref,pageWidth:595,pageHeight:842,objects:inspection.objects,contentEdits:[],selectedId:String(imageObject.objectIndex),onSelect(){},onClose(){},onError:error=>{throw new Error(error);},onBusyChange:value=>busy.push(value),onChange:async edits=>{await api.backend('inspect_page_content',{page:{...saved.ref,contentEdits:edits}});originalProps.contentEdits=edits;originalChanges++;return true;}};
 const original=harness(originalEditor.OriginalContentEditor,originalProps);original.render();original.render();await original.button('Image crop / Eraser').props.onClick();while(busy.at(-1))await new Promise(resolve=>setTimeout(resolve,5));original.render();
 const pixelEditor=find(original.state.tree,node=>node.type===editor.ImageEditDialog)[0];assert.ok(pixelEditor);await exportPng(pixelEditor.props.image,'extracted-original.png');
 const second=await api.backend('edit_image_asset',{assetId:pixelEditor.props.image.id,crop:null,strokes:[{points:[{x:.12,y:.8}],width:10}]});assert.equal(await pixelEditor.props.onApply(second),true);assert.equal(originalChanges,1);await exportPng(second,'original-erased.png');
 await save({...page,...saved.ref,contentEdits:originalProps.contentEdits,overlays:[]},'edited-original.pdf');original.cleanup();
 const polygon=await api.backend('import_pdf_stamp',{path:join(root,'fixtures/second.pdf'),pageIndex:0,crop:{x:0,y:0,width:1,height:1,points:crop.points},removeWhiteBackground:false,trimTransparentMargins:false});await exportPng(polygon,'pdf-polygon.png');
 await assert.rejects(api.backend('import_pdf_stamp',{path:join(root,'fixtures/second.pdf'),pageIndex:0,crop:{...crop,points:[{x:NaN,y:0}]},removeWhiteBackground:false,trimTransparentMargins:false}));
 const text=(await api.backend('inspect_page_content',{page:api.pageReference(page)})).objects.find(o=>o.kind==='text'&&o.editable);assert.ok(text);
 const layers=await api.backend('render_object_layers',{page:api.pageReference(page),objectIndex:text.objectIndex,fingerprint:text.fingerprint,targetWidth:800});
 const imageFiles={};for(const name of ['lower','moving','upper']){const file=`object-${name}.png`;await writeFile(join(output,file),Buffer.from(layers[name].dataUrl.split(',')[1],'base64'));imageFiles[name]=file;}
 for(let n=0;n<layers.foreground.length;n++){const layer=layers.foreground[n];await writeFile(join(output,`object-foreground-${n}.png`),Buffer.from(layer.image.dataUrl.split(',')[1],'base64'));}
 await writeFile(join(output,'object-complete.png'),Buffer.from((await api.renderPage(page,800)).dataUrl.split(',')[1],'base64'));
 const props={page,object:text,bounds:{...text.bounds,x:text.bounds.x+.02},visible:true},preview=harness(objectPreview.OriginalObjectPreview,props),initialCalls=calls.filter(c=>c.command==='render_object_layers').length;preview.render();
 let tree;for(let n=0;n<300;n++){await new Promise(resolve=>setTimeout(resolve,10));tree=preview.render();if(tree)break;}assert.ok(tree,'Real native object layers reach the moving image');
 for(let n=0;n<20;n++){props.bounds={...props.bounds,x:text.bounds.x+n/1000};tree=preview.render();}
 assert.equal(calls.filter(c=>c.command==='render_object_layers').length,initialCalls+1,'Twenty original-object preview moves reuse one native layer response');
 const liveNode=find(tree,node=>node.type===live.LivePageImage)[0];assert.ok(find(live.LivePageImage(liveNode.props),node=>node.props['data-object-moving']).length);preview.cleanup();
 const raster=await api.backend('rasterize_page_asset',{page:api.pageReference(plan)});assert.ok(api.previewImageAsset(raster.id));assert.ok(Math.max(raster.width,raster.height)<=2400);
 const blank=await api.backend('generate_pages',{request:{kind:'blank',width:595,height:842,count:1}});await save({...page,documentId:blank.id,overlays:[{id:'raster',assetId:raster.id,x:0,y:0,width:1,height:1,opacity:1}]},'explicit-raster-page.pdf');
 assert.equal(hash(await readFile(join(root,'fixtures/sample.pdf'))),sourceHash);
 const result={status:'PASS',executable:exe,output,realImageEditor:true,realOriginalImageEditor:true,concaveCrop:true,transparentEraser:true,zeroNativeCallsDuringGestures:true,workspaceUndoUsesNewAsset:true,sourceUnchanged:true,savedReopenedPixelsMatch:true,originalObjectPreviewMoves:20,originalObjectLayerCalls:1,explicitPageRaster:true,foreground:layers.foreground.map(layer=>layer.blendMode)};
 await writeFile(join(output,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{child.stdin.end();child.kill();lines.close();}
