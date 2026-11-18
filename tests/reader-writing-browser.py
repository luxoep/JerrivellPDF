# SPDX-License-Identifier: MIT OR Apache-2.0
"""Real App/React UI, isolated test Chrome; synthetic native boundary only."""
from pathlib import Path
import hashlib,json,os,re,socket,subprocess,sys,time,traceback,urllib.request
ROOT=Path(__file__).resolve().parents[1];VERSION=json.loads((ROOT/'package.json').read_text())['version']
sys.path.insert(0,str(ROOT/'test-results/0.8.3/browser-tools'))
from playwright.sync_api import sync_playwright
HARNESS=r'''
import React from 'react';import {createRoot} from 'react-dom/client';import App from '/src/App';import {measureTextFrame} from '/src/textFrame';
import '/src/styles.css';import '/src/jerry-theme.css';import '/src/ui-polish.css';
localStorage.setItem('rivuleaf.language','en-US');
const stats=window.stats={commands:[],encodes:0,saved:null,copies:[],mode:'ready',images:0};
const encode=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=function(...args){stats.encodes++;return encode.apply(this,args);};
const canvas=document.createElement('canvas');canvas.width=600;canvas.height=800;const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,600,800);c.fillStyle='#234454';c.font='20px Arial';
let text='',glyphs=[];for(const [line,y] of [['Alpha Beta',80],['中文 text',120]]){if(text)text+='\n';let x=60;c.fillText(line,x,y);for(const ch of line){const start=text.length;text+=ch;const width=c.measureText(ch).width;glyphs.push({start,end:text.length,bounds:{x:x/600,y:(y-19)/800,width:width/600,height:24/800}});x+=width;}}
const image={dataUrl:canvas.toDataURL(),width:600,height:800};let sequence=0,callback=0;
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback(){return ++callback;},unregisterCallback(){},async invoke(command,args){stats.commands.push(command);
 if(command==='get_backend_status')return{engineReady:true};if(command==='get_startup_files')return[];
 if(command.startsWith('plugin:event|'))return ++callback;if(command==='plugin:window|is_maximized')return false;
 if(command==='plugin:dialog|open')return['C:/synthetic.pdf'];if(command==='plugin:dialog|save')return'C:/synthetic.jvp';
 if(command==='open_document')return{id:'source-'+(++sequence),path:'C:/synthetic.pdf',fileName:'synthetic.pdf',fileSize:100,pageCount:3,warnings:[],pages:[0,1,2].map(index=>({index,width:600,height:800,rotation:0}))};
 if(command==='close_all_documents')return null;if(command==='render_page')return image;if(command==='render_page_layers')return{background:image,foreground:[]};
 if(command==='get_page_text')return stats.mode==='restricted'?{status:'restricted',reason:'copy-forbidden',text:'',glyphs:[]}:stats.mode==='empty'?{status:'empty',text:'',glyphs:[]}:{status:'ready',text,glyphs};
 if(command==='list_system_fonts')return{families:['Arial','Microsoft YaHei UI'],source:'windows',truncated:false};
 if(command==='register_image'){stats.images++;const image=new Image();image.src=args.dataUrl;await image.decode();return{id:'asset-'+stats.images,dataUrl:args.dataUrl,width:image.naturalWidth,height:image.naturalHeight};}
 if(command==='save_editable_project'){stats.saved=JSON.parse(JSON.stringify(args));return null;}
 throw Error(command);
}};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
window.harness={snapshot(){return JSON.parse(JSON.stringify(stats));},savedLines(){return measureTextFrame(stats.saved.pages[0].overlays[0],600,800).layoutLines.map(line=>line.text);}};
createRoot(document.getElementById('root')).render(<App/>);
'''
HTML='<!doctype html><meta charset="utf-8"><script>localStorage.setItem("rivuleaf.language","en-US")</script><div id="root"></div><script type="module" src="./reader-writing-harness.tsx"></script>'
SOURCES=['src/inlineTextGeometry.ts','src/App.tsx','src/components/InlineTextInput.tsx','src/components/inline-text-input.css','src/components/TextToolLayer.tsx','src/components/OverlayHandles.tsx','src/components/OverlayEditor.tsx','src/components/PdfViewer.tsx','src/components/PageTextLayer.tsx','src/components/page-text-layer.css','src/textSelection.ts','src/backend.ts','src/textFrame.ts','src/components/overlayCanvas.ts','tests/reader-writing-browser.py']
def snap(page):return page.evaluate('harness.snapshot()')
def fresh(page,url,mode='ready'):
    page.goto(url,wait_until='domcontentloaded',timeout=45000);page.wait_for_function('!!window.harness',timeout=30000);page.evaluate('(m)=>{stats.mode=m}',mode)
    page.get_by_role('button',name=re.compile('^Open PDF')).click();page.locator('.pdf-text-layer').first.wait_for();page.wait_for_timeout(250)
def drag_box(page,x=.12,y=.17,w=.52,h=.12):
    page.locator('.reader-top').get_by_role('button',name='Text box',exact=True).click()
    layer=page.locator('.page-text-tool-layer');layer.wait_for();b=layer.bounding_box();page.mouse.move(b['x']+x*b['width'],b['y']+y*b['height']);page.mouse.down();page.mouse.move(b['x']+(x+w)*b['width'],b['y']+(y+h)*b['height'],steps=8);page.mouse.up()
    field=page.get_by_role('textbox',name='Edit text in place');field.wait_for();return field
def save(page):
    page.keyboard.press('Control+Shift+s');page.wait_for_function('stats.saved!==null');return snap(page)['saved']['pages'][0]['overlays']
def selection(page,url):
    fresh(page,url);layer=page.locator('.pdf-text-layer.ready').first;b=layer.bounding_box()
    page.mouse.move(b['x']+.102*b['width'],b['y']+.09*b['height']);page.mouse.down();page.mouse.move(b['x']+.257*b['width'],b['y']+.09*b['height'],steps=6);page.mouse.up()
    layer.get_by_role('button',name='Copy text').wait_for();page.keyboard.press('Control+c');page.wait_for_timeout(60)
    copied=page.evaluate('navigator.clipboard.readText()');assert copied=='Alpha Beta',repr(copied)
    count=snap(page)['commands'].count('get_page_text');page.keyboard.press('Control+=');page.wait_for_timeout(200)
    assert snap(page)['commands'].count('get_page_text')==count
    return {'copied':copied,'zoomReusesTextGeometry':True}
def direct_typing(page,url):
    fresh(page,url);field=drag_box(page);before=snap(page);field.fill('Direct typing 中文\nsecond line');page.wait_for_timeout(80);during=snap(page)
    assert during['images']==before['images'] and during['encodes']==before['encodes'],'Typing must not encode or register images'
    page.locator('.reader-breadcrumb').click();page.wait_for_function('stats.images===1');assert field.count()==0
    overlays=save(page);assert len(overlays)==1 and overlays[0]['textSource']['content']=='Direct typing 中文\nsecond line'
    assert overlays[0]['textSource']['fontSize']==24 and overlays[0]['textSource']['padding']==0
    handle=page.locator('.overlay-placement-handle').first;handle.dblclick();field=page.get_by_role('textbox',name='Edit text in place');field.fill('Edited without Update')
    page.locator('.reader-breadcrumb').click();page.wait_for_function('stats.images===2');page.evaluate('stats.saved=null');overlays=save(page)
    assert overlays[0]['textSource']['content']=='Edited without Update'
    return {'drawAndType':True,'noRasterDuringTyping':True,'blurCommits':True,'existingDoubleClickEdits':True,'fontSize':24}
def ime_and_shortcut(page,url):
    fresh(page,url);field=drag_box(page);field.fill('中文输入保留');field.dispatch_event('compositionstart',{'data':'文'});field.press('Control+Enter')
    assert field.count()==1 and snap(page)['images']==0
    field.dispatch_event('compositionend',{'data':'文'});field.press('Control+Shift+s');page.wait_for_function('stats.saved!==null')
    assert snap(page)['saved']['pages'][0]['overlays'][0]['textSource']['content']=='中文输入保留'
    return {'imeEnterDoesNotFinish':True,'saveShortcutIncludesLastDraft':True}
def mixed_layout(page,url):
    fresh(page,url);field=drag_box(page,.12,.17,.63,.12);content='Make room for clarity. 中文实时输入'
    field.fill(content);field.press('Control+End');page.keyboard.type('X');field.press('Control+z');assert field.input_value()==content
    field.press('Control+Shift+z');content+='X';assert field.input_value()==content
    field.press('Control+a');field.press('Control+c');assert page.evaluate('navigator.clipboard.readText()')==content
    field.press('Control+End');lines=page.locator('[data-inline-text-row]').all_text_contents();assert len(lines)>1,lines
    page.screenshot(path=str(ROOT/f'test-results/{VERSION}/inline-mixed-active-{page.evaluate("devicePixelRatio")}.png'))
    field.press('Home');caret=field.evaluate('(element)=>element.selectionStart');assert caret==len(lines[0]),(caret,lines)
    field.press('ArrowUp');field.press('End')
    caret_y=float(page.locator('.inline-text-caret').get_attribute('d').split(' ')[1].split('v')[0])
    first_y=float(page.locator('[data-inline-text-row]').first.get_attribute('y'))
    assert abs(caret_y-(first_y-24*.9))<.01,'End must keep its caret at the visible first-line end'
    page.locator('.reader-breadcrumb').click();save(page)
    final=page.evaluate('harness.savedLines()');assert final==lines,(lines,final)
    assert snap(page)['saved']['pages'][0]['overlays'][0]['textSource']['content']==content
    return {'visibleLines':lines,'savedLines':final,'softWrapNotCopied':True,'nativeUndoRedo':True,'homeUsesVisibleLine':True}
def overflow_guard(page,url):
    fresh(page,url);field=drag_box(page,.12,.62,.14,.03);draft='Overflow 内容 '*200;field.fill(draft);page.locator('.reader-breadcrumb').click()
    assert field.is_visible() and field.input_value()==draft
    assert snap(page)['images']==0 and snap(page)['saved'] is None
    field.press('Escape');assert field.count()==0
    return {'invalidBlurRetainsDraft':True,'escapeCancelsWithoutSaving':True}
def unavailable(page,url,mode):
    fresh(page,url,mode);note=page.locator('.pdf-text-note').first.inner_text();assert ('does not allow' if mode=='restricted' else 'No selectable') in note,note
    assert page.locator('.pdf-text-layer.ready').count()==0
    return {'mode':mode,'message':note}
def main():
    out=ROOT/f'test-results/{VERSION}';out.mkdir(parents=True,exist_ok=True);(out/'reader-writing-harness.html').write_text(HTML,encoding='utf-8');(out/'reader-writing-harness.tsx').write_text(HARNESS,encoding='utf-8')
    report={'sourceSha256':{s:hashlib.sha256((ROOT/s).read_bytes()).hexdigest() for s in SOURCES},'cases':[],'pageErrors':[],'consoleErrors':[]}
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    log=(out/'reader-writing-vite.log').open('w',encoding='utf-8');server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',str(port),'--strictPort'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        url=f'http://127.0.0.1:{port}/test-results/{VERSION}/reader-writing-harness.html'
        for _ in range(100):
            try:urllib.request.urlopen(url,timeout=.3).close();break
            except Exception:time.sleep(.1)
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True)
            for dpr,width in ([(1,1362)] if os.environ.get('JERRIVELL_BROWSER_SMOKE') else [(1,1362),(1.25,1120)]):
                context=browser.new_context(viewport={'width':width,'height':1000},device_scale_factor=dpr,permissions=['clipboard-read','clipboard-write']);page=context.new_page();page.set_default_timeout(7000);page.on('pageerror',lambda e:report['pageErrors'].append(str(e)));page.on('console',lambda m:report['consoleErrors'].append(m.text) if m.type=='error' else None)
                for name,run in [('selection-copy-and-zoom',selection),('draw-type-blur-reedit',direct_typing),('ime-and-save-shortcut',ime_and_shortcut),('mixed-layout-caret-copy-undo',mixed_layout),('overflow-retains-draft',overflow_guard),('copy-permission-message',lambda p,u:unavailable(p,u,'restricted')),('scan-without-text',lambda p,u:unavailable(p,u,'empty'))]:
                    case={'name':name,'dpr':dpr}
                    try:case.update(status='PASS',result=run(page,url))
                    except Exception as e:case.update(status='FAIL',error=str(e),traceback=traceback.format_exc(),body=page.locator('body').inner_text()[:2000],url=page.url,commands=page.evaluate('window.harness?.snapshot().commands.slice(-15) ?? []'),html=page.content()[:1500])
                    page.screenshot(path=str(out/f'reader-writing-{name}-dpr-{dpr}.png'));report['cases'].append(case);print(json.dumps({k:v for k,v in case.items() if k not in ['result','traceback']},ensure_ascii=False),flush=True)
                    if os.environ.get('JERRIVELL_BROWSER_SMOKE'):break
                context.close()
            browser.close()
    except Exception as e:report['fatalError']=str(e);report['traceback']=traceback.format_exc()
    finally:
        server.terminate()
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:server.kill();server.wait()
        log.close()
    report['changedSources']=[s for s,h in report['sourceSha256'].items() if hashlib.sha256((ROOT/s).read_bytes()).hexdigest()!=h]
    report['status']='FAIL' if report.get('fatalError') or report['pageErrors'] or report['changedSources'] or any(c['status']!='PASS' for c in report['cases']) else 'PASS';(out/'reader-writing-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print('REPORT '+report['status'])
    if report['status']!='PASS':sys.exit(1)
if __name__=='__main__':main()
