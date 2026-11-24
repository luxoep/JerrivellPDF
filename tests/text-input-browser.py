# SPDX-License-Identifier: MIT OR Apache-2.0
"""Real React field editing and independent Canvas pixel clipping checks.

Development-only isolated Chrome/Vite. No user app, browser, document or font
file is modified. Existing Playwright installation is used when available.
"""
from pathlib import Path
import argparse, hashlib, json, os, socket, subprocess, sys, time, traceback, urllib.request
ROOT=Path(__file__).resolve().parents[1]
VERSION=json.loads((ROOT/'package.json').read_text(encoding='utf-8'))['version']
TOOL_DIR=ROOT/'test-results/0.8.3/browser-tools'
if TOOL_DIR.is_dir():sys.path.insert(0,str(TOOL_DIR))
from playwright.sync_api import sync_playwright

HARNESS=r'''
import React, {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {I18nProvider} from '/src/i18n';
import {OverlayEditor} from '/src/components/OverlayEditor';
import {OverlayHandles} from '/src/components/OverlayHandles';
import {LivePageImage} from '/src/components/LivePageImage';
import {createTextPng,cssFontFamily} from '/src/components/overlayCanvas';
import {measureTextFrame,renderTextFrame} from '/src/textFrame';
import {prepareEditableOverlays} from '/src/editableOverlays';
import {stageImageAsset} from '/src/backend';
import '/src/styles.css';import '/src/jerry-theme.css';import '/src/ui-polish.css';
const stats=window.stats={calls:0,commands:[],commits:0};let id=0;
window.__TAURI_INTERNALS__={async invoke(command,args){stats.calls++;stats.commands.push(command);
 if(command==='list_system_fonts')return{families:['Arial','Microsoft YaHei UI'],source:'windows',truncated:false};
 if(command!=='register_image')throw new Error(command);
 const image=new Image();image.src=args.dataUrl;await image.decode();return{id:'registered-'+(++id),dataUrl:args.dataUrl,width:image.naturalWidth,height:image.naturalHeight};}};
const backdrop='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="white"/><path d="M0 0H600V800H0Z" stroke="#cbd5dc" fill="none"/></svg>');
const layers={background:{dataUrl:backdrop,width:600,height:800},foreground:[]};
const flush=()=>new Promise(resolve=>setTimeout(resolve,250));
function App(){const[items,setItems]=useState([]),[selected,setSelected]=useState(''),[placement,setPlacement]=useState(null),[generation,setGeneration]=useState(0),[errors,setErrors]=useState([]),[busy,setBusy]=useState(false);const live=useRef({items,selected});live.current={items,selected};
 const apply=next=>{try{const result=prepareEditableOverlays(live.current.items,next,600,800);const assets=new Map(result.images.map(i=>[i.id,stageImageAsset(i.dataUrl)]));for(const a of assets.values())a.registered.catch(e=>setErrors(x=>[...x,String(e)]));setItems(result.overlays.map(i=>assets.has(i.id)?{...i,assetId:assets.get(i.id).id}:i));stats.commits++;}catch(e){setErrors(x=>[...x,String(e)]);}};
 window.harness={async reset(kind='empty'){let next=[];
   if(kind!=='empty'){const textSource={content:'123',color:'#243746',fontSize:24,bold:false,fontFamily:'Arial',frame:{width:180,height:60,autoHeight:true},...(kind==='compact'?{padding:0}:{})};const png=createTextPng(textSource.content,textSource.color,24,false,'Arial',textSource);const asset=stageImageAsset(png.dataUrl);await asset.registered;next=[{id:'text',assetId:asset.id,x:.2,y:.2,width:png.width/2/600,height:png.height/2/800,opacity:1,rotation:0,textSource:{...textSource,frame:{...textSource.frame,height:png.height/2}}}];}
   setItems(next);setSelected(next[0]?.id??'');setGeneration(x=>x+1);setErrors([]);await flush();stats.commits=0;return this.snapshot();},
   snapshot(){return JSON.parse(JSON.stringify({items:live.current.items,stats,errors}));},
   layout(){const item=live.current.items[0];return item?measureTextFrame(item,600,800):null;},
   async pixelChecks(){const results=[];
     for(const style of [{},{italic:true},{bold:true,italic:true},{underline:true,strikeout:true},{charSpacing:1.2,italic:true},{charSpacing:-1,italic:true}])for(const content of ['123','jÁÉgp国','一','-',' 123 ','A👩‍💻g']){
       const source={content,color:'#123456',fontFamily:'Arial',fontSize:24,bold:false,padding:0,...style};
       const png=createTextPng(content,source.color,source.fontSize,source.bold,source.fontFamily,source);
       const image=new Image();image.src=png.dataUrl;await image.decode();const original=document.createElement('canvas');original.width=png.width;original.height=png.height;const oc=original.getContext('2d');oc.drawImage(image,0,0);
       const reference=document.createElement('canvas');reference.width=png.width+80;reference.height=png.height+80;const ctx=reference.getContext('2d');
       ctx.font=`${source.italic?'italic ':''}${source.bold?'600':'400'} ${48}px ${cssFontFamily(source.fontFamily)}`;ctx.fillStyle=source.color;ctx.strokeStyle=source.color;ctx.textBaseline='alphabetic';ctx.lineWidth=Math.max(1,48/18);
       for(const line of png.layoutLines){const x=line.x*2+40,y=line.y*2+40,spacing=(source.charSpacing??0)*2;if(!spacing)ctx.fillText(line.text,x,y);else{let cursor=x;const clusters=Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(line.text),i=>i.segment);clusters.forEach((glyph,i)=>{ctx.fillText(glyph,cursor,y);cursor=x+ctx.measureText(clusters.slice(0,i+1).join('')).width+(i+1)*spacing;});}
         for(const dy of [source.underline?48*.1:null,source.strikeout?-48*.33:null])if(dy!==null){const sx=(line.decorationX??line.x)*2+40;ctx.beginPath();ctx.moveTo(sx,y+dy);ctx.lineTo(sx+line.width*2,y+dy);ctx.stroke();}}
       const pixels=ctx.getImageData(0,0,reference.width,reference.height).data;let outside=0;for(let y=0;y<reference.height;y++)for(let x=0;x<reference.width;x++)if((x<40||y<40||x>=40+png.width||y>=40+png.height)&&pixels[(y*reference.width+x)*4+3])outside++;
       const crop=ctx.getImageData(40,40,png.width,png.height).data,actual=oc.getImageData(0,0,png.width,png.height).data;let differences=0,maxAlphaDifference=0;for(let n=0;n<crop.length;n++){if(crop[n]!==actual[n])differences++;if(n%4===3)maxAlphaDifference=Math.max(maxAlphaDifference,Math.abs(crop[n]-actual[n]));}
       results.push({content,style,outside,differences,maxAlphaDifference,width:png.width,height:png.height});
     }return results;}
 };
 const page={id:'page',documentId:'synthetic',pageIndex:0,rotation:0,width:600,height:800,sourceName:'synthetic.pdf',overlays:items};
 return <div className="app-shell"><header className="input-test-heading">Real React inputs · synthetic PDF</header><div id="sheet" className="pdf-sheet"><LivePageImage page={page} layers={layers} placement={placement} label="Synthetic PDF"/><OverlayHandles key={generation} overlays={items} selectedId={selected} onSelect={setSelected} onPreview={setPlacement} onChange={apply} pageWidth={600} pageHeight={800} onError={e=>setErrors(x=>[...x,e])}/></div><OverlayEditor key={generation} overlays={items} selectedId={selected} onSelect={setSelected} onChange={apply} pageWidth={600} pageHeight={800} disabled={busy} onBusyChange={setBusy} onError={e=>setErrors(x=>[...x,e])} onClose={()=>{}}/><div id="errors">{errors.map((e,i)=><p role="alert" key={i}>{e}</p>)}</div></div>;
}createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);
'''
HTML='''<!doctype html><meta charset="utf-8"><script>localStorage.setItem('rivuleaf.language','en-US')</script><div id="root"></div><script type="module" src="./input-harness.tsx"></script><style>:root{--workspace-panel-top:75px}body{min-width:0!important}.input-test-heading{height:60px;padding:20px;color:#294657}#sheet{position:absolute;left:28px;top:75px;width:600px;height:800px}.oe-panel{top:75px!important;bottom:25px!important}#errors{position:fixed;left:30px;bottom:12px;color:#a43d25}</style>'''
SOURCES=['src/useNumberDraft.ts','src/components/overlayCanvas.ts','src/components/OverlayEditor.tsx','src/components/overlay-editor.css','src/overlayEditor.css','src/textFrame.ts','src/components/OverlayHandles.tsx','src/placementGeometry.ts','src/components/LivePageImage.tsx','src/editableOverlays.ts','src/backend.ts','src/editableProject.ts','tests/text-input-browser.py']

def numeric(page):
    page.evaluate('harness.reset()');text=page.get_by_role('textbox',name='Text',exact=True);text.fill('123')
    size=page.get_by_role('spinbutton',name='Size (pt)',exact=True)
    before=page.evaluate('harness.snapshot().stats.calls');size.fill('');page.wait_for_timeout(250);assert size.input_value()==''
    assert page.evaluate('harness.snapshot().stats.calls')==before,'Clearing must not register invalid text'
    size.fill('1');page.wait_for_timeout(80);assert size.input_value()=='1';size.fill('12.5');assert size.input_value()=='12.5'
    page.get_by_text('Layout and frame',exact=True).click()
    for name,value,partial in [('Line spacing','1.25','.'),('Character spacing (pt)','-0.5','-'),('Box width (mm)','60.5',''),('Padding (pt)','0','')]:
        field=page.get_by_role('spinbutton',name=name,exact=True);field.fill('');page.wait_for_timeout(80);assert field.input_value()=='';field.fill(partial);assert field.input_value()==partial;field.fill(value);assert field.input_value()==value
    page.get_by_role('checkbox',name='Grow height to fit text').uncheck();height=page.get_by_role('spinbutton',name='Box height (mm)',exact=True);height.fill('');page.wait_for_timeout(80);assert height.input_value()=='';height.fill('20.5');height.press('Tab');assert height.input_value()=='20.5'
    size.fill('');size.press('Tab');assert size.input_value()=='12.5','Blur restores the last valid font, not a fallback font'
    page.get_by_role('button',name='Add to this page',exact=True).click();page.wait_for_function('harness.snapshot().items.length===1');item=page.evaluate('harness.snapshot().items[0]');assert item['textSource']['fontSize']==12.5 and item['textSource']['padding']==0;assert item['textSource']['charSpacing']==-.5
    return {'font':12.5,'negativeSpacing':-.5,'emptyAndPartialFields':True}

def fit_and_spacing(page):
    before=page.evaluate("harness.reset('legacy')");old=page.evaluate('harness.layout()');
    layout_details=page.locator('.oe-text-options');
    if layout_details.get_attribute('open') is None: layout_details.locator('summary').click()
    page.get_by_role('button',name='Fit to text',exact=True).click();page.wait_for_function('harness.snapshot().stats.commits>=1');after=page.evaluate('harness.snapshot()');layout=page.evaluate('harness.layout()');source=after['items'][0]['textSource'];assert source['padding']==0 and source['fontSize']==24
    assert source['frame']['height']<before['items'][0]['textSource']['frame']['height']*.75;assert source['frame']['width']<before['items'][0]['textSource']['frame']['width']*.6
    oldbase=old['overlay']['y']*800+old['layoutLines'][0]['y'];newbase=layout['overlay']['y']*800+layout['layoutLines'][0]['y'];assert abs(oldbase-newbase)<.01
    area=page.locator('.oe-text-actions');assert area.locator('button').count()==1
    assert page.get_by_role('button',name='Update selected text',exact=True).count()==0
    textarea=page.get_by_role('textbox',name='Text',exact=True);textarea.fill('12')
    page.wait_for_function("harness.snapshot().items[0].textSource.content==='12'");assert textarea.input_value()=='12'
    assert page.evaluate('harness.snapshot().stats.commits')==after['stats']['commits']+1
    return {'fontUnchanged':24,'compactHeightPoints':source['frame']['height'],'compactWidthPoints':source['frame']['width'],'autoApplied':True,'oneTextAction':True}

def page_edges(page):
    page.evaluate("harness.reset('compact')");item=page.locator('.overlay-placement-handle').first;box=item.bounding_box();sheet=page.locator('#sheet').bounding_box()
    page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);page.mouse.down();page.mouse.move(sheet['x']-50,sheet['y']-50,steps=12);page.mouse.up();page.wait_for_timeout(100)
    first=page.evaluate('harness.snapshot().items[0]');assert first['x']==0 and first['y']==0;assert first['textSource']['padding']==0
    box=item.bounding_box();page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);page.mouse.down();page.mouse.move(sheet['x']+sheet['width']+80,sheet['y']+sheet['height']+80,steps=12);page.mouse.up();page.wait_for_timeout(100)
    last=page.evaluate('harness.snapshot().items[0]');assert abs(last['x']+last['width']-1)<1e-7 and abs(last['y']+last['height']-1)<1e-7;assert last['textSource']['fontSize']==24
    return {'topLeft':[first['x'],first['y']],'bottomRight':[last['x']+last['width'],last['y']+last['height']]}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--browser',default=r'C:\Program Files\Google\Chrome\Application\chrome.exe');args=parser.parse_args()
    folder=ROOT/f'test-results/{VERSION}';folder.mkdir(exist_ok=True,parents=True);(folder/'input-harness.html').write_text(HTML,encoding='utf-8');(folder/'input-harness.tsx').write_text(HARNESS,encoding='utf-8')
    report={'sourceSha256':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in SOURCES},'cases':[],'pageErrors':[]}
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    log=(folder/'input-vite.log').open('w',encoding='utf-8');server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',str(port),'--strictPort'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        url=f'http://127.0.0.1:{port}/test-results/{VERSION}/input-harness.html'
        for _ in range(100):
            try:urllib.request.urlopen(url,timeout=.3).close();break
            except Exception:time.sleep(.1)
        else:raise RuntimeError('Vite did not start')
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=args.browser,headless=True)
            for dpr,width in [(1,1362),(1.25,1120)]:
                context=browser.new_context(viewport={'width':width,'height':1000},device_scale_factor=dpr);page=context.new_page();page.on('pageerror',lambda error:report['pageErrors'].append(str(error)));page.goto(url);page.wait_for_function('!!window.harness');page.evaluate('document.fonts.ready')
                for name,run in [('numeric-clear-and-retype',numeric),('fit-glyphs-and-action-spacing',fit_and_spacing),('zero-padding-page-edges',page_edges),('pixel-clipping-reference',lambda p:p.evaluate('harness.pixelChecks()'))]:
                    case={'name':name,'dpr':dpr,'viewportWidth':width}
                    try:
                        result=run(page)
                        if name=='pixel-clipping-reference':assert all(r['outside']==0 and r['maxAlphaDifference']<=1 for r in result),[r for r in result if r['outside'] or r['maxAlphaDifference']>1]
                        case.update(status='PASS',result=result)
                    except Exception as error:case.update(status='FAIL',error=str(error),traceback=traceback.format_exc())
                    screenshot=folder/f'input-{name}-dpr-{dpr}.png';page.screenshot(path=str(screenshot));case['screenshot']=str(screenshot.relative_to(ROOT));report['cases'].append(case);print(json.dumps({k:v for k,v in case.items() if k not in ['traceback','result']}),flush=True)
                context.close()
            browser.close()
    except Exception as error:report['fatalError']=str(error);report['traceback']=traceback.format_exc()
    finally:
        server.terminate()
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:server.kill();server.wait(timeout=10)
        log.close()
    report['changedSources']=[name for name,h in report['sourceSha256'].items() if hashlib.sha256((ROOT/name).read_bytes()).hexdigest()!=h]
    report['status']='FAIL' if report.get('fatalError') or report['pageErrors'] or report['changedSources'] or any(c['status']!='PASS' for c in report['cases']) else 'PASS';out=folder/'text-input-browser.json';out.write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8');print('REPORT '+str(out)+' '+report['status'])
    if report['status']!='PASS':sys.exit(1)
if __name__=='__main__':main()
