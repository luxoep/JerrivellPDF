// SPDX-License-Identifier: MIT OR Apache-2.0
// Actual crop/editor state, pointer events, stale repair preview and no per-move IPC.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const plain=value=>JSON.parse(JSON.stringify(value));
function load(path,require,globals={}){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require,console,Error,...globals});return exports;}
const geometry=load('../src/imageGeometry.ts',()=>{}),{selectionUnion,selectionRegions,transformSelection}=geometry;
const first={x:.1,y:.1,width:.3,height:.3},second={x:.6,y:.6,width:.2,height:.2},overlap={x:.2,y:.2,width:.3,height:.3};
const union=selectionUnion([first,second]);assert.equal(union.regions.length,2);assert.ok(Math.abs(union.width-.7)<1e-12);assert.equal(selectionRegions(selectionUnion([union,overlap])).length,3);assert.throws(()=>selectionUnion(Array(17).fill(first)),/SELECTION_LIMIT/);
const transformed=transformSelection(union,{x:0,y:0,width:.35,height:.35});assert.equal(transformed.regions[0].x,0);assert.ok(Math.abs(transformed.regions[1].x-.25)<1e-12);assert.ok(Math.abs(transformed.regions[1].width-.1)<1e-12);
let host;
const react={useState(initial){const owner=host,n=owner.cursor++;if(!(n in owner.slots))owner.slots[n]=typeof initial==='function'?initial():initial;return[owner.slots[n],value=>owner.slots[n]=typeof value==='function'?value(owner.slots[n]):value];},useRef(value){const n=host.cursor++;return host.slots[n]??={current:value};},useEffect(effect,deps){const owner=host,n=owner.cursor++,old=owner.effects[n];if(!old||deps.some((value,i)=>value!==old.deps[i]))owner.pending.push(()=>{old?.cleanup?.();owner.effects[n]={deps,cleanup:effect()};});}};
const jsx={jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key}),Fragment:'fragment'},i18n={useI18n:()=>({t:(zh,en)=>en??zh})};
function walk(node,predicate,result=[]){if(!node||typeof node!=='object')return result;if(Array.isArray(node)){for(const child of node)walk(child,predicate,result);return result;}if(predicate(node))result.push(node);walk(node.props?.children,predicate,result);return result;}
const label=node=>node==null||typeof node==='boolean'?'':typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(label).join(''):label(node.props?.children);
function harness(Component,props){const owner={cursor:0,slots:[],effects:[],pending:[],tree:null};return{owner,render(){host=owner;owner.cursor=0;owner.pending=[];owner.tree=Component(props);for(const effect of owner.pending)effect();return owner.tree;},button(name){const nodes=walk(owner.tree,node=>node.type==='button'&&label(node).trim()===name);assert.equal(nodes.length,1,name);return nodes[0];},cleanup(){for(const effect of owner.effects)effect?.cleanup?.();}};}
const selectionFrames=new Map();let selectionFrameId=0;
const region=load('../src/components/RegionSelection.tsx',name=>{if(name==='./PreviewZoom')return{PreviewZoom:'PreviewZoom'};if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;if(name==='../imageGeometry')return geometry;if(name==='../i18n')return i18n;throw new Error(name);},{requestAnimationFrame:callback=>{const id=++selectionFrameId;selectionFrames.set(id,callback);return id;},cancelAnimationFrame:id=>selectionFrames.delete(id)});
const props={image:{id:'source',dataUrl:'source',width:200,height:200},crop:null,shape:'rectangle',disabled:false,allowMultiple:true,onChange(value){props.crop=value;}};
const ui=harness(region.RegionSelection,props),surface={getBoundingClientRect:()=>({left:0,top:0,width:200,height:200}),focus(){},setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}};
const pointer=(x,y)=>({button:0,pointerId:1,clientX:x,clientY:y,currentTarget:surface,preventDefault(){}});
function group(){const tree=ui.render(),node=walk(tree,node=>node.props.role==='group')[0];node.props.ref.current=surface;return node;}
function draw(x,y,endX,endY){const node=group();node.props.onPointerDown(pointer(x,y));node.props.onPointerMove(pointer(endX,endY));node.props.onPointerUp(pointer(endX,endY));ui.render();}
draw(20,20,80,80);draw(120,120,160,160);assert.equal(props.crop.regions.length,2);for(const [n,region] of [first,second].entries())for(const key of ['x','y','width','height'])assert.ok(Math.abs(props.crop.regions[n][key]-region[key])<1e-12);
draw(40,40,100,100);let tree=ui.render();assert.equal(props.crop.regions.length,3);const mask=walk(tree,node=>node.type==='mask')[0];assert.equal(walk(mask,node=>node.type==='polygon').length,3,'Separate black mask shapes keep overlapping regions as union, not XOR');
ui.button('Undo region').props.onClick();ui.render();assert.equal(props.crop.regions.length,2);
walk(ui.owner.tree,node=>node.type==='input'&&node.props.type==='checkbox')[0].props.onChange({target:{checked:false}});draw(20,20,80,80);assert.equal(props.crop.regions,undefined,'Unchecked additive mode replaces the complete union');
ui.button('Clear regions').props.onClick();ui.render();assert.equal(props.crop,null);
walk(ui.owner.tree,node=>node.type==='input'&&node.props.type==='checkbox')[0].props.onChange({target:{checked:true}});props.crop=selectionUnion(Array(16).fill(first));draw(120,120,160,160);assert.equal(props.crop.regions.length,16);assert.ok(label(ui.owner.tree).includes('16-region limit'));ui.cleanup();


const published=[],frameProps={...props,crop:null,disabled:false,onChange(){},onPreview:value=>published.push(value)},frameUi=harness(region.RegionSelection,frameProps);let frameTree=frameUi.render();let frameSurface=walk(frameTree,node=>node.props.role==='group')[0];frameSurface.props.ref.current=surface;published.length=0;frameSurface.props.onPointerDown(pointer(10,10));for(let x=20;x<=80;x++)frameSurface.props.onPointerMove(pointer(x,x));assert.equal(selectionFrames.size,1,'High-frequency selection gestures schedule one browser frame');assert.equal(published.length,0);for(const[id,callback]of[...selectionFrames]){selectionFrames.delete(id);callback();}assert.equal(published.length,1);assert.ok(Math.abs(published[0].width-.35)<1e-12,'The frame displays the latest pointer, not the first one');frameSurface.props.onPointerMove(pointer(90,90));frameSurface.props.onPointerUp(pointer(90,90));assert.equal(selectionFrames.size,0,'Commit cancels pending ghost updates');frameUi.cleanup();

const timers=new Map(),requests=[];let timerId=0;
const edge={setTimeout:callback=>{const id=++timerId;timers.set(id,callback);return id;},clearTimeout:id=>timers.delete(id)};
function runTimers(){for(const[id,callback]of[...timers]){timers.delete(id);callback();}}
const api={errorMessage:String,backend:(command,args)=>new Promise((resolve,reject)=>requests.push({command,args,resolve,reject}))};
const editor=load('../src/components/ImageEditDialog.tsx',name=>{if(name==='./PreviewZoom')return{PreviewZoom:'PreviewZoom'};if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;if(name==='../backend')return api;if(name==='../imageGeometry')return geometry;if(name==='../i18n')return i18n;if(name==='./RegionSelection')return{RegionSelection:'RegionSelection'};if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});if(name.endsWith('.css'))return{};throw new Error(name);},{window:edge,crypto:{randomUUID:()=> 'edit'}});
const pixel=harness(editor.ImageEditDialog,{image:props.image,title:'Test',onApply(){},onClose(){}});pixel.render();pixel.button('Eraser').props.onClick();pixel.render();const select=walk(pixel.owner.tree,node=>node.type==='select'&&node.props['aria-label']==='Erase mode')[0];assert.equal(select.props.value,'repair','Background repair is the explicit default');
let svg=walk(pixel.owner.tree,node=>node.props.className==='pixel-erase-surface')[0];svg.props.onPointerDown(pointer(20,20));for(let n=0;n<20;n++)svg.props.onPointerMove(pointer(20+n,20+n));assert.equal(requests.length,0);svg.props.onPointerUp(pointer(50,50));pixel.render();assert.equal(requests.length,0,'Stroke release is debounced');assert.equal(pixel.button('Apply edits').props.disabled,true,'Cannot apply stale repair preview');
runTimers();assert.equal(requests.length,1);assert.equal(requests[0].command,'preview_image_edit');assert.equal(requests[0].args.strokes[0].mode,'repair');
pixel.button('Undo edit').props.onClick();pixel.render();requests[0].resolve({dataUrl:'stale-repair',width:200,height:200});await new Promise(resolve=>setImmediate(resolve));pixel.render();assert.equal(walk(pixel.owner.tree,node=>node.type==='image'&&node.props.href==='stale-repair').length,0,'Undo discards a late repair result');
svg=walk(pixel.owner.tree,node=>node.props.className==='pixel-erase-surface')[0];svg.props.onPointerDown(pointer(40,40));svg.props.onPointerUp(pointer(45,45));pixel.render();runTimers();requests[1].resolve({dataUrl:'fresh-repair',width:200,height:200});await new Promise(resolve=>setImmediate(resolve));pixel.render();assert.equal(pixel.button('Apply edits').props.disabled,false);assert.equal(walk(pixel.owner.tree,node=>node.type==='image'&&node.props.href==='fresh-repair').length,2);
svg=walk(pixel.owner.tree,node=>node.props.className==='pixel-erase-surface')[0];svg.props.onPointerDown(pointer(80,80));svg.props.onPointerUp(pointer(85,85));pixel.render();runTimers();requests[2].reject(new Error('Invalid native preview'));await new Promise(resolve=>setImmediate(resolve));pixel.render();assert.equal(pixel.button('Apply edits').props.disabled,true);assert.ok(label(pixel.owner.tree).includes('Invalid native preview'));pixel.button('Retry repair preview').props.onClick();pixel.render();runTimers();requests[3].resolve({dataUrl:'retry-repair',width:200,height:200});await new Promise(resolve=>setImmediate(resolve));pixel.render();assert.equal(pixel.button('Apply edits').props.disabled,false);pixel.cleanup();assert.equal(timers.size,0);
const largeImage={...props.image,id:'high-resolution',dataUrl:'original-full-size',width:3200,height:2100};
const highRes=harness(editor.ImageEditDialog,{image:largeImage,initialMode:'erase',title:'Large image',onApply(){},onClose(){}});
let surfaceTree=walk(highRes.render(),node=>node.props.className==='pixel-erase-surface')[0];
surfaceTree.props.onPointerDown(pointer(20,20));surfaceTree.props.onPointerUp(pointer(90,90));highRes.render();runTimers();
requests.at(-1).resolve({dataUrl:'small-repair-preview',width:1000,height:656});
await new Promise(resolve=>setImmediate(resolve));
surfaceTree=walk(highRes.render(),node=>node.props.className==='pixel-erase-surface')[0];
const highResImages=walk(surfaceTree,node=>node.type==='image');
assert.equal(highResImages[0].props.href,'original-full-size','Repair is composited over the original-resolution base');
assert.equal(highResImages[0].props.width,3200);
assert.equal(highResImages[1].props.href,'small-repair-preview');
assert.match(highResImages[1].props.mask,/-repair\)/,'Only the repaired area uses thumbnail pixels');
highRes.cleanup();assert.equal(timers.size,0);

// Page erasure uses the same real selection gestures, and submits polygons
// only after the user deliberately applies the complete set of regions.
const markGeometry=load('../src/markGeometry.ts',()=>{});
const icons=new Proxy({},{get:(_,key)=>String(key)});
const toolbar=load('../src/components/MarkToolbar.tsx',name=>({
  'react/jsx-runtime':jsx,'lucide-react':icons,'../i18n':i18n,'../markGeometry':markGeometry,
})[name]);
let pageEraseOpens=0;
const markProps={settings:markGeometry.DEFAULT_MARK,disabled:false,onEraseRegions:()=>pageEraseOpens++,onEditPixels(){}};
const markUi=harness(toolbar.MarkToolbar,markProps);
markUi.render();
assert.equal(markUi.button('Erase page regions').props.disabled,false,'Page erasure is available without selecting an overlay');
markUi.button('Erase page regions').props.onClick();
assert.equal(pageEraseOpens,1);
assert.equal(walk(markUi.owner.tree,node=>node.props['aria-label']==='Crop or erase the selected mark').length,0,'Selected overlay erasure is a separate tool');
markProps.settings={...markProps.settings,tool:'select'};
markUi.render();
assert.equal(walk(markUi.owner.tree,node=>node.props['aria-label']==='Crop or erase the selected mark')[0].props.disabled,true);

const erasureCalls=[];
let finishPreview, rejectApply;
const pageEraser=load('../src/components/PageEraseDialog.tsx',name=>({
  react,'react/jsx-runtime':jsx,'lucide-react':icons,'../i18n':i18n,'../imageGeometry':geometry,
  './RegionSelection':region,'./image-workbench.css':{},
  '../backend':{errorMessage:error=>error.message,renderPage:(page,width)=>new Promise(resolve=>{
    erasureCalls.push({command:'render',page,width});finishPreview=resolve;
  })},
})[name]);
let closeCount=0;
const page={id:'workspace-page',documentId:'source-document',pageIndex:2,rotation:90};
const pageEditor=harness(pageEraser.PageEraseDialog,{
  page,onClose:()=>closeCount++,onApply:regions=>{
    erasureCalls.push({command:'apply',regions:plain(regions)});
    if (erasureCalls.filter(call=>call.command==='apply').length===1) return new Promise((_,reject)=>{rejectApply=reject;});
    return Promise.resolve();
  },
});
pageEditor.render();
assert.equal(pageEditor.button('Erase selected regions').props.disabled,true);
assert.equal(erasureCalls.length,1);
assert.equal(erasureCalls[0].page,page);
assert.equal(erasureCalls[0].width,1800);
finishPreview({width:200,height:200,dataUrl:'source-page'});
await new Promise(resolve=>setImmediate(resolve));

const pageSelectionProps={};
const pageSelection=harness(region.RegionSelection,pageSelectionProps);
const selectionTree=()=>{
  const renderer=walk(pageEditor.render(),node=>node.type===region.RegionSelection)[0];
  Object.assign(pageSelectionProps,renderer.props);
  return pageSelection.render();
};
const eraserSurface=()=>{
  const node=walk(selectionTree(),item=>item.props.role==='group')[0];
  node.props.ref.current=surface;
  return node;
};
const keyEvent=key=>({key,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}});
assert.equal(walk(selectionTree(),node=>node.type==='PreviewZoom')[0].props.resetKey,page.id);
let regionCanvas=eraserSurface();
regionCanvas.props.onPointerDown(pointer(20,40));
for(let step=0;step<60;step++)regionCanvas.props.onPointerMove(pointer(20+step,40+step));
assert.equal(erasureCalls.length,1,'Dragging a selection never re-renders the page or prepares a native erasure');
regionCanvas.props.onPointerUp(pointer(80,100));
walk(pageEditor.render(),node=>node.type==='select')[0].props.onChange({target:{value:'polygon'}});
for(const [x,y] of [[120,110],[160,110],[155,160]])eraserSurface().props.onPointerDown(pointer(x,y));
const drawEscape=keyEvent('Escape');selectionTree().props.onKeyDown(drawEscape);
assert.ok(drawEscape.prevented&&drawEscape.stopped,'Escape cancels the open polygon without closing the dialog');
assert.equal(closeCount,0);
for(const [x,y] of [[120,110],[160,110],[155,160]])eraserSurface().props.onPointerDown(pointer(x,y));
selectionTree().props.onKeyDown({...keyEvent('Enter'),target:surface});
walk(pageEditor.render(),node=>node.type==='select')[0].props.onChange({target:{value:'curve'}});
const curve = eraserSurface();
curve.props.onPointerDown(pointer(105,35));
for (const [x,y] of [[120,31],[135,35],[144,48],[141,62],[126,70],[112,65],[103,54]]) curve.props.onPointerMove(pointer(x,y));
curve.props.onPointerUp(pointer(103,54));
assert.equal(erasureCalls.length,1,'An open curve never invokes native work');
const closeCurve = walk(selectionTree(),node=>node.type==='button'&&label(node)==='Close curve')[0];
assert.equal(closeCurve.props.disabled,false);
closeCurve.props.onClick();
pageEditor.render();
const applyErase=pageEditor.button('Erase selected regions');
assert.equal(applyErase.props.disabled,false);
applyErase.props.onClick();applyErase.props.onClick();pageEditor.render();
assert.deepEqual(erasureCalls.map(call=>call.command),['render','apply'],'Apply submits once and does not request another preview');
assert.deepEqual(erasureCalls[1].regions.slice(0,2).map(points=>points.length),[4,3]);
assert.ok(erasureCalls[1].regions[2].length > 8, 'A closed freeform spline contributes its interpolated outline');
assert.deepEqual(erasureCalls[1].regions[0][0],{x:.1,y:.2});
assert.deepEqual(erasureCalls[1].regions[1][0],{x:.6,y:.55});
assert.equal(walk(selectionTree(),node=>node.type==='PreviewZoom')[0].props.disabled,true,'Applying locks preview interaction');
pageEditor.owner.tree.props.onKeyDown(keyEvent('Escape'));
assert.equal(closeCount,0,'An in-flight native operation cannot be closed with Escape');
rejectApply(new Error('Synthetic erase validation failure'));
await new Promise(resolve=>setImmediate(resolve));pageEditor.render();
assert.match(label(walk(pageEditor.owner.tree,node=>node.props.role==='alert')[0]),/Synthetic erase validation failure/);
assert.equal(pageEditor.button('Erase selected regions').props.disabled,false,'A failed erase keeps every region available for retry');
pageEditor.button('Erase selected regions').props.onClick();
await new Promise(resolve=>setImmediate(resolve));pageEditor.render();
assert.deepEqual(erasureCalls[2].regions,erasureCalls[1].regions);
assert.equal(walk(pageEditor.owner.tree,node=>node.props.role==='alert').length,0);
pageEditor.owner.tree.props.onKeyDown(keyEvent('Escape'));
assert.equal(closeCount,1);
pageSelection.cleanup();pageEditor.cleanup();markUi.cleanup();
console.log('PASS: region unions, pointer frames, native debounce, stale preview rejection and sharp image pixels outside the repair stroke');
console.log('PASS: page eraser entry; zoomable preview; rectangle, polygon and explicitly closed curve payloads; no native traffic while drawing; Escape, double-apply guard and retry');
