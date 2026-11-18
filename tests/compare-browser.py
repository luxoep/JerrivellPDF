# SPDX-License-Identifier: MIT OR Apache-2.0
"""Real comparison React workspace; synthetic IPC only, never customer drawings."""
from pathlib import Path
import hashlib,json,re,socket,subprocess,sys,time,traceback,urllib.request
ROOT=Path(__file__).resolve().parents[1];VERSION=json.loads((ROOT/'package.json').read_text())['version']
sys.path.insert(0,str(ROOT/'test-results/0.8.3/browser-tools'))
from playwright.sync_api import sync_playwright
HARNESS=r'''
import React from 'react';import{createRoot}from'react-dom/client';import CompareApp from '/src/compare/CompareApp';
import '/src/styles.css';import '/src/jerry-theme.css';import '/src/ui-polish.css';import '/src/compare/compare.css';
const stats=window.stats={calls:[],guard:true,dialogs:['C:/old.pdf','C:/new.pdf'],save:'C:/comparison.csv',exports:[],hold:false,closed:0,task:'compare',plan:null,alignmentReliable:true,failBatch:false,pages:{},textStatus:'available',options:null,progress:{jobId:'',status:'idle',completed:0,total:0,report:null,error:null}};
const canvas=document.createElement('canvas');canvas.width=600;canvas.height=800;const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,600,800);c.strokeStyle='#234d62';c.lineWidth=2;c.strokeRect(40,80,500,500);c.beginPath();c.arc(220,300,70,0,Math.PI*2);c.stroke();c.fillStyle='#234d62';c.font='24px Arial';c.fillText('M8 +0.02',70,650);const picture={dataUrl:canvas.toDataURL(),width:600,height:800};
const mask=document.createElement('canvas');mask.width=600;mask.height=800;const mc=mask.getContext('2d');mc.fillStyle='#d22676';mc.fillRect(110,150,12,8);mc.fillStyle='#0b9d51';mc.fillRect(360,500,5,5);const overlay={dataUrl:mask.toDataURL(),width:600,height:800};
let callbackId=0,listenerId=0,polls=0;const callbacks=new Map(),listeners=new Map();
const region=(id,x,y,w,h,pixels)=>({id,bounds:{x,y,width:w,height:h},pixels,added:id===2?pixels:0,removed:id===1?pixels:0,changed:0,point:[x,y]});
const testFrame=o=>{const a=(stats.pages.a??[{width:600,height:800},{width:600,height:800}])[o.pageA],b=(stats.pages.b??[{width:600,height:800},{width:600,height:800}])[o.pageB];const k=o.scaleMode==='normalized'?Math.min(a.width/b.width,a.height/b.height):1;const dx=(o.scaleMode==='normalized'?(a.width-b.width*k)/2:0)+o.offsetXmm*72/25.4,dy=(o.scaleMode==='normalized'?(a.height-b.height*k)/2:0)+o.offsetYmm*72/25.4;const x=Math.min(0,dx),y=Math.min(0,dy);return{widthPt:Math.max(a.width,dx+b.width*k)-x,heightPt:Math.max(a.height,dy+b.height*k)-y,originXPt:x,originYPt:y,uncovered:Math.abs(a.width-b.width*k)>.001||Math.abs(a.height-b.height*k)>.001||Math.abs(dx)>.001||Math.abs(dy)>.001}};
const report=()=>({jobId:stats.progress.jobId,options:Object.fromEntries(Object.entries(stats.options).reverse()),...testFrame(stats.options),pixelWidth:2500,pixelHeight:3333,changedPixels:stats.options.ignored.length?0:25,ignoredPixels:stats.options.ignored.length?1000:0,regions:stats.options.ignored.length?[]:[region(1,.18,.18,.025,.02,20),region(2,.6,.62,.006,.006,5)],mask:overlay,tileCount:12});
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'compare'},currentWebview:{label:'compare'}},transformCallback(fn){const id=++callbackId;callbacks.set(id,fn);return id;},unregisterCallback(id){callbacks.delete(id);},async invoke(command,args={}){
 stats.calls.push({command,args:JSON.parse(JSON.stringify(args))});
 if(command==='plugin:event|listen'){const id=++listenerId;listeners.set(id,{event:args.event,handler:args.handler});return id;}
 if(command==='plugin:event|unlisten'){listeners.delete(args.eventId);return;}
 if(command==='plugin:dialog|open')return stats.dialogs.shift()??null;
 if(command==='plugin:dialog|save')return stats.save;
 if(command==='compare_close'){stats.closed++;return;}
 if(command==='compare_reset'){stats.progress={jobId:'',status:'idle',completed:0,total:0,report:null,error:null};return;}
 if(command==='compare_poll'){
  if(stats.progress.status==='running'&&!stats.hold&&++polls>=2){
   stats.progress={...stats.progress,status:'complete',completed:12,total:12,report:null};
   if(stats.task==='align')stats.progress.alignment={options:stats.options,offsetXmm:-2.54,offsetYmm:1.27,reliable:stats.alignmentReliable,agreement:.98,ambiguityMargin:.5,reason:'translation-only',samples:1200};
   else if(stats.task==='batch'){const pairs=stats.plan.pairs;stats.progress.batch={jobId:stats.progress.jobId,allAnalyzed:!stats.failBatch,items:pairs.map((options,index)=>({index,options,status:stats.failBatch&&index===1?'failed':'complete',changedPixels:stats.failBatch&&index===1?null:25,regionCount:stats.failBatch&&index===1?null:2,ignoredPixels:0,uncovered:false,error:stats.failBatch&&index===1?'Unreliable translation':null,alignment:null})),unpairedA:(stats.pages.a??[{},{},{}]).map((_,i)=>i).filter(i=>!pairs.some(v=>v.pageA===i)),unpairedB:(stats.pages.b??[{},{}]).map((_,i)=>i).filter(i=>!pairs.some(v=>v.pageB===i))};}
   else stats.progress.report=report();
  }
  return{guardReady:stats.guard,progress:JSON.parse(JSON.stringify(stats.progress))};
 }
 if(command==='compare_call'){
  const{command:kind,args:input}=args;
  if(kind==='open')return{fileName:input.path.split('/').pop(),fileSize:100,pageCount:2,pages:stats.pages[input.side]??[{width:600,height:800},{width:600,height:800}]};
  if(kind==='page_preview')return picture;
  if(kind==='clear')return{cleared:input.side};
  if(kind==='text_assist')return{status:stats.textStatus,limited:false,changes:stats.textStatus==='available'?[{old:'M8 +0.02',new:'M10 -0.02',dimensionLike:true}]:[]};
  if(kind==='export_batch'){stats.exports.push(input);return{bytes:100};}
  if(kind==='preview')return{a:picture,b:picture,...testFrame(input.options)};
  if(kind==='start'){polls=0;stats.task=input.task??'compare';stats.plan=input;stats.options=JSON.parse(JSON.stringify(input.options));stats.progress={jobId:input.jobId,status:'running',completed:0,total:12,report:null,error:null};return{jobId:input.jobId};}
  if(kind==='cancel'){stats.progress={...stats.progress,status:'cancelled',report:null};return{accepted:true};}
  if(kind==='export'){stats.exports.push(JSON.parse(JSON.stringify(input)));return{bytes:123,regions:2};}
  throw Error(kind);
 }
 throw Error(command);
}};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(id){listeners.delete(id)}};
window.harness={snapshot(){return JSON.parse(JSON.stringify(stats));},close(){for(const[id,l]of listeners)if(l.event==='tauri://close-requested')callbacks.get(l.handler)?.({id,event:l.event,payload:null})},crash(){stats.progress={...stats.progress,status:'failed',report:null,error:'COMPARE_RESET: synthetic comparison worker stopped'}}};
createRoot(document.getElementById('root')).render(<React.StrictMode><CompareApp/></React.StrictMode>);
'''
HTML='<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="./compare-harness.tsx"></script>'
SOURCES=['src/compare/CompareApp.tsx','src/compare/client.ts','src/compare/types.ts','src/compare/compare.css','tests/compare-browser.py','src/compare/geometry.ts','src/compare/pairs.ts','src/compare/DetailDock.tsx','src/compare/BatchDialog.tsx','src/compare/useDialogFocus.ts','src/compare/useSourcePreview.ts']
def snap(p):return p.evaluate('harness.snapshot()')
def calls(p,kind):return [c for c in snap(p)['calls'] if c['command']=='compare_call' and c['args']['command']==kind]
def fresh(p,url):
 p.goto(url+'?lang=en-US',wait_until='domcontentloaded',timeout=45000);p.get_by_text('External resources blocked',exact=True).wait_for()
def opened(p,url):
 fresh(p,url);p.get_by_role('button',name='Choose A',exact=True).click();p.get_by_role('button',name='Choose B',exact=True).click();p.locator('.compare-paper-image').first.wait_for();p.wait_for_timeout(260)
def analyzed(p,url):
 opened(p,url);p.get_by_role('button',name='Compare drawings',exact=True).click();p.get_by_text('2 difference regions',exact=True).wait_for();p.locator('.compare-region-row').first.wait_for();p.wait_for_timeout(120)
def basic(p,url):
 analyzed(p,url);assert len(calls(p,'start'))==1;assert len(calls(p,'open'))==2
 assert p.locator('.compare-region-row').count()==2;assert p.locator('.compare-mask').count()==2
 p.locator('.compare-region-row').nth(1).click();p.get_by_text('Difference 2 · Detail',exact=True).wait_for();p.get_by_alt_text('New drawing detail').wait_for();p.get_by_label('Manually reviewed',exact=True).check()
 assert p.locator('.compare-region-row').nth(1).locator('svg').count()==1
 p.get_by_role('button',name='Difference CSV',exact=True).click();p.wait_for_function('stats.exports.length===1');saved=snap(p)['exports'][0];assert saved['reviewed']==[2] and saved['kind']=='csv'
 p.get_by_role('button',name='Marked PNG',exact=True).click();p.wait_for_function('stats.exports.length===2');assert snap(p)['exports'][1]['jobId']==saved['jobId']
 return {'tinyChangeShown':True,'detail':True,'reviewExport':True,'pngExport':True}
def stale_and_fields(p,url):
 analyzed(p,url);field=p.get_by_label('B horizontal offset',exact=True);field.fill('');assert field.input_value()=='';assert p.get_by_role('button',name='Run again',exact=True).is_disabled();assert p.get_by_role('button',name='Difference CSV',exact=True).is_disabled()
 field.fill('1.25');p.get_by_text(re.compile('Settings changed')).wait_for();assert p.get_by_role('button',name='Difference CSV',exact=True).is_disabled()
 field.fill('0');p.get_by_role('combobox',name='Analysis DPI',exact=False) if False else None
 p.locator('.compare-options select').first.select_option('150');p.get_by_role('button',name='Run again',exact=True).click();p.wait_for_function('stats.options.dpi===150&&stats.progress.status==="complete"');p.get_by_role('button',name='Difference CSV',exact=True).wait_for();assert not p.get_by_role('button',name='Difference CSV',exact=True).is_disabled()
 return {'blankNumericDraftAllowed':True,'staleExportBlocked':True,'explicitDpiUsed':150}
def zoom_pan_and_idle(p,url):
 opened(p,url);pane=p.locator('.compare-viewport').first;b=pane.bounding_box();before=p.locator('.compare-sheet').first.bounding_box()['width'];p.mouse.move(b['x']+b['width']*.55,b['y']+b['height']*.45);p.keyboard.down('Control');p.mouse.wheel(0,-400);p.mouse.wheel(0,-400);p.keyboard.up('Control');p.wait_for_timeout(400);after=p.locator('.compare-sheet').first.bounding_box()['width'];assert after>before*1.5,(before,after)
 # Drag empty paper, away from regions, and compare both viewport scroll positions.
 p.mouse.move(b['x']+b['width']*.7,b['y']+b['height']*.75);p.mouse.down();p.mouse.move(b['x']+b['width']*.5,b['y']+b['height']*.5,steps=8);p.mouse.up();p.wait_for_timeout(60)
 positions=p.locator('.compare-viewport').evaluate_all('(nodes)=>nodes.map(n=>[n.scrollLeft,n.scrollTop])');assert positions[0]==positions[1],positions;assert positions[0][1]>0,positions
 p.get_by_role('button',name='Overlay',exact=True).click();p.wait_for_timeout(350);count=len(calls(p,'preview'));slider=p.get_by_role('slider',name='B display proportion');slider.fill('0.2');slider.fill('0.8');p.wait_for_timeout(300);assert len(calls(p,'preview'))==count
 count=len(snap(p)['calls']);width=p.locator('.compare-sheet').first.bounding_box()['width'];p.wait_for_timeout(450);assert len(snap(p)['calls'])==count;assert abs(p.locator('.compare-sheet').first.bounding_box()['width']-width)<.1
 return {'ctrlWheel':True,'synchronizedPan':positions,'opacityLocalOnly':True,'noIdleCalls':True,'stableLayout':True}
def exclusions(p,url):
 analyzed(p,url);p.get_by_role('button',name='Draw ignored area',exact=True).click();box=p.locator('.compare-hit-layer').first.bounding_box();p.mouse.move(box['x']+box['width']*.08,box['y']+box['height']*.08);p.mouse.down();p.mouse.move(box['x']+box['width']*.3,box['y']+box['height']*.3,steps=8);p.mouse.up();p.get_by_role('button',name='Clear 1 exclusions',exact=True).wait_for();assert p.get_by_role('button',name='Difference CSV',exact=True).is_disabled();p.get_by_role('button',name='Run again',exact=True).click();p.get_by_text('No pixel differences under these settings',exact=True).wait_for();assert len(snap(p)['options']['ignored'])==1;p.get_by_text(re.compile('Qualified result')).wait_for()
 return {'draggedExclusionRecorded':True,'qualifiedZero':True}
def alignment(p,url):
 opened(p,url);p.get_by_role('button',name='Point alignment',exact=True).click();boxes=p.locator('.compare-hit-layer').all();a,b=[v.bounding_box() for v in boxes];p.mouse.click(a['x']+a['width']*.2,a['y']+a['height']*.2);p.mouse.click(b['x']+b['width']*.21,b['y']+b['height']*.2);value=float(p.get_by_label('B horizontal offset',exact=True).input_value());assert abs(value+2.1167)<.05,value;assert not calls(p,'start')
 return {'translationOnly':value,'noAutomaticAnalysis':True}
def cancel_crash(p,url):
 opened(p,url);p.evaluate('stats.hold=true');p.get_by_role('button',name='Compare drawings',exact=True).click();p.get_by_role('button',name='Stop',exact=True).wait_for();p.get_by_role('button',name='Stop',exact=True).click();p.get_by_text('Analysis cancelled; no complete conclusion.',exact=True).wait_for();assert p.get_by_role('button',name='Difference CSV',exact=True).is_disabled();assert len(calls(p,'cancel'))==1
 p.get_by_role('button',name='Compare drawings',exact=True).click();p.get_by_role('button',name='Stop',exact=True).wait_for();p.evaluate('harness.crash()');p.get_by_role('button',name='Choose A',exact=True).wait_for();p.wait_for_function('document.querySelectorAll(".compare-paper-image").length===0');assert p.get_by_role('button',name='Compare drawings',exact=True).is_disabled()
 assert all(c['command'].startswith(('compare_','plugin:')) for c in snap(p)['calls'])
 return {'cancelledNoConclusion':True,'workerFailureClearsOnlyComparison':True,'noMainEditorIpc':True}
def close_guard(p,url):
 analyzed(p,url);p.get_by_label('Manually reviewed',exact=True).check()
 before=len(calls(p,'open'));p.get_by_role('button',name='Choose B',exact=True).click();p.get_by_role('dialog').wait_for();assert len(calls(p,'open'))==before
 p.get_by_role('button',name='Keep working',exact=True).click();p.evaluate('harness.close()');p.get_by_role('dialog').wait_for();p.get_by_role('button',name='Keep working',exact=True).click();assert snap(p)['closed']==0;p.get_by_role('button',name='Difference CSV',exact=True).click();p.wait_for_function('stats.exports.length===1');p.evaluate('harness.close()');p.wait_for_function('stats.closed===1');assert p.get_by_role('dialog').count()==0
 return {'dirtySourceReplacementGuard':True,'dirtyCloseGuard':True,'csvRetainsReview':True,'closeOwnWindowOnly':True}

def responsive(p,url):
 opened(p,url);samples=[]
 for width,height in [(1100,740),(1480,940),(1920,1080)]:
  p.set_viewport_size({'width':width,'height':height});p.get_by_role('button',name='Overlay',exact=True).click();p.wait_for_timeout(500)
  assert p.evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Outer horizontal overflow'
  assert p.locator('.compare-view-tools').evaluate('(el)=>Array.from(el.querySelectorAll("button,input")).every(n=>n.getBoundingClientRect().right<=el.getBoundingClientRect().right+1)'), 'Toolbar controls overlap results'
  count=len(calls(p,'preview'))
  values=p.locator('.compare-sheet').first.evaluate('el=>new Promise(resolve=>{const frames=[];function sample(){const r=el.getBoundingClientRect();frames.push([r.width,r.height]);frames.length<20?requestAnimationFrame(sample):resolve(frames)}sample()})')
  assert all(abs(v[0]-values[0][0])<.1 and abs(v[1]-values[0][1])<.1 for v in values),values
  assert len(calls(p,'preview'))==count,'Idle preview must not rerender continuously'
  samples.append({'viewport':[width,height],'stationaryFrames':len(values),'idleRenderRequests':0})
 return {'layouts':samples}
def guard(p,url):
 fresh(p,url);p.reload(wait_until='domcontentloaded');p.evaluate('stats.guard=false');# change during the first guard query/retry
 p.wait_for_timeout(60)
 # The native layer independently denies unsafe reads; the UI state eventually
 # reflects a fresh guard check after language toggling.
 p.get_by_role('combobox',name='Interface language',exact=True).select_option('zh-CN');p.get_by_role('button',name='选择 A',exact=True).wait_for();p.wait_for_timeout(400);assert p.get_by_role('button',name='选择 A',exact=True).is_disabled();assert not calls(p,'open');p.evaluate('stats.guard=true');p.wait_for_timeout(350);assert not p.get_by_role('button',name='选择 A',exact=True).is_disabled()
 return {'failClosedBeforeGuard':True,'noSourceReads':True}
def mixed_size_clear(p,url):
 fresh(p,url);p.evaluate("stats.pages={a:[{width:600,height:800}],b:[{width:2400,height:3200}]}")
 p.get_by_role('button',name='Choose A',exact=True).click();p.get_by_role('button',name='Choose B',exact=True).click();p.locator('.compare-paper-image').nth(1).wait_for();p.wait_for_timeout(300)
 sizes=p.locator('.compare-sheet').evaluate_all('ns=>ns.map(n=>[n.clientWidth,n.clientHeight])');assert sizes[0]==sizes[1],sizes
 p.get_by_role('button',name='Zoom in comparison',exact=True).click();p.wait_for_timeout(350);z=p.locator('.compare-sheet').evaluate_all('ns=>ns.map(n=>n.clientWidth)');assert z[0]==z[1] and z[0]>sizes[0][0]
 before=p.locator('.compare-paper-image').nth(1).get_attribute('src');p.get_by_role('button',name='Clear A',exact=True).click();p.get_by_role('button',name='Choose A',exact=True).wait_for();p.wait_for_timeout(250)
 assert p.locator('[data-source-side="b"] img.compare-paper-image').get_attribute('src')==before
 assert len(calls(p,'open'))==2 and len(calls(p,'clear'))==1;assert not [c for c in snap(p)['calls'] if c['command']=='compare_reset']
 assert p.get_by_role('button',name='Compare drawings',exact=True).is_disabled();p.get_by_role('button',name='Clear B',exact=True).click();p.wait_for_timeout(200);assert p.locator('.compare-paper-image').count()==0
 return {'mixedPaperFitEqual':sizes,'zoomRemainsRelative':z,'clearEachPreservesOtherSource':True}

def large_detail(p,url):
 analyzed(p,url);p.get_by_alt_text('New drawing detail').wait_for();dock=p.locator('.compare-detail-dock');height=dock.bounding_box()['height'];assert height>=250
 p.get_by_role('button',name='Expand details',exact=True).click();assert dock.bounding_box()['height']>=700
 p.get_by_alt_text('New drawing detail').wait_for();p.get_by_role('button',name='Zoom detail in',exact=True).click();p.wait_for_timeout(500)
 frames=p.locator('.compare-detail-paper').evaluate('n=>new Promise(done=>{let v=[];const sample=()=>{let b=n.getBoundingClientRect();v.push([b.width,b.height]);v.length<25?requestAnimationFrame(sample):done(v)};sample()})');assert all(v==frames[0] for v in frames),frames
 count=len(calls(p,'preview'));p.wait_for_timeout(400);assert len(calls(p,'preview'))==count
 p.keyboard.press('Escape');assert 'expanded' not in dock.get_attribute('class')
 p.get_by_role('separator',name='Resize detail height',exact=True).focus();p.keyboard.press('ArrowUp');assert dock.bounding_box()['height']>height
 return {'dockHeight':height,'expandedHeightAtLeast':700,'stationaryFrames':25,'idleRenders':0,'resizable':True}

def auto_alignment(p,url):
 analyzed(p,url);p.get_by_label('Manually reviewed',exact=True).check();p.get_by_role('button',name='Auto translation',exact=True).click();p.get_by_role('button',name='Apply translation',exact=True).wait_for();p.wait_for_timeout(100)
 assert p.get_by_label('B horizontal offset',exact=True).input_value()=='0';assert p.get_by_label('Manually reviewed',exact=True).is_checked()
 p.get_by_role('button',name='Apply translation',exact=True).click();p.get_by_role('dialog').wait_for();p.get_by_role('button',name='Continue',exact=True).click();assert p.get_by_label('B horizontal offset',exact=True).input_value()=='-2.54';assert p.get_by_role('button',name='Difference CSV',exact=True).is_disabled()
 opened(p,url);p.evaluate('stats.alignmentReliable=false');p.get_by_role('button',name='Auto translation',exact=True).click();p.get_by_text(re.compile('Unreliable; align manually')).wait_for();assert p.get_by_role('button',name='Apply translation',exact=True).is_disabled()
 return {'proposalDoesNotAutoApply':True,'reviewRetainedUntilConfirmation':True,'staleExportBlocked':True,'unreliableApplicationBlocked':True}

def batches(p,url):
 fresh(p,url);p.evaluate('stats.pages={a:[{width:600,height:800},{width:600,height:800},{width:600,height:800}],b:[{width:600,height:800},{width:600,height:800}]};stats.failBatch=true')
 p.get_by_role('button',name='Choose A',exact=True).click();p.get_by_role('button',name='Choose B',exact=True).click();p.get_by_role('button',name='Multi-page',exact=True).click();p.get_by_role('button',name='Generate pairs',exact=True).click()
 assert p.get_by_role('textbox',name='A pair 1',exact=True).input_value()=='1';p.get_by_role('textbox',name='A pair 1',exact=True).fill('');assert p.get_by_role('button',name='Start batch comparison',exact=True).is_disabled();p.get_by_role('textbox',name='A pair 1',exact=True).fill('1')
 p.get_by_role('textbox',name='A pair 2',exact=True).fill('1');p.get_by_role('textbox',name='B pair 2',exact=True).fill('1');assert p.get_by_role('button',name='Start batch comparison',exact=True).is_disabled();p.get_by_role('textbox',name='A pair 2',exact=True).fill('2');p.get_by_role('textbox',name='B pair 2',exact=True).fill('2')
 p.get_by_role('button',name='Start batch comparison',exact=True).click();p.get_by_text('Some pairs could not be analyzed',exact=True).wait_for();p.get_by_text('Unpaired or not included: A 1 pages · B 0 pages',exact=True).wait_for();assert p.locator('.compare-batch-row').count()==2
 p.get_by_role('button',name='Export batch CSV',exact=True).click();p.wait_for_function('stats.exports.length===1');assert calls(p,'export_batch')[0]['args']['args']['jobId']==snap(p)['progress']['jobId']
 p.locator('.compare-batch-row').first.click();p.get_by_text('2 difference regions',exact=True).wait_for();assert snap(p)['options']['pageA']==0
 p.get_by_role('button',name='Text and dimension assistance',exact=True).click();p.get_by_text('M10 -0.02',exact=True).wait_for();assert p.locator('.compare-text-changes').inner_text().find('M8 +0.02')>=0
 return {'blankDraftAllowed':True,'duplicatePairBlocked':True,'unpairedAndFailedExplicit':True,'csvJobBound':True,'inspectRerunsPair':True,'dimensionSignsPreserved':True}

def text_and_batch_cancel(p,url):
 analyzed(p,url);p.evaluate('stats.textStatus="restricted"');p.get_by_role('button',name='Text and dimension assistance',exact=True).click();p.get_by_text('Copy permissions are restricted or unverified; visual comparison remains available.',exact=True).wait_for();assert p.locator('.compare-text-changes').inner_text()==''
 p.get_by_role('button',name='Multi-page',exact=True).click();p.get_by_role('button',name='Generate pairs',exact=True).click();p.evaluate('stats.hold=true');p.get_by_role('button',name='Start batch comparison',exact=True).click();p.get_by_role('button',name='Stop',exact=True).click();p.get_by_text('Analysis cancelled; no complete conclusion.',exact=True).wait_for();assert p.get_by_role('button',name='Export batch CSV',exact=True).count()==0
 return {'restrictedTextHasVisualFallback':True,'cancelledBatchCannotExport':True}

def button_layout(p,url):
 analyzed(p,url);p.get_by_alt_text('New drawing detail').wait_for();samples=[]
 groups=['.compare-header','.compare-source-card','.compare-options','.compare-view-tools','.compare-segment','.compare-tool-toggles','.compare-view-footer','.compare-export','.compare-detail-header','.compare-detail-dock>footer','.compare-list-controls','.compare-result-tabs','.compare-batch-ranges','.compare-batch-dialog>footer','.compare-alignment-proposal','.compare-app .modal-actions']
 def check():
  data=p.evaluate('''selectors=>{const failures=[];let buttons=0,groups=0;for(const selector of selectors)for(const group of document.querySelectorAll(selector)){const g=group.getBoundingClientRect();if(!g.width||!g.height)continue;groups++;const children=[...group.children].filter(n=>{const b=n.getBoundingClientRect();return b.width&&b.height});for(let i=0;i<children.length;i++){const a=children[i],r=a.getBoundingClientRect();if(r.left<g.left-1||r.right>g.right+1)failures.push(selector+': child outside container');for(const b of children.slice(i+1)){const s=b.getBoundingClientRect();if(Math.min(r.right,s.right)-Math.max(r.left,s.left)>1&&Math.min(r.bottom,s.bottom)-Math.max(r.top,s.top)>1)failures.push(selector+': overlapping controls')}}for(const b of group.querySelectorAll('button')){buttons++;if(b.scrollWidth>b.clientWidth+2||b.scrollHeight>b.clientHeight+2)failures.push(selector+': clipped '+(b.ariaLabel||b.textContent))}}return{groups,buttons,failures}}''',groups)
  assert not data['failures'],data
  return data
 for width,height in [(1100,740),(1280,800),(1480,940)]:
  p.set_viewport_size({'width':width,'height':height})
  for language in ['en-US','zh-CN']:
   p.get_by_role('combobox').first.select_option(language);p.wait_for_timeout(350);data=check()
   buttons=p.locator('.compare-export>.button').all();a,b=[v.bounding_box()for v in buttons];assert b['y']-(a['y']+a['height'])>=7.5,(a,b)
   assert abs(a['width']-b['width'])<1 and a['width']>220
   samples.append({'viewport':[width,height],'language':language,'exportGap':round(b['y']-a['y']-a['height'],2),**data})
 p.get_by_role('combobox').first.select_option('en-US');p.get_by_role('button',name='Expand details',exact=True).click();check();p.keyboard.press('Escape')
 p.get_by_role('button',name='Multi-page',exact=True).click();check();p.get_by_role('button',name='Generate pairs',exact=True).click();check();p.get_by_role('button',name='Close page pairing',exact=True).click()
 p.get_by_role('button',name='Auto translation',exact=True).click();p.get_by_role('button',name='Apply translation',exact=True).wait_for();check()
 p.get_by_label('Manually reviewed',exact=True).check();p.get_by_role('button',name='Clear A',exact=True).click();p.get_by_role('dialog').wait_for();check();p.get_by_role('button',name='Keep working',exact=True).click()
 count=len(snap(p)['calls']);p.wait_for_timeout(450);assert len(snap(p)['calls'])==count
 return {'layouts':samples,'expandedDetailBatchAlignmentAndConfirmationChecked':True,'idleRequests':0}

def normalized_analysis(p,url):
 fresh(p,url);selector=p.get_by_role('combobox',name='Analysis scale mode',exact=True);assert selector.input_value()=='normalized'
 p.evaluate('stats.pages={a:[{width:600,height:800},{width:600,height:800}],b:[{width:2400,height:3200},{width:2400,height:3200}]}')
 p.get_by_role('button',name='Choose A',exact=True).click();p.get_by_role('button',name='Choose B',exact=True).click();p.locator('.compare-paper-image').nth(1).wait_for()
 p.get_by_role('button',name='Compare drawings',exact=True).click();p.get_by_text('2 difference regions',exact=True).wait_for();assert snap(p)['options']['scaleMode']=='normalized'
 boxes=p.locator('.compare-hit-layer').evaluate_all('ns=>ns.map(n=>n.getAttribute("viewBox"))');assert boxes[0]==boxes[1],boxes
 assert not p.get_by_role('button',name='Difference CSV',exact=True).is_disabled()
 selector.select_option('physical');assert p.get_by_role('button',name='Difference CSV',exact=True).is_disabled();p.wait_for_timeout(200)
 physical=p.locator('.compare-hit-layer').evaluate_all('ns=>ns.map(n=>n.getAttribute("viewBox"))');assert physical[0]!=physical[1],physical
 p.get_by_role('button',name='Overlay',exact=True).click();p.wait_for_timeout(400);assert calls(p,'preview')[-1]['args']['args']['options']['scaleMode']=='physical'
 selector.select_option('normalized');p.wait_for_timeout(400);assert calls(p,'preview')[-1]['args']['args']['options']['scaleMode']=='normalized'
 p.get_by_role('button',name='Side by side',exact=True).click();p.get_by_role('button',name='Multi-page',exact=True).click();p.get_by_role('button',name='Generate pairs',exact=True).click();p.get_by_role('button',name='Start batch comparison',exact=True).click();p.get_by_text('All requested pairs analyzed',exact=True).wait_for()
 assert all(o['scaleMode']=='normalized' for o in snap(p)['plan']['pairs']);selector.select_option('physical');p.locator('.compare-batch-row').first.click();p.get_by_text('2 difference regions',exact=True).wait_for()
 assert selector.input_value()=='normalized' and snap(p)['options']['scaleMode']=='normalized'
 p.get_by_role('button',name='Auto translation',exact=True).click();p.get_by_role('button',name='Apply translation',exact=True).wait_for();assert snap(p)['options']['scaleMode']=='normalized'
 return {'defaultUnifiedAnalysis':True,'maskUsesNormalizedCoordinates':boxes,'physicalModeInvalidatesExport':True,'overlayModeUsesCurrentGeometry':True,'batchCarriesAndRestoresMode':True,'alignmentUsesNormalizedMode':True}

def normalized_aspect_ratio(p,url):
 fresh(p,url);p.evaluate('stats.pages={a:[{width:600,height:800}],b:[{width:1200,height:600}]}')
 p.get_by_role('button',name='Choose A',exact=True).click();p.get_by_role('button',name='Choose B',exact=True).click();p.locator('.compare-paper-image').nth(1).wait_for();p.wait_for_timeout(250)
 sizes=p.locator('.compare-sheet').evaluate_all('ns=>ns.map(n=>({w:parseFloat(n.style.width),h:parseFloat(n.style.height)}))');assert abs(sizes[0]['h']/sizes[0]['w']-800/600)<.001 and abs(sizes[1]['h']/sizes[1]['w']-.5)<.001,sizes
 p.get_by_role('button',name='Compare drawings',exact=True).click();p.get_by_text('2 difference regions',exact=True).wait_for();assert snap(p)['progress']['report']['uncovered']
 count=len(calls(p,'start'));p.get_by_role('checkbox',name='Fit each viewport',exact=True).uncheck();p.wait_for_timeout(400);assert len(calls(p,'start'))==count and p.get_by_role('combobox',name='Analysis scale mode',exact=True).input_value()=='normalized'
 return {'aspectRatioRetained':sizes,'coverageDifferenceExplicit':True,'viewportFitDoesNotChangeAnalysisMode':True}

def main():
 out=ROOT/f'test-results/{VERSION}';out.mkdir(parents=True,exist_ok=True);(out/'compare-harness.html').write_text(HTML,encoding='utf-8');(out/'compare-harness.tsx').write_text(HARNESS,encoding='utf-8')
 report={'sourceSha256':{s:hashlib.sha256((ROOT/s).read_bytes()).hexdigest()for s in SOURCES},'cases':[],'pageErrors':[]}
 with socket.socket()as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 log=(out/'compare-vite.log').open('w',encoding='utf-8');server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',str(port),'--strictPort'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
 try:
  url=f'http://127.0.0.1:{port}/test-results/{VERSION}/compare-harness.html'
  for _ in range(100):
   try:urllib.request.urlopen(url,timeout=.3).close();break
   except Exception:time.sleep(.1)
  with sync_playwright()as pw:
   browser=pw.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True);context=browser.new_context(viewport={'width':1480,'height':1000});page=context.new_page();page.set_default_timeout(9000);page.on('pageerror',lambda e:report['pageErrors'].append(str(e)))
   for name,run in [('native-boundary-and-review-export',basic),('stale-result-and-flexible-fields',stale_and_fields),('zoom-pan-overlay-and-idle',zoom_pan_and_idle),('ignored-area-qualification',exclusions),('manual-point-alignment',alignment),('cancel-and-isolated-worker-failure',cancel_crash),('review-close-protection',close_guard),('external-guard-fail-closed',guard),('responsive-stationary-preview',responsive),('mixed-size-fit-and-side-clear',mixed_size_clear),('large-resizable-stable-details',large_detail),('automatic-translation-confirmation',auto_alignment),('multi-page-pairing-and-findings',batches),('restricted-text-and-batch-cancel',text_and_batch_cancel),('translated-button-groups-and-export-spacing',button_layout),('normalized-analysis-mode-coordinates-and-batch',normalized_analysis),('normalized-aspect-and-view-only-fit',normalized_aspect_ratio)]:
    case={'name':name}
    try:case.update(status='PASS',result=run(page,url))
    except Exception as e:case.update(status='FAIL',error=str(e),traceback=traceback.format_exc(),body=page.locator('body').inner_text()[:2500])
    page.screenshot(path=str(out/f'compare-{name}.png'));report['cases'].append(case);print(json.dumps({k:v for k,v in case.items()if k not in ['traceback','body']},ensure_ascii=False),flush=True)
   browser.close()
 except Exception as e:report['fatalError']=str(e);report['traceback']=traceback.format_exc()
 finally:
  server.terminate()
  try:server.wait(timeout=10)
  except subprocess.TimeoutExpired:server.kill();server.wait()
  log.close()
 report['changedSources']=[s for s,h in report['sourceSha256'].items()if hashlib.sha256((ROOT/s).read_bytes()).hexdigest()!=h];report['status']='FAIL'if report.get('fatalError')or report['pageErrors']or report['changedSources']or any(c['status']!='PASS'for c in report['cases'])else'PASS';(out/'compare-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print('REPORT '+report['status']);sys.exit(0 if report['status']=='PASS'else 1)
if __name__=='__main__':main()
