# SPDX-License-Identifier: MIT OR Apache-2.0
"""Real React App, pointer capture, layout and history; synthetic native boundary."""
from pathlib import Path
import hashlib,importlib.util,json,os,re,socket,subprocess,sys,time,traceback,urllib.request
ROOT=Path(__file__).resolve().parents[1];VERSION=json.loads((ROOT/'package.json').read_text())['version']
sys.path.insert(0,str(ROOT/'test-results/0.8.3/browser-tools'))
from playwright.sync_api import sync_playwright
spec=importlib.util.spec_from_file_location('reader_harness',ROOT/'tests/reader-writing-browser.py');reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(reader)
HARNESS=reader.HARNESS.replace('commands:[],encodes:0','commands:[],calls:[],nextPaths:["C:/first.pdf"],encodes:0')
HARNESS=HARNESS.replace('stats.commands.push(command);','stats.commands.push(command);stats.calls.push({command,args:JSON.parse(JSON.stringify(args??{}))});')
HARNESS=HARNESS.replace("if(command==='plugin:dialog|open')return['C:/synthetic.pdf'];","if(command==='plugin:dialog|open')return args.options.multiple?stats.nextPaths:'C:/fragment.pdf';")
HARNESS=HARNESS.replace("path:'C:/synthetic.pdf',fileName:'synthetic.pdf'","path:args.path,fileName:args.path.split('/').pop()")
HARNESS=HARNESS.replace("if(command==='close_all_documents')return null;", """
 if(command==='import_pdf_stamp')return{...image,id:'snapshot-'+(++sequence),pageCount:3};
 if(command==='create_image_fragments')return args.crops.map((crop,index)=>{
  const out=document.createElement('canvas');out.width=Math.max(1,Math.round(600*crop.width));out.height=Math.max(1,Math.round(800*crop.height));
  const context=out.getContext('2d');context.fillStyle=index%2?'#ad7138':'#456f8b';context.fillRect(0,0,out.width,out.height);return{id:'fragment-'+(++sequence),dataUrl:out.toDataURL(),width:out.width,height:out.height};});
 if(command==='close_all_documents')return null;
""")
HTML=reader.HTML.replace('reader-writing-harness.tsx','navigation-fragments-harness.tsx')
SOURCES=['src/App.tsx','src/workspaceDocuments.ts','src/pdfFragments.ts','src/components/PageThumbnails.tsx','src/viewerGeometry.ts','src/components/PdfViewer.tsx','src/components/reader-experience.css','src/components/OverlayEditor.tsx','src/components/FragmentTray.tsx','src/components/fragment-tray.css','src/useFragmentPreview.ts','src/backend.ts','tests/navigation-fragments-browser.py']
def snapshot(page):return page.evaluate('harness.snapshot()')
def click(page,name):page.get_by_role('button',name=name,exact=True).click()
def region(page,x,y,w,h):
    box=page.locator('.region-selection-surface').bounding_box();page.mouse.move(box['x']+x*box['width'],box['y']+y*box['height']);page.mouse.down();page.mouse.move(box['x']+(x+w)*box['width'],box['y']+(y+h)*box['height'],steps=7);page.mouse.up()
def drag(page,source,target,x=.5,y=.5):
    a=source.bounding_box();b=target.bounding_box();page.mouse.move(a['x']+a['width']/2,a['y']+a['height']/2);page.mouse.down();page.mouse.move(b['x']+b['width']*x,b['y']+b['height']*y,steps=12);page.mouse.up();page.wait_for_timeout(120)
def run(page,url,dpr):
    page.goto(url,wait_until='domcontentloaded',timeout=45000);page.wait_for_function('!!window.harness');page.get_by_role('button',name=re.compile('^Open PDF')).click();page.locator('.workspace-documents button').wait_for()
    page.evaluate('stats.nextPaths=["C:/第二份 长文档名称.pdf"]');click(page,'Import PDF');page.locator('#import-position').select_option('end');click(page,'Import pages')
    docs=page.locator('.workspace-documents button');page.wait_for_function('document.querySelectorAll(".workspace-documents button").length===2')
    assert docs.nth(0).inner_text()=='first.pdf\n3 p.';assert '第二份 长文档名称.pdf' in docs.nth(1).inner_text()
    assert page.locator('.panel-tabs').count()==0 and page.locator('.add-page-tile').count()==0
    assert page.get_by_role('button',name='Import PDF',exact=True).count()==1
    assert page.get_by_role('button',name='Page tools',exact=True).count()==0
    assert page.locator('.thumbnail-source-name').first.inner_text()=='first.pdf'
    before=page.locator('.continuous-viewport').bounding_box()['width'];click(page,'Collapse left navigation');page.wait_for_timeout(100)
    assert not page.locator('.document-panel').is_visible();assert page.locator('.continuous-viewport').bounding_box()['width']>before+150
    assert page.evaluate('localStorage.getItem("jerrivell.sidebarCollapsed")')=='1'
    click(page,'Show page sidebar');assert page.locator('.document-panel').is_visible();docs.nth(0).click()
    click(page,'Add content');click(page,'Stamp');click(page,'PDF fragment');click(page,'Choose source PDF');page.locator('.region-selection-surface').wait_for()
    calls=len(snapshot(page)['calls']);region(page,.1,.1,.2,.15);region(page,.55,.3,.25,.2)
    page.wait_for_function('document.querySelectorAll(".pdf-fragment-result-card img").length===2')
    assert len(snapshot(page)['calls'])==calls,'Selection and preview must not invoke PDFium'
    click(page,'Create fragment list');page.locator('.fragment-tray li').nth(1).wait_for();assert page.locator('.pdf-fragment-workbench').count()==0
    assert len([c for c in snapshot(page)['calls'] if c['command']=='import_pdf_stamp'])==1
    batch=[c for c in snapshot(page)['calls'] if c['command']=='create_image_fragments'][-1];assert len(batch['args']['crops'])==2
    rows=page.locator('.fragment-tray li');first_id=rows.nth(0).get_attribute('data-fragment-row');second_id=rows.nth(1).get_attribute('data-fragment-row')
    drag(page,rows.nth(1).locator('.fragment-grip'),rows.nth(0),.7,.1)
    assert rows.nth(0).get_attribute('data-fragment-row')==second_id
    rows.nth(0).get_by_role('textbox',name='Fragment name').fill('Renamed fragment')
    target=page.locator('.continuous-page').first;drag(page,rows.nth(0).locator('.fragment-thumbnail'),target,.35,.25)
    page.wait_for_function('document.querySelectorAll(".continuous-stage [data-live-overlay]").length===1')
    click(page,'Insert all separately (2)');page.wait_for_function('document.querySelectorAll(".continuous-stage [data-live-overlay]").length===3')
    page.keyboard.press('Control+z');page.wait_for_function('document.querySelectorAll(".continuous-stage [data-live-overlay]").length===1')
    page.keyboard.press('Control+Shift+z');page.wait_for_function('document.querySelectorAll(".continuous-stage [data-live-overlay]").length===3')
    # Switch to another PDF; the editor remounts, but the session tray and its names/order survive.
    docs.nth(1).click();page.wait_for_function('document.querySelector(".reader-breadcrumb").textContent.includes("第二份")')
    assert rows.nth(0).get_by_role('textbox',name='Fragment name').input_value()=='Renamed fragment'
    target=page.locator('.continuous-page').filter(has=page.locator('.pdf-sheet')).first
    # Use the currently visible target page, not a virtual overscan row outside the viewport.
    target=page.locator('.continuous-page[data-reader-page="4"]')
    drag(page,rows.nth(1).locator('.fragment-thumbnail'),target,.4,.35)
    page.locator('.continuous-page[data-reader-page="4"] [data-live-overlay]').wait_for()
    page.keyboard.press('Control+Shift+s');page.wait_for_function('stats.saved!==null')
    saved=snapshot(page)['saved'];counts=[len(p.get('overlays',[])) for p in saved['pages']];assert counts==[3,0,0,1,0,0],counts
    page.get_by_role('button',name='Delete fragment: Renamed fragment',exact=True).click();assert rows.count()==1
    assert rows.nth(0).get_attribute('data-fragment-row')==first_id
    # Removing a tray item must preserve objects already inserted on either PDF.
    page.evaluate('stats.saved=null');page.keyboard.press('Control+Shift+s');page.wait_for_function('stats.saved!==null')
    assert [len(p.get('overlays',[])) for p in snapshot(page)['saved']['pages']]==counts
    return {'documentNames':docs.all_inner_texts(),'independentRegions':2,'trayPointerReorder':True,'trayNamesSurvivePageSwitch':True,'crossPdfPointerDrop':True,'singleUndoForBatch':True,'savedOverlayCounts':counts,'removeRetainsPlacedContent':True,'duplicateEntryCleanup':True,'collapseWidensReader':True,'dpr':dpr}
def main():
    out=ROOT/f'test-results/{VERSION}';out.mkdir(parents=True,exist_ok=True);(out/'navigation-fragments-harness.tsx').write_text(HARNESS,encoding='utf-8');(out/'navigation-fragments-harness.html').write_text(HTML,encoding='utf-8')
    report={'sourceSha256':{s:hashlib.sha256((ROOT/s).read_bytes()).hexdigest() for s in SOURCES},'cases':[],'pageErrors':[]}
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    log=(out/'navigation-fragments-vite.log').open('w',encoding='utf-8');server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',str(port),'--strictPort'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        url=f'http://127.0.0.1:{port}/test-results/{VERSION}/navigation-fragments-harness.html'
        for _ in range(100):
            try:urllib.request.urlopen(url,timeout=.3).close();break
            except Exception:time.sleep(.1)
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True)
            for dpr,width in [(1,1362),(1.25,1120)]:
                context=browser.new_context(viewport={'width':width,'height':1000},device_scale_factor=dpr);page=context.new_page();page.set_default_timeout(7000);page.on('pageerror',lambda e:report['pageErrors'].append(str(e)))
                case={'dpr':dpr}
                try:case.update(status='PASS',result=run(page,url,dpr))
                except Exception as e:case.update(status='FAIL',error=str(e),traceback=traceback.format_exc(),body=page.locator('body').inner_text()[:2500],calls=page.evaluate('window.stats?.calls.slice(-8)'))
                page.screenshot(path=str(out/f'navigation-fragments-{dpr}.png'));report['cases'].append(case);print(json.dumps(case,ensure_ascii=False),flush=True);context.close()
            browser.close()
    except Exception as e:report['fatalError']=str(e);report['traceback']=traceback.format_exc()
    finally:
        server.terminate()
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:server.kill();server.wait()
        log.close()
    report['changedSources']=[s for s,h in report['sourceSha256'].items() if hashlib.sha256((ROOT/s).read_bytes()).hexdigest()!=h]
    report['status']='FAIL' if report.get('fatalError') or report['pageErrors'] or report['changedSources'] or any(c['status']!='PASS' for c in report['cases']) else 'PASS';(out/'navigation-fragments-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print('REPORT '+report['status'])
    if report['status']!='PASS':sys.exit(1)
if __name__=='__main__':main()
