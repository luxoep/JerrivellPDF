// SPDX-License-Identifier: MIT OR Apache-2.0
// Actual editor -> actual frontend asset bridge -> actual PDFium worker -> SVG
// reader -> saved/reopened PDF. Only React scheduling and native file pickers
// are substituted; no asset response, library serialization or PDF result is mocked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const exe=resolve(process.argv[2]??join(root,'src-tauri/target/release/jerrivell-pdf.exe'));
const dll=resolve(process.argv[3]??join(root,'src-tauri/resources/pdfium/bin/pdfium.dll'));
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const output=resolve(process.argv[4]??join(root,`test-results/${version}/pdf-fragment-workflow`));await mkdir(output,{recursive:true});
const source=join(output,'中文 来源 模板.pdf');await copyFile(join(root,'fixtures/second.pdf'),source);
const originalHash=createHash('sha256').update(await readFile(source)).digest('hex');
const worker=spawn(exe,['--pdf-worker','--pdfium-path',dll],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const calls=[],pending=new Map();let sequence=0,stderr='';worker.stderr.on('data',data=>stderr+=data.toString());
const lines=createInterface({input:worker.stdout});lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const item=pending.get(value.id);if(item){pending.delete(value.id);clearTimeout(item.timer);value.error?item.reject(new Error(value.error)):item.resolve(value.result);}});
const fail=error=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();};
worker.on('error',fail);worker.on('exit',code=>fail(new Error(`Worker ${code}: ${stderr}`)));
function invoke(command,args){calls.push({command,args});return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout ${command}`));},120000);pending.set(id,{resolve,reject,timer});worker.stdin.write(JSON.stringify({id,command,args})+'\n');});}
function load(relative,globals){const exports={};const code=ts.transpileModule(globals.source??'',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;vm.runInNewContext(code,{exports,console,Error,Date,crypto:{randomUUID},...globals},{filename:relative});return exports;}
async function module(relative,globals){return load(relative,{...globals,source:await readFile(join(root,relative),'utf8')});}
const edge=new EventTarget();edge.__TAURI_INTERNALS__={};
const api=await module('src/backend.ts',{window:edge,CustomEvent,require:name=>{assert.equal(name,'@tauri-apps/api/core');return{invoke};}});
const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
const library=await module('src/stampLibrary.ts',{localStorage:storage});
const geometry=await module('src/overlayGeometry.ts',{}),viewerGeometry=await module('src/viewerGeometry.ts',{});
const jsx={jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key}),Fragment:'fragment'};
let host;
const react={
 useState(initial){const current=host,index=current.cursor++;if(!(index in current.slots))current.slots[index]=typeof initial==='function'?initial():initial;return[current.slots[index],value=>current.slots[index]=typeof value==='function'?value(current.slots[index]):value];},
 useRef(value){const index=host.cursor++;return host.slots[index]??={current:value};},
 useMemo(factory,deps){const current=host,index=current.cursor++,old=current.slots[index];if(!old||deps.some((value,i)=>value!==old.deps[i]))current.slots[index]={deps,value:factory()};return current.slots[index].value;},
 useEffect(effect,deps){const current=host,index=current.cursor++,old=current.effects[index];if(!old||deps.some((value,i)=>value!==old.deps[i]))current.pending.push(()=>{old?.cleanup?.();current.effects[index]={deps,cleanup:effect()};});},
};
const imageGeometry=await module('src/imageGeometry.ts',{});
const region=await module('src/components/RegionSelection.tsx',{require(name){if(name==='./PreviewZoom')return{PreviewZoom:'PreviewZoom'};if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;if(name==='../imageGeometry')return imageGeometry;if(name==='../i18n')return{useI18n:()=>({t:(zh,en)=>en??zh})};throw new Error(name);}});
const pngPath=join(output,'fragment-library.png');
const numbers=await module('src/useNumberDraft.ts',{require:()=>react});
const fragments=await module('src/pdfFragments.ts',{require:name=>name==='./imageGeometry'?imageGeometry:geometry});
const editor=await module('src/components/OverlayEditor.tsx',{require(name){
 if(name==='./FragmentTray')return{FragmentTray:'FragmentTray'};if(name==='../pdfFragments')return fragments;
 if(name==='../imageGeometry')return imageGeometry;
 if(name==='./RegionSelection')return region;
 if(name==='./ImageEditDialog')return{ImageEditDialog:'ImageEditDialog'};
 if(name==='../useFragmentPreview')return{useFragmentPreview:()=>({image:null,error:''})};
 if(name==='./PreviewZoom')return{PreviewZoom:'PreviewZoom'};if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;
 if(name==='@tauri-apps/plugin-dialog')return{open:async()=>source,save:async()=>pngPath};
 if(name==='lucide-react')return new Proxy({},{get:(_,name)=>`icon-${String(name)}`});
 if(name==='../i18n')return{useI18n:()=>({t:(zh,en)=>en??zh})};
 if(name==='../backend')return api;if(name==='../stampLibrary')return library;
 if(name==='../overlayGeometry')return geometry;
 if(name==='../textFrame')return{};
 if(name==='../useNumberDraft')return numbers;
 if(name==='./overlayCanvas')return{DEFAULT_FONT_FAMILY:'Microsoft YaHei UI',ensureFontReady:async()=>{}};
 if(name==='./FontPicker')return{FontPicker:'FontPicker'};
 if(name==='react-dom')return{flushSync:callback=>callback()};
 if(name.endsWith('.css'))return{};throw new Error(name);
}});
const editable=await module('src/editableOverlays.ts',{require(){return{};}});
const live=await module('src/components/LivePageImage.tsx',{require(name){if(name==='react')return react;if(['../textFrame','./MarkLayer','./overlayCanvas'].includes(name))return{};if(name==='../editableOverlays')return editable;if(name==='react/jsx-runtime')return jsx;if(name==='../backend')return api;if(name==='../viewerGeometry')return viewerGeometry;throw new Error(name);}});
const label=node=>node==null||typeof node==='boolean'?'':typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(label).join(''):label(node.props?.children);
function find(node,predicate,result=[]){if(!node||typeof node!=='object')return result;if(Array.isArray(node)){for(const item of node)find(item,predicate,result);return result;}if(predicate(node))result.push(node);find(node.props?.children,predicate,result);return result;}
const createHost=()=>({cursor:0,slots:[],effects:[],pending:[],tree:null});let editorHost=createHost();
const errors=[],busy=[];const props={pageWidth:595,pageHeight:842,overlays:[],disabled:false,onChange:next=>props.overlays=next,onError:error=>errors.push(error),onClose(){},onBusyChange:value=>busy.push(value)};
function render(){host=editorHost;host.cursor=0;host.pending=[];host.tree=editor.OverlayEditor(props);for(const effect of host.pending)effect();return host.tree;}
function button(name){const values=find(editorHost.tree,node=>node.type==='button'&&(label(node)===name||node.props['aria-label']===name));assert.equal(values.length,1,`button ${name}`);return values[0];}
async function click(name){const item=button(name);assert.ok(!item.props.disabled,`${name} must be usable`);item.props.onClick();const started=Date.now();while(busy.at(-1)){if(Date.now()-started>120000)throw new Error(`Editor operation stalled: ${name}`);await new Promise(resolve=>setTimeout(resolve,5));}await new Promise(resolve=>setImmediate(resolve));render();assert.equal(errors.length,0,`Editor errors: ${errors.join('; ')}`);}
function checkLive(page,layers){const tree=live.LivePageImage({page:{...page,overlays:props.overlays},layers,label:'Reader'});const images=find(tree,node=>node.type==='image'&&node.props['data-live-overlay']);assert.equal(images.length,props.overlays.length,'Every placed object must have visible reader pixels, not only a valid native handle');for(const image of images)assert.ok(image.props.href.startsWith('data:image/png;base64,'));return images;}
async function saveRoundTrip(page,name){const plan={...page,overlays:props.overlays};const path=join(output,name);const preview=await api.renderPage(plan,600);const report=await api.backend('prepare_export',{parts:[{name,pages:[api.pageReference(plan)]}]},3);const result=await api.backend('save_prepared_export',{token:report.token,paths:[path]},3);assert.equal(result.failed,0);assert.equal((await stat(path)).size,report.totalBytes);const reopened=await api.backend('open_document',{path});const reference={documentId:reopened.id,pageIndex:0,rotation:0};const image=await api.renderPage(reference,600);assert.equal(createHash('sha256').update(image.dataUrl).digest('hex'),createHash('sha256').update(preview.dataUrl).digest('hex'),'Saved/reopened pixels must equal native export preview');const content=await api.backend('inspect_page_content',{page:reference});assert.equal(content.objects.filter(value=>value.kind==='image').length,props.overlays.length);return path;}
try{
 const target=await api.backend('open_document',{path:join(root,'fixtures/sample.pdf')});let page={id:'target',documentId:target.id,pageIndex:0,rotation:0,width:595,height:842};
 const base=await api.renderPageLayers(page,600);render();await click('Stamp');await click('PDF fragment');await click('Choose source PDF');
 assert.equal(button('Insert each fragment').props.disabled,false);
 const selectionHost=createHost();
 function selectionSurface(){
  const selection=find(editorHost.tree,node=>node.type?.name==='PdfStampSelection')[0];assert.ok(selection,'Real source page must be available for selection');
  // Mount the production wrapper as well: it enables additive selections.
  const wrapperHost=createHost();host=wrapperHost;const wrapper=selection.type(selection.props);for(const effect of wrapperHost.pending)effect();
  const regionNode=find(wrapper,node=>node.type===region.RegionSelection)[0];assert.ok(regionNode);assert.equal(regionNode.props.allowMultiple,true);
  host=selectionHost;host.cursor=0;host.pending=[];const tree=region.RegionSelection(regionNode.props);for(const effect of host.pending)effect();
  const surfaces=find(tree,node=>node.props.role==='group'&&node.props.className?.split(/\s+/).includes('region-selection-surface'));assert.equal(surfaces.length,1,'Select the actual pointer surface rather than a positional child');return surfaces[0];
 }
 let group=selectionSurface();
 const surface={getBoundingClientRect:()=>({left:0,top:0,width:200,height:300}),focus(){},setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}};
 group.props.ref.current=surface;
 const pointer=(x,y)=>({button:0,pointerId:1,currentTarget:surface,clientX:x,clientY:y,preventDefault(){},stopPropagation(){}});
 group.props.onPointerDown(pointer(40,60));group.props.onPointerMove(pointer(160,180));group.props.onPointerUp(pointer(160,180));render();
 const selected=find(editorHost.tree,node=>node.type?.name==='PdfStampSelection')[0];assert.ok(Math.abs(selected.props.crop.x-.2)<1e-8);
 // The visible source is an immutable snapshot. Changing this test-only file on
 // disk cannot change later fragments or trigger a second PDF render.
 await writeFile(source,Buffer.from('temporarily replaced test source'));
 await click('Create fragment list');let tray=find(editorHost.tree,node=>node.type==='FragmentTray')[0];assert.equal(tray.props.items.length,1);
 await click('Open PDF fragment workspace');
 group=selectionSurface();group.props.ref.current=surface;group.props.onPointerDown(pointer(10,15));group.props.onPointerMove(pointer(30,45));group.props.onPointerUp(pointer(30,45));render();
 await click('Insert each fragment');assert.equal(props.overlays.length,2);assert.ok(props.overlays.every(item=>item.blendMode==='multiply'));checkLive(page,base);
 const multiCall=calls.filter(item=>item.command==='create_image_fragments').at(-1);assert.equal(multiCall.args.crops.length,2);assert.ok(Math.abs(multiCall.args.crops[0].x-.2)<1e-8);assert.ok(Math.abs(multiCall.args.crops[1].x-.05)<1e-8);
 assert.equal(calls.filter(item=>item.command==='import_pdf_stamp').length,1,'Only the selected page is rendered; cropping never rereads the PDF');
 await copyFile(join(root,'fixtures/second.pdf'),source);
 assert.equal(await api.renderPageLayers({...page,overlays:props.overlays},600),base,'Placing fragments must preserve the no-refresh reader');
 await saveRoundTrip(page,'placed-fragments.pdf');
 const fullCall=calls.find(item=>item.command==='import_pdf_stamp');assert.ok(fullCall);
 const snapshotId=multiCall.args.assetId;
 const validCrop={x:.15,y:.15,width:.3,height:.3};
 await assert.rejects(api.backend('create_image_fragments',{assetId:snapshotId,crops:[validCrop,{x:2,y:0,width:.1,height:.1}],removeWhiteBackground:false,trimTransparentMargins:true}),/ASSET_INVALID/);
 // A late pixel-budget failure must roll back new assets, not exhaust the pool.
 await assert.rejects(api.backend('create_image_fragments',{assetId:snapshotId,crops:Array.from({length:16},()=>({x:0,y:0,width:1,height:1})),removeWhiteBackground:true,trimTransparentMargins:false}),/64 MiB/);
 const recovered=await api.backend('create_image_fragments',{assetId:snapshotId,crops:[validCrop],removeWhiteBackground:false,trimTransparentMargins:true});assert.equal(recovered.length,1);assert.ok(api.previewImageAsset(recovered[0].id));
 await click('Open PDF fragment workspace');const white=find(editorHost.tree,node=>node.type==='label'&&label(node).includes('Make near-white transparent'))[0];find(white,node=>node.type==='input')[0].props.onChange({target:{checked:true}});render();
 await click('Save to library');assert.equal(calls.filter(item=>item.command==='create_image_fragments').at(-1).args.removeWhiteBackground,true);
 assert.ok(library.loadStampLibrary().length>=1);assert.equal(library.loadStampLibrary()[0].blendMode,'multiply');assert.ok(!('assetId'in library.loadStampLibrary()[0]));
 find(editorHost.tree,node=>node.type==='input'&&node.props['aria-label']==='PDF fragment source page')[0].props.onChange({target:{value:'2'}});render();assert.equal(button('Create fragment list').props.disabled,true);
 await click('Load page');await click('Create fragment list');assert.equal(calls.filter(item=>item.command==='import_pdf_stamp').at(-1).args.pageIndex,1);
 await click('Open PDF fragment workspace');
 await click('Close fragment workspace');await click('Library');const pngButtons=find(editorHost.tree,node=>node.type==='button'&&label(node)==='PNG');pngButtons[0].props.onClick();while(busy.at(-1))await new Promise(resolve=>setTimeout(resolve,5));render();assert.ok((await stat(pngPath)).size>100);
 for(const effect of editorHost.effects)effect?.cleanup?.();api.resetBackendQueue();await api.backend('close_all_documents');
 const nextTarget=await api.backend('open_document',{path:join(root,'fixtures/sample.pdf')});page={...page,documentId:nextTarget.id};props.overlays=[];editorHost=createHost();render();await click('Library');find(editorHost.tree,node=>node.type==='button'&&label(node)==='Place')[0].props.onClick();while(busy.at(-1))await new Promise(resolve=>setTimeout(resolve,5));render();
 const nextBase=await api.renderPageLayers(page,600);checkLive(page,nextBase);assert.ok(calls.some(item=>item.command==='register_image'),'Library reuse must re-register PNGs after native session reset');
 const imported=await api.backend('import_image',{path:pngPath});assert.ok(api.previewImageAsset(imported.id),'PNG import must share the same validated cache path');
 await saveRoundTrip(page,'library-reopened.pdf');assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'),originalHash);
 const result={status:'PASS',executable:exe,output,realEditor:true,realNativeResponses:true,readerPixelsPresent:true,selectCropAndPreview:true,multiRegionEditorSelection:true,independentFragments:true,immutableSnapshot:true,batchRollbackRecovery:true,multiply:true,stalePreviewBlocked:true,pageSwitch:true,pngExport:true,libraryAfterSessionReset:true,savedAndReopenedPixelsMatch:true,assetCommands:[...new Set(calls.filter(call=>['register_image','import_image','import_pdf_stamp','create_image_fragments'].includes(call.command)).map(call=>call.command))]};
 await writeFile(join(output,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{worker.stdin.end();worker.kill();lines.close();}
