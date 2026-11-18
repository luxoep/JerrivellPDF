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
const stats=window.stats={calls:[],guard:true,dialogs:['C:/old.pdf','C:/new.pdf'],save:'C:/comparison.csv',exports:[],hold:false,closed:0,options:null,progress:{jobId:'',status:'idle',completed:0,total:0,report:null,error:null}};
const canvas=document.createElement('canvas');canvas.width=600;canvas.height=800;const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,600,800);c.strokeStyle='#234d62';c.lineWidth=2;c.strokeRect(40,80,500,500);c.beginPath();c.arc(220,300,70,0,Math.PI*2);c.stroke();c.fillStyle='#234d62';c.font='24px Arial';c.fillText('M8 +0.02',70,650);const picture={dataUrl:canvas.toDataURL(),width:600,height:800};
const mask=document.createElement('canvas');mask.width=600;mask.height=800;const mc=mask.getContext('2d');mc.fillStyle='#d22676';mc.fillRect(110,150,12,8);mc.fillStyle='#0b9d51';mc.fillRect(360,500,5,5);const overlay={dataUrl:mask.toDataURL(),width:600,height:800};
let callbackId=0,listenerId=0,polls=0;const callbacks=new Map(),listeners=new Map();
const region=(id,x,y,w,h,pixels)=>({id,bounds:{x,y,width:w,height:h},pixels,added:id===2?pixels:0,removed:id===1?pixels:0,changed:0,point:[x,y]});
const report=()=>({jobId:stats.progress.jobId,options:Object.fromEntries(Object.entries(stats.options).reverse()),widthPt:600,heightPt:800,originXPt:0,originYPt:0,pixelWidth:2500,pixelHeight:3333,changedPixels:stats.options.ignored.length?0:25,ignoredPixels:stats.options.ignored.length?1000:0,uncovered:stats.options.offsetXmm!==0||stats.options.offsetYmm!==0,regions:stats.options.ignored.length?[]:[region(1,.18,.18,.025,.02,20),region(2,.6,.62,.006,.006,5)],mask:overlay,tileCount:12});
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'compare'},currentWebview:{label:'compare'}},transformCallback(fn){const id=++callbackId;callbacks.set(id,fn);return id;},unregisterCallback(id){callbacks.delete(id);},async invoke(command,args={}){
 stats.calls.push({command,args:JSON.parse(JSON.stringify(args))});
 if(command==='plugin:event|listen'){const id=++listenerId;listeners.set(id,{event:args.event,handler:args.handler});return id;}
 if(command==='plugin:event|unlisten'){listeners.delete(args.eventId);return;}
 if(command==='plugin:dialog|open')return stats.dialogs.shift()??null;
 if(command==='plugin:dialog|save')return stats.save;
 if(command==='compare_close'){stats.closed++;return;}
 if(command==='compare_reset'){stats.progress={jobId:'',status:'idle',completed:0,total:0,report:null,error:null};return;}
 if(command==='compare_poll'){
  if(stats.progress.status==='running'&&!stats.hold&&++polls>=2)stats.progress={...stats.progress,status:'complete',completed:12,total:12,report:report()};
  return{guardReady:stats.guard,progress:JSON.parse(JSON.stringify(stats.progress))};
 }
 if(command==='compare_call'){
  const{command:kind,args:input}=args;
  if(kind==='open')return{fileName:input.path.split('/').pop(),fileSize:100,pageCount:2,pages:[{width:600,height:800},{width:600,height:800}]};
  if(kind==='preview')return{a:picture,b:picture,widthPt:600,heightPt:800,originXPt:0,originYPt:0,uncovered:input.options.offsetXmm!==0||input.options.offsetYmm!==0};
  if(kind==='start'){polls=0;stats.options=JSON.parse(JSON.stringify(input.options));stats.progress={jobId:input.jobId,status:'running',completed:0,total:12,report:null,error:null};return{jobId:input.jobId};}
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
SOURCES=['src/compare/CompareApp.tsx','src/compare/client.ts','src/compare/types.ts','src/compare/compare.css','tests/compare-browser.py']
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
   for name,run in [('native-boundary-and-review-export',basic),('stale-result-and-flexible-fields',stale_and_fields),('zoom-pan-overlay-and-idle',zoom_pan_and_idle),('ignored-area-qualification',exclusions),('manual-point-alignment',alignment),('cancel-and-isolated-worker-failure',cancel_crash),('review-close-protection',close_guard),('external-guard-fail-closed',guard),('responsive-stationary-preview',responsive)]:
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
