# SPDX-License-Identifier: MIT OR Apache-2.0
"""Real React viewer and native-boundary scheduling; actual PDF pixels are covered by Rust quality tests."""
from pathlib import Path
import hashlib,importlib.util,json,re,socket,subprocess,sys,time,traceback,urllib.request

ROOT=Path(__file__).resolve().parents[1]
VERSION=json.loads((ROOT/'package.json').read_text())['version']
sys.path.insert(0,str(ROOT/'test-results/0.8.3/browser-tools'))
from playwright.sync_api import sync_playwright
spec=importlib.util.spec_from_file_location('reader_harness',ROOT/'tests/reader-writing-browser.py')
reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(reader)
HARNESS=reader.HARNESS.replace('commands:[],encodes:0','commands:[],calls:[],blockRaster:false,blockedCount:0,inFlight:0,encodes:0')
HARNESS=HARNESS.replace('stats.commands.push(command);','stats.commands.push(command);stats.calls.push({command,args:JSON.parse(JSON.stringify(args??{})),at:performance.now()});')
HARNESS=HARNESS.replace("if(command==='render_page_layers')return{background:image,foreground:[]};", """if(command==='render_page_layers'){
 stats.inFlight++;
 if(stats.blockRaster&&args.targetWidth>768){stats.blockedCount++;await new Promise(resolve=>(window.qualityWaiters??=[]).push(resolve));}
 stats.inFlight--;
 // Deliberately reuse a small synthetic PNG; these tests prove request geometry,
 // not bitmap sharpness. Native Rust tests verify real 3600/4800px PNGs and line detail.
 return{background:{...image,width:args.targetWidth,height:Math.round(args.targetWidth*800/600)},foreground:[]};}
 if(command==='inspect_page_content')return{objects:[],totalObjects:0,truncated:false,warnings:[]};""")
HARNESS=HARNESS.replace("createRoot(document.getElementById('root')).render(<App/>);", "window.releaseQualityRaster=()=>{stats.blockRaster=false;for(const resolve of window.qualityWaiters??[])resolve();window.qualityWaiters=[];};createRoot(document.getElementById('root')).render(<App/>);")
HTML=reader.HTML.replace('reader-writing-harness.tsx','reader-quality-harness.tsx')
SOURCES=['src/components/PdfViewer.tsx','src/viewerGeometry.ts','src/usePageLayers.ts','src/backend.ts','src/components/LivePageImage.tsx','src/components/PrintDialog.tsx','src/printing.ts','src/ui-polish.css','tests/reader-quality-browser.py']

def calls(page):return page.evaluate('stats.calls.filter(item=>item.command==="render_page_layers")')
def first_page_calls(page):return [c for c in calls(page) if c['args']['page']['pageIndex']==0 and c['args']['targetWidth']>154]
def pause(page):page.wait_for_timeout(350)
def width(page):return page.locator('.continuous-page[data-reader-page="1"]').bounding_box()['width']
def wheel_to_400(page):
    page.locator('.continuous-viewport').evaluate("e=>{const b=e.getBoundingClientRect();for(let n=0;n<4;n++)e.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-240,bubbles:true,clientX:b.left+150,clientY:b.top+150}));}")
def stationary_pdf(page):
    return page.locator('.continuous-page').first.evaluate("e=>{let okay=true;for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(Number(s.opacity)!==1||s.transform!=='none')okay=false;}return okay;}")

def run(page,url,dpr,out):
    reader.fresh(page,url);pause(page)
    initial=first_page_calls(page);assert initial
    fit_width=width(page);fit_target=initial[-1]['args']['targetWidth']
    assert fit_target>=fit_width*max(2,dpr),(fit_width,fit_target,dpr)
    # 100% creates a mounted but offscreen next page; its prefetch must stay small.
    page.locator('.zoom-label').click();pause(page)
    css_100=width(page);assert abs(css_100-600)<.1
    assert first_page_calls(page)[-1]['args']['targetWidth']>=css_100*2
    overscan=[c for c in calls(page) if c['args']['page']['pageIndex']==1 and c['args']['targetWidth']>154]
    assert overscan and all(c['args']['targetWidth']<=768 for c in overscan),overscan
    assert calls(page).index(initial[0])<calls(page).index(overscan[0]),'The foreground page prepares before delayed overscan'
    assert stationary_pdf(page)
    # Hold the real renderer boundary while a zoom upgrade is pending. The old
    # decoded SVG must stay visible, and a rapid wheel burst requests one final resolution.
    before=len(first_page_calls(page));page.evaluate('stats.blockRaster=true');wheel_to_400(page)
    page.wait_for_function('stats.blockedCount>0',timeout=10000)
    assert abs(width(page)-2400)<.1
    assert page.locator('.continuous-page[data-reader-page="1"] .live-page-image').count()==1
    assert page.locator('.continuous-page[data-reader-page="1"] .page-placeholder').count()==0
    assert len(first_page_calls(page))==before+1,'Wheel burst must coalesce the intermediate resolutions'
    held=first_page_calls(page)[-1]['args']['targetWidth'];assert held>2400
    assert held*round(held*800/600)<=32*1024*1024 and round(held*800/600)<=8192
    if dpr>=3:assert held<2400*dpr,'Extreme density must respect the per-page pixel budget'
    page.screenshot(path=str(out/f'quality-upgrade-held-{dpr}.png'))
    page.evaluate('releaseQualityRaster()');pause(page)
    count=len(calls(page));pause(page);assert len(calls(page))==count,'Idle pages must not continuously re-render'
    zoomed=first_page_calls(page)[-1]['args']['targetWidth']
    # Returning to a lower zoom reuses the higher-resolution current page.
    before=len(first_page_calls(page));page.locator('.zoom-label').click();pause(page)
    assert len(first_page_calls(page))==before,'Zooming out should keep the higher-resolution raster'
    assert page.locator('.continuous-page[data-reader-page="1"] .live-page-image').count()==1
    # Open the main functional panels. Their PDF ancestors must remain opaque
    # and stationary while controls enter, avoiding the historical preview flicker.
    for name,selector,close in [('Add content','.oe-panel','Close editing tools'),('Edit original','.original-editor','Close original content editor')]:
        page.get_by_role('button',name=name,exact=True).click();page.locator(selector).wait_for()
        assert stationary_pdf(page),name
        page.wait_for_timeout(85);assert stationary_pdf(page),name
        page.get_by_role('button',name=close,exact=True).click();pause(page)
    page.get_by_role('button',name='Mark',exact=True).click();assert page.locator('.mark-toolbar').is_visible();assert stationary_pdf(page)
    page.get_by_role('button',name='Mark',exact=True).click();pause(page)
    page.get_by_role('button',name='Tools',exact=True).click();page.get_by_role('dialog',name='Page and batch tools').wait_for();assert stationary_pdf(page)
    page.get_by_role('button',name='Close page tools',exact=True).click();pause(page)
    page.get_by_role('button',name='Print',exact=True).click();dialog=page.get_by_role('dialog',name='Print and preview');dialog.wait_for()
    dpi=dialog.get_by_role('combobox',name='Print resolution (DPI)',exact=True)
    assert dpi.locator('option').evaluate_all('(options)=>options.map(option=>option.value)')==['auto','150','300','600']
    pause(page);print_previews=page.evaluate('stats.calls.filter(item=>item.command==="render_page").length')
    for value in ['150','300','600','auto']:dpi.select_option(value)
    pause(page);assert page.evaluate('stats.calls.filter(item=>item.command==="render_page").length')==print_previews,'DPI choices must not repeatedly rasterize print previews'
    assert page.evaluate('stats.calls.filter(item=>item.command==="print_document").length')==0,'No physical jobs are submitted by this UI check'
    page.screenshot(path=str(out/f'quality-print-dpi-{dpr}.png'));page.get_by_role('button',name='Close print preview',exact=True).click();pause(page)
    return {'dpr':dpr,'fitCssWidth':fit_width,'fitRequestedPixels':fit_target,'densityHonored':True,'css100':css_100,'overscanWidth':overscan[0]['args']['targetWidth'],'foregroundBeforePrefetch':True,'css400':2400,'zoomRequestedPixels':zoomed,'singleUpgradeForWheelBurst':True,'oldRasterVisibleDuringUpgrade':True,'idleRequestsStable':True,'zoomOutReusesHigherRaster':True,'panelPdfAncestorsStationary':True,'printDpiChoices':['auto',150,300,600],'dpiChangesReusePreview':True,'noPhysicalPrintJob':True}

def main():
    out=ROOT/f'test-results/{VERSION}';out.mkdir(parents=True,exist_ok=True);(out/'reader-quality-harness.tsx').write_text(HARNESS,encoding='utf-8');(out/'reader-quality-harness.html').write_text(HTML,encoding='utf-8')
    report={'method':'Real App/React UI with synthetic native IPC; real PNG resolution/detail verified by native Rust tests','sourceSha256':{s:hashlib.sha256((ROOT/s).read_bytes()).hexdigest() for s in SOURCES},'cases':[],'pageErrors':[]}
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    log=(out/'reader-quality-vite.log').open('w',encoding='utf-8');server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',str(port),'--strictPort'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        url=f'http://127.0.0.1:{port}/test-results/{VERSION}/reader-quality-harness.html'
        for _ in range(100):
            try:urllib.request.urlopen(url,timeout=.3).close();break
            except Exception:time.sleep(.1)
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True)
            for dpr in [1,2,3]:
                context=browser.new_context(viewport={'width':1362,'height':900},device_scale_factor=dpr);page=context.new_page();page.set_default_timeout(10000);page.on('pageerror',lambda e:report['pageErrors'].append(str(e)));case={'dpr':dpr}
                try:case.update(status='PASS',result=run(page,url,dpr,out))
                except Exception as e:case.update(status='FAIL',error=str(e),traceback=traceback.format_exc(),calls=calls(page)[-20:],body=page.locator('body').inner_text()[:1800]);page.screenshot(path=str(out/f'quality-failure-{dpr}.png'))
                report['cases'].append(case);print(json.dumps(case,ensure_ascii=False),flush=True);context.close()
            browser.close()
    except Exception as e:report.update(fatalError=str(e),traceback=traceback.format_exc())
    finally:
        server.terminate()
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:server.kill();server.wait()
        log.close()
    report['changedSources']=[s for s,h in report['sourceSha256'].items() if hashlib.sha256((ROOT/s).read_bytes()).hexdigest()!=h]
    report['status']='FAIL' if report.get('fatalError') or report['pageErrors'] or report['changedSources'] or any(c['status']!='PASS' for c in report['cases']) else 'PASS'
    (out/'reader-quality-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print('REPORT '+report['status'])
    if report['status']!='PASS':sys.exit(1)
if __name__=='__main__':main()
