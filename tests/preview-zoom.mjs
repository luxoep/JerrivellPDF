// SPDX-License-Identifier: MIT OR Apache-2.0
// Run the production zoom controller with a minimal DOM and frame scheduler.
// This checks input interception, layout/anchor math and lifecycle behavior,
// without replacing the zoom implementation or involving PDF/native rendering.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const frames = new Map(); let sequence = 0, observer;
const requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); return id; };
const cancelAnimationFrame = id => frames.delete(id);
class ResizeObserver {
  constructor(callback) { this.callback = callback; observer = this; }
  observe(target) { this.target = target; }
  disconnect() { this.disconnected = true; }
}
const load = (path, require = () => {}) => {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require, console, requestAnimationFrame, cancelAnimationFrame, ResizeObserver });
  return exports;
};
const zoom = load('../src/previewZoom.ts');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} / ${b}`);
const anchor = (layout, x, y) => ({ x: (layout.scrollLeft + x - layout.left) / layout.paperWidth, y: (layout.scrollTop + y - layout.top) / layout.paperHeight });
for (const [width, height] of [[600,800],[800,600],[300,300],[2400,1697]]) {
  const fitted = zoom.previewLayout(width, height, 620, 450);
  assert.ok(fitted.paperWidth <= 596 && fitted.paperHeight <= 426);
  near(fitted.paperWidth / fitted.paperHeight, width / height);
  const before = anchor(fitted, 360, 240), after = zoom.zoomPreviewAt(fitted, width, height, 3.2, 360, 240);
  near(anchor(after, 360, 240).x, before.x); near(anchor(after, 360, 240).y, before.y);
  const back = zoom.zoomPreviewAt(after, width, height, 1, 360, 240);
  near(back.scrollLeft, 0); near(back.scrollTop, 0);
}
assert.equal(zoom.clampPreviewZoom(NaN), 1); assert.equal(zoom.clampPreviewZoom(Infinity), 1);
assert.equal(zoom.clampPreviewZoom(0), .25); assert.equal(zoom.clampPreviewZoom(100), 8);
near(zoom.previewWheelScale(1, 2, 1, 450), zoom.previewWheelScale(1, 32, 0, 450));
near(zoom.previewWheelScale(1, 1, 2, 100), zoom.previewWheelScale(1, 100, 0, 100));
assert.equal(zoom.previewWheelScale(1, NaN, 0, 500), 1);
const fittedInvalid = zoom.previewLayout(Infinity, 0, NaN, -2);
assert.ok(Number.isFinite(fittedInvalid.paperWidth + fittedInvalid.paperHeight));

const listeners = new Map(), releaseListeners = new Map(), scales = [];
const outsideWindow = {
  addEventListener(type, listener) { if (!releaseListeners.has(type)) releaseListeners.set(type,new Set()); releaseListeners.get(type).add(listener); },
  removeEventListener(type, listener) { releaseListeners.get(type)?.delete(listener); },
};
const viewport = {
  ownerDocument: { defaultView: outsideWindow },
  clientWidth:620, clientHeight:450, clientLeft:0, clientTop:0, scrollLeft:0, scrollTop:0,
  addEventListener(type, listener, options) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); if (type === 'wheel') assert.equal(options.passive, false); },
  removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  getBoundingClientRect() { return {left:100,top:50,width:this.clientWidth,height:this.clientHeight}; },
};
const extent = {style:{}}, paper = {style:{}, originalImage:{src:'unchanged-full-page-raster'}};
function emit(type, values = {}) {
  const event = { ctrlKey:false,metaKey:false,deltaMode:0,deltaY:0,deltaX:0,clientX:460,clientY:290,button:0,pointerId:1,
    preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...values };
  for (const listener of listeners.get(type) ?? []) listener(event);
  for (const listener of releaseListeners.get(type) ?? []) listener(event);
  return event;
}
function flush() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } }
const controller = zoom.createPreviewZoomController(viewport, extent, paper, 600, 800, scale => scales.push(scale));
assert.equal(frames.size, 1); flush(); assert.equal(scales.at(-1), 1);
const fittedWidth = Number.parseFloat(paper.style.width), fittedHeight = Number.parseFloat(paper.style.height);
const nativeScroll = emit('wheel',{deltaY:80}); assert.equal(nativeScroll.prevented, undefined); assert.equal(frames.size,0,'Ordinary wheel keeps native preview scrolling');
for (let n=0;n<40;n++) { const event=emit('wheel',{ctrlKey:true,deltaY:-2}); assert.equal(event.prevented,true); assert.equal(event.stopped,true); }
assert.equal(frames.size,1,'Burst input coalesces into one paint'); assert.equal(scales.length,1);
flush(); assert.ok(scales.at(-1)>1); assert.ok(Number.parseFloat(paper.style.width)>fittedWidth);
// Once both axes overflow, the pointer anchor can be preserved without the
// necessary centering/scroll-edge clamp of a fitted page.
controller.zoomBy(3);flush();
let before=zoom.previewLayout(600,800,620,450,scales.at(-1));before.scrollLeft=viewport.scrollLeft;before.scrollTop=viewport.scrollTop;
const anchored=anchor(before,360,240);emit('wheel',{ctrlKey:true,deltaY:-90});flush();
let after=zoom.previewLayout(600,800,620,450,scales.at(-1));after.scrollLeft=viewport.scrollLeft;after.scrollTop=viewport.scrollTop;
near(anchor(after,360,240).x,anchored.x);near(anchor(after,360,240).y,anchored.y);
assert.equal(paper.originalImage.src,'unchanged-full-page-raster','Zoom retains the same decoded raster');

// A pending wheel frame must finish before a child captures its drawing bounds.
emit('wheel',{ctrlKey:true,deltaY:-30});assert.equal(frames.size,1);emit('pointerdown');assert.equal(frames.size,0);
const drawingScale=scales.at(-1);for(let n=0;n<10;n++)assert.equal(emit('wheel',{ctrlKey:true,deltaY:-20}).prevented,true);
assert.equal(emit('wheel',{deltaY:100}).prevented,true,'Keep captured page bounds stationary during drawing');
assert.equal(frames.size,0);assert.equal(scales.at(-1),drawingScale);
viewport.clientWidth=700;observer.callback();assert.equal(frames.size,0,'Resize also waits until the drawing gesture ends');
emit('pointerup');assert.equal(frames.size,1);flush();
emit('pointerdown');
for (const listener of releaseListeners.get('pointerup') ?? []) listener({pointerId:1});
emit('wheel',{ctrlKey:true,deltaY:-30});assert.equal(frames.size,1,'A release outside the preview unlocks zoom');flush();
controller.setDisabled(true);assert.equal(emit('wheel',{ctrlKey:true,deltaY:-60}).prevented,true);assert.equal(frames.size,0);controller.zoomBy(2);assert.equal(frames.size,0);
controller.setDisabled(false);for(let n=0;n<200;n++)emit('wheel',{ctrlKey:true,deltaY:-100});flush();assert.equal(scales.at(-1),8);
for(let n=0;n<200;n++)emit('wheel',{ctrlKey:true,deltaY:100});flush();assert.equal(scales.at(-1),.25);
controller.reset();flush();assert.equal(scales.at(-1),1);assert.equal(viewport.scrollLeft,0);assert.equal(viewport.scrollTop,0);
assert.notEqual(Number.parseFloat(paper.style.width),0);near(Number.parseFloat(paper.style.height),fittedHeight);

// Mount the production region pointer handlers against the zoomed DOM bounds.
// The selected normalized image region must be identical at multiple scales.
let host;
const react={useState(initial){const owner=host,n=owner.cursor++;if(!(n in owner.slots))owner.slots[n]=typeof initial==='function'?initial():initial;return[owner.slots[n],value=>owner.slots[n]=typeof value==='function'?value(owner.slots[n]):value];},useRef(value){const n=host.cursor++;return host.slots[n]??={current:value};},useEffect(effect,deps){const owner=host,n=owner.cursor++,old=owner.effects[n];if(!old||deps.some((value,i)=>value!==old.deps[i]))owner.pending.push(()=>{old?.cleanup?.();owner.effects[n]={deps,cleanup:effect()};});}};
const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
const geometry=load('../src/imageGeometry.ts');
const region=load('../src/components/RegionSelection.tsx',name=>{if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;if(name==='../imageGeometry')return geometry;if(name==='../i18n')return{useI18n:()=>({t:(zh,en)=>en??zh})};if(name==='./PreviewZoom')return{PreviewZoom:'PreviewZoom'};throw new Error(name);});
function find(node,predicate){if(!node||typeof node!=='object')return;if(Array.isArray(node)){for(const child of node){const result=find(child,predicate);if(result)return result;}return;}return predicate(node)?node:find(node.props?.children,predicate);}
for(const scale of [1,2.5,8]){
  controller.reset();flush();controller.zoomBy(scale);flush();
  const bounds={left:100+Number.parseFloat(paper.style.left)-viewport.scrollLeft,top:50+Number.parseFloat(paper.style.top)-viewport.scrollTop,width:Number.parseFloat(paper.style.width),height:Number.parseFloat(paper.style.height)};
  const surface={getBoundingClientRect:()=>bounds,focus(){},setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}};
  const props={image:{id:'page',width:600,height:800,dataUrl:'unchanged-full-page-raster'},crop:null,shape:'rectangle',disabled:false,allowMultiple:true,zoomable:true,onChange:value=>props.crop=value};
  host={cursor:0,slots:[],effects:[],pending:[]};const tree=region.RegionSelection(props);for(const effect of host.pending)effect();
  const node=find(tree,node=>node.props.className?.split(' ').includes('region-selection-surface'));node.props.ref.current=surface;
  const pointer=(x,y)=>({button:0,pointerId:2,clientX:bounds.left+x*bounds.width,clientY:bounds.top+y*bounds.height,currentTarget:surface,preventDefault(){}});
  node.props.onPointerDown(pointer(.1,.2));node.props.onPointerMove(pointer(.4,.55));node.props.onPointerUp(pointer(.4,.55));
  near(props.crop.x,.1);near(props.crop.y,.2);near(props.crop.width,.3);near(props.crop.height,.35);
  for(const effect of host.effects)effect?.cleanup?.();
}
emit('wheel',{ctrlKey:true,deltaY:-30});assert.equal(frames.size,1);controller.destroy();assert.equal(frames.size,0);assert.equal(observer.disconnected,true);
assert.equal([...listeners.values()].reduce((sum,list)=>sum+list.size,0),0,'Every native input listener is removed');
assert.equal([...releaseListeners.values()].reduce((sum,list)=>sum+list.size,0),0,'Window release listeners are removed');
console.log('PASS: all aspect ratios, pointer-anchored zoom, wheel unit normalization, 25–800% bounds, one paint per frame, ordinary scrolling, drawing/resize locks, disabled updates without reset, unchanged raster, production crop coordinates at 1×/2.5×/8×, and listener/frame cleanup');
