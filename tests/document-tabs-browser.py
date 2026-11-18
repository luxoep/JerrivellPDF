# SPDX-License-Identifier: MIT OR Apache-2.0
"""Real App/React tab workflows with an isolated, synthetic Tauri/native boundary.

This checks workspace state and IPC scheduling. It does not claim to exercise
Windows single-instance transport or real PDF rendering; native checks cover them.
"""
from pathlib import Path
import hashlib,json,re,socket,subprocess,sys,time,traceback,urllib.parse,urllib.request
ROOT=Path(__file__).resolve().parents[1]
VERSION=json.loads((ROOT/'package.json').read_text())['version']
sys.path.insert(0,str(ROOT/'test-results/0.8.3/browser-tools'))
from playwright.sync_api import sync_playwright

HARNESS=r'''
import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App';
import'/src/styles.css';import'/src/jerry-theme.css';import'/src/ui-polish.css';
localStorage.setItem('rivuleaf.language','en-US');
const stats=window.stats={calls:[],dialogs:[],startup:JSON.parse(new URL(location.href).searchParams.get('startup')??'[]'),openQueue:[],opened:[],saved:[],blockPath:'',blocked:0,holdChooser:false,chooserBlocked:0,failPaths:[],destroyed:0};
const norm=path=>path.replaceAll('\\','/').replace(/^\/\/\?\//,'').toLowerCase();
const sources=new Map(),callbacks=new Map(),listeners=new Map();let sequence=0,callbackId=0,listenerId=0;
const canvas=document.createElement('canvas');canvas.width=600;canvas.height=800;const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,600,800);context.fillStyle='#234454';context.font='24px Arial';context.fillText('Independent PDF tab fixture',45,80);
const image={dataUrl:canvas.toDataURL(),width:600,height:800};
const eventName='jerrivell://open-files';
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
 transformCallback(fn){const id=++callbackId;callbacks.set(id,fn);return id;},unregisterCallback(id){callbacks.delete(id);},
 async invoke(command,args={}){
 stats.calls.push({command,args:JSON.parse(JSON.stringify(args)),at:performance.now()});
 if(command==='get_backend_status')return{engineReady:true};
 if(command==='get_startup_files')return stats.startup.splice(0);
 if(command==='drain_open_requests')return stats.openQueue.splice(0);
 if(command==='plugin:event|listen'){const id=++listenerId;listeners.set(id,{event:args.event,handler:args.handler});return id;}
 if(command==='plugin:event|unlisten'){listeners.delete(args.eventId);return;}
 if(command.startsWith('plugin:event|'))return;
 if(command==='plugin:window|is_maximized')return false;
 if(command==='plugin:window|destroy'){stats.destroyed++;return;}
 if(command.startsWith('plugin:window|'))return;
 if(command==='plugin:dialog|open'){
   const result=stats.dialogs.length?stats.dialogs.shift():['C:/alpha.pdf'];
   if(stats.holdChooser){stats.chooserBlocked++;return await new Promise(resolve=>(window.chooserWaiters??=[]).push(()=>resolve(result)));}
   return result;
 }
 if(command==='plugin:dialog|save')return'C:/tab-saved-'+(stats.saved.length+1)+'.jvp';
 if(command==='open_document'){
   const path=args.path;if(stats.blockPath&&norm(path)===norm(stats.blockPath)){stats.blocked++;await new Promise(resolve=>(window.openWaiters??=[]).push(resolve));}
   if(stats.failPaths.some(value=>norm(value)===norm(path)))throw Error('Synthetic unreadable PDF');
   const name=path.split(/[\\/]/).pop(),count=/alpha/i.test(name)?3:/beta/i.test(name)?2:1;
   const source={id:'source-'+(++sequence),path,fileName:name,fileSize:100,pageCount:count,warnings:[],pages:Array.from({length:count},(_,index)=>({index,width:600,height:800,rotation:0}))};
   sources.set(source.id,source);stats.opened.push({path,id:source.id});return source;
 }
 if(command==='close_all_documents'){sources.clear();return;}
 if(command==='retain_documents'){
   const ids=new Set(args.documentIds??args.ids??[]);for(const id of sources.keys())if(!ids.has(id))sources.delete(id);return;
 }
 if(command==='close_documents'||command==='release_documents'){for(const id of args.documentIds??args.ids??[])sources.delete(id);return;}
 if(command==='render_page'||command==='render_page_layers'){
   if(!sources.has(args.page.documentId))throw Error('Stale native source '+args.page.documentId);
   return command==='render_page'?image:{background:image,foreground:[]};
 }
 if(command==='get_page_text')return{status:'ready',text:'Synthetic selectable text',glyphs:[]};
 if(command==='inspect_page_content')return{objects:[],totalObjects:0,truncated:false,warnings:[]};
 if(command==='list_system_fonts')return{families:['Arial','Microsoft YaHei UI'],source:'windows',truncated:false};
 if(command==='save_editable_project'){stats.saved.push(JSON.parse(JSON.stringify(args)));return;}
 if(command==='search_pages')return[];
 throw Error('Unhandled synthetic native boundary: '+command);
 }};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(id){listeners.delete(id);}};
window.harness={snapshot(){return JSON.parse(JSON.stringify(stats));},queueDialog(paths){stats.dialogs.push(paths);},emitExternal(paths){stats.openQueue.push(...paths);for(const[id,listener]of listeners)if(listener.event===eventName)callbacks.get(listener.handler)?.({event:eventName,id,payload:null});window.dispatchEvent(new CustomEvent(eventName,{detail:paths}));},requestWindowClose(){for(const[id,listener]of listeners)if(listener.event==='tauri://close-requested')callbacks.get(listener.handler)?.({event:listener.event,id,payload:null});},releaseOpen(){stats.blockPath='';for(const resolve of window.openWaiters??[])resolve();window.openWaiters=[];},releaseChooser(){stats.holdChooser=false;for(const resolve of window.chooserWaiters??[])resolve();window.chooserWaiters=[];},sourceIds(){return[...sources.keys()];}};
createRoot(document.getElementById('root')).render(<App/>);
'''
HTML='<!doctype html><meta charset="utf-8"><script>localStorage.setItem("rivuleaf.language","en-US");localStorage.setItem("jerrivell.sidebarCollapsed","0")</script><div id="root"></div><script type="module" src="./document-tabs-harness.tsx"></script>'
SOURCES=['src/App.tsx','src/documentTabs.ts','src/components/document-tabs.css','src/backend.ts','src/components/PdfViewer.tsx','src/viewerGeometry.ts','tests/document-tabs-browser.py']

def snapshot(page):return page.evaluate('harness.snapshot()')
def tab(page,title):return page.get_by_role('tab').filter(has=page.locator('.document-tab-name',has_text=re.compile('^'+re.escape(title)+'$')))
def active(page):return page.get_by_role('tab',selected=True).get_attribute('title') or page.get_by_role('tab',selected=True).inner_text()
def ready(page):
    page.wait_for_function("!document.querySelector('.busy-pill')",timeout=15000)
    page.locator('.continuous-page .live-page-image').first.wait_for()
    page.wait_for_timeout(180)
def fresh(page,url,startup=None):
    query='?startup='+urllib.parse.quote(json.dumps(startup)) if startup else ''
    page.goto(url+query,wait_until='domcontentloaded',timeout=45000);page.wait_for_function('!!window.harness');page.get_by_role('button',name=re.compile('^Open PDF')).wait_for() if not startup else None
    page.wait_for_timeout(180)
def open_files(page,paths):
    page.evaluate('(paths)=>harness.queueDialog(paths)',paths);page.keyboard.press('Control+o');ready(page)
def select(page,title):tab(page,title).click();ready(page)
def count(page):return page.get_by_role('tab').count()
def dirty(page):return page.locator('.document-subtitle .status-dot.modified').count()>0
def order(page):
    page.locator('.thumbnail-list').evaluate('element=>{element.scrollTop=0;element.dispatchEvent(new Event("scroll"));}')
    page.wait_for_timeout(70)
    return page.locator('.thumbnail-source-page').all_text_contents()
def rotate(page):
    page.locator('.continuous-viewport').focus();page.keyboard.press('r');page.wait_for_timeout(100)
def save_project(page):
    before=len(snapshot(page)['saved']);page.keyboard.press('Control+Shift+s');page.wait_for_function('(n)=>stats.saved.length>n',arg=before);ready(page);return snapshot(page)['saved'][-1]
def zoom(page):return page.locator('.zoom-label').inner_text()
def commands(page,name):return[c for c in snapshot(page)['calls'] if c['command']==name]
def selected_title(page):return page.get_by_role('tab',selected=True).locator('.document-tab-name').inner_text()
def reader_center(page):
    return page.locator('.continuous-viewport').evaluate("""element=>{
      const view=element.getBoundingClientRect(),x=view.left+element.clientWidth/2,y=view.top+element.clientHeight/2;
      const sheet=[...element.querySelectorAll('.continuous-page')].find(page=>{const b=page.getBoundingClientRect();return y>=b.top&&y<=b.bottom;});
      if(!sheet)throw Error('Reader center falls between pages');const bounds=sheet.getBoundingClientRect();
      return{id:sheet.dataset.workspacePageId,x:(x-bounds.left)/bounds.width,y:(y-bounds.top)/bounds.height,width:element.clientWidth};
    }""")

def state_isolation(page,url):
    fresh(page,url);open_files(page,['C:/alpha.pdf']);assert count(page)==1
    page.locator('.zoom-label').click();page.keyboard.press('Control+=');ready(page);alpha_zoom=zoom(page)
    assert alpha_zoom=='110%',alpha_zoom
    page.get_by_role('button',name='Go to page 1',exact=True).click();page.locator('.continuous-viewport').focus();page.keyboard.press('Alt+ArrowDown');rotate(page)
    assert order(page)==['Source page 2','Source page 1','Source page 3'];assert dirty(page)
    page.locator('.continuous-viewport').evaluate('e=>{e.scrollTop=350;e.dispatchEvent(new Event("scroll"));}');page.wait_for_timeout(100)
    alpha_scroll=page.locator('.continuous-viewport').evaluate('e=>e.scrollTop')
    open_files(page,['C:/beta.pdf']);assert count(page)==2;assert not dirty(page);assert page.get_by_role('button',name='Undo',exact=True).is_disabled()
    assert order(page)==['Source page 1','Source page 2'];rotate(page);assert dirty(page)
    beta=save_project(page);assert not dirty(page);assert beta['pages'][0]['rotation']==90
    page.locator('.zoom-label').click();ready(page);assert zoom(page)=='100%'
    select(page,'alpha.pdf');assert dirty(page);assert zoom(page)==alpha_zoom
    assert abs(page.locator('.continuous-viewport').evaluate('e=>e.scrollTop')-alpha_scroll)<2
    assert order(page)==['Source page 2','Source page 1','Source page 3']
    page.locator('.continuous-viewport').focus();page.keyboard.press('Control+z');ready(page)
    assert order(page)==['Source page 2','Source page 1','Source page 3'];assert dirty(page)
    page.keyboard.press('Control+z');ready(page);assert order(page)==['Source page 1','Source page 2','Source page 3'];assert not dirty(page)
    page.keyboard.press('Control+Shift+z');page.keyboard.press('Control+Shift+z');ready(page)
    alpha=save_project(page);assert [p['pageIndex'] for p in alpha['pages']]==[1,0,2];assert alpha['pages'][1]['rotation']==90
    assert all(p['documentId']!=beta['pages'][0]['documentId'] for p in alpha['pages'])
    select(page,'beta.pdf');assert not dirty(page);assert zoom(page)=='100%';beta_again=save_project(page);assert beta_again['pages']==beta['pages']
    assert not page.locator('.page-placeholder.error').count()
    return{'tabs':2,'historyAndRedoIsolated':True,'pageOrderAndRotationRetained':True,'zoomAndExactScrollRetained':True,'savedFlagsIndependent':True,'savedNativeSourcesSeparate':True}

def duplicate_focus(page,url):
    fresh(page,url);open_files(page,['C:/alpha.pdf']);open_files(page,['C:/beta.pdf']);opened=len(snapshot(page)['opened'])
    page.evaluate('(paths)=>harness.emitExternal(paths)',['C:\\ALPHA.pdf']);page.wait_for_function("document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('alpha.pdf')");ready(page)
    assert count(page)==2;assert len(snapshot(page)['opened'])==opened
    open_files(page,['C:/beta.pdf']);assert count(page)==2;assert len(snapshot(page)['opened'])==opened;assert tab(page,'beta.pdf').get_attribute('aria-selected')=='true'
    return{'caseInsensitiveExternalPathFocusesExistingTab':True,'manualDuplicateFocusesExistingTab':True,'noDuplicateNativeOpen':True}

def dirty_close(page,url):
    fresh(page,url);open_files(page,['C:/alpha.pdf']);rotate(page);open_files(page,['C:/beta.pdf']);rotate(page)
    closed_before=len(commands(page,'close_all_documents'))
    page.get_by_role('button',name='Close tab: beta.pdf',exact=True).click();page.get_by_role('button',name='Keep editing',exact=True).click();assert count(page)==2;assert dirty(page)
    page.keyboard.press('Control+w');page.get_by_role('button',name='Close PDF without saving',exact=True).click();ready(page)
    assert count(page)==1;assert tab(page,'alpha.pdf').get_attribute('aria-selected')=='true';assert dirty(page)
    assert len(commands(page,'close_all_documents'))==closed_before,'Closing one tab must not invalidate another workspace'
    alpha=save_project(page);assert alpha['pages'][0]['rotation']==90
    page.keyboard.press('Control+w');page.wait_for_function("!document.querySelector('.continuous-viewport')")
    assert count(page)==0;assert snapshot(page)['destroyed']==0
    return{'dirtyCloseCancelKeepsState':True,'discardClosesOnlyCurrentTab':True,'otherDirtyTabAndNativeSourceSurvive':True,'lastTabReturnsToWelcome':True,'windowNotDestroyed':True}

def queued_external(page,url):
    fresh(page,url,['C:/alpha.pdf','C:/beta.pdf']);ready(page);assert count(page)==2
    page.evaluate("stats.blockPath='C:/gamma.pdf';harness.emitExternal(['C:/gamma.pdf'])")
    page.wait_for_function('stats.blocked>0');page.evaluate("harness.emitExternal(['C:/delta.pdf']);harness.emitExternal(['C:/epsilon.pdf'])");page.wait_for_timeout(60);page.evaluate('harness.releaseOpen()')
    page.wait_for_function("document.querySelectorAll('[role=tab]').length===5",timeout=15000);ready(page)
    names=page.get_by_role('tab').all_text_contents();assert all(any(name in text for text in names) for name in ['alpha.pdf','beta.pdf','gamma.pdf','delta.pdf','epsilon.pdf'])
    paths=[item['path'] for item in snapshot(page)['opened']];assert len(paths)==len(set(paths))==5
    assert len(commands(page,'drain_open_requests'))>=2
    return{'startupBatchCreatesSeparateTabs':True,'externalRequestsDuringNativeOpenQueued':True,'fiveRequestsOpenedOnceEach':True}

def append_still_merges(page,url):
    fresh(page,url);open_files(page,['C:/alpha.pdf','C:/beta.pdf']);assert count(page)==2;select(page,'alpha.pdf')
    page.evaluate("harness.queueDialog(['C:/gamma.pdf'])");page.keyboard.press('Control+Shift+o');page.get_by_role('dialog',name='Import and merge PDFs').wait_for();page.get_by_role('button',name='Import pages',exact=True).click();ready(page)
    assert count(page)==2;assert dirty(page)
    merged=save_project(page);assert len(merged['pages'])==4;assert len(set(p['documentId'] for p in merged['pages']))==2
    select(page,'beta.pdf');assert not dirty(page);beta=save_project(page);assert len(beta['pages'])==2
    assert all(p['documentId'] not in {q['documentId'] for q in merged['pages']} for p in beta['pages'])
    return{'multiSelectOpenCreatesTwoTabs':True,'addPdfMergesIntoActiveWorkspace':True,'mergeDoesNotCreateExtraTab':True,'otherWorkspaceUnchanged':True}

def hidden_dirty_exit_guard(page,url):
    fresh(page,url);open_files(page,['C:/alpha.pdf']);rotate(page);open_files(page,['C:/beta.pdf']);assert not dirty(page)
    guarded=page.evaluate("()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}")
    assert guarded,'An inactive dirty workspace must still protect window unloading'
    page.evaluate('harness.requestWindowClose()');page.get_by_role('dialog',name='Save changes before quitting?',exact=True).wait_for()
    assert snapshot(page)['destroyed']==0;page.get_by_role('button',name='Keep editing',exact=True).click();assert count(page)==2
    select(page,'alpha.pdf');assert dirty(page);saved=save_project(page);assert saved['pages'][0]['rotation']==90
    return{'inactiveDirtyTabProtectsBeforeUnload':True,'windowClosePromptsForInactiveChanges':True,'cancelExitKeepsBothTabsAndEdits':True}

def tab_keyboard_navigation(page,url):
    fresh(page,url);open_files(page,['C:/alpha.pdf','C:/beta.pdf','C:/gamma.pdf']);assert selected_title(page)=='gamma.pdf'
    result=[]
    for shortcut,expected in [('Control+Tab','alpha.pdf'),('Control+Shift+Tab','gamma.pdf'),('Control+PageUp','beta.pdf'),('Control+PageDown','gamma.pdf')]:
        page.locator('.continuous-viewport').focus();page.keyboard.press(shortcut);ready(page)
        assert selected_title(page)==expected,(shortcut,selected_title(page));result.append({'shortcut':shortcut,'selected':expected})
    assert count(page)==3 and len(snapshot(page)['opened'])==3
    return{'keyboardNavigation':result,'noDuplicateDocuments':True}

def sidebar_width_anchor(page,url):
    fresh(page,url);open_files(page,['C:/alpha.pdf']);page.locator('.zoom-label').click()
    for _ in range(15):page.keyboard.press('Control+=')
    ready(page);assert zoom(page)=='250%'
    page.locator('.continuous-viewport').evaluate('element=>{element.scrollLeft=180;element.scrollTop=430;element.dispatchEvent(new Event("scroll"));}');page.wait_for_timeout(120)
    before=reader_center(page);open_files(page,['C:/beta.pdf'])
    page.get_by_role('button',name='Collapse left navigation',exact=True).click();page.wait_for_timeout(220)
    select(page,'alpha.pdf');after=reader_center(page)
    assert after['width']>before['width']+100,(before,after)
    assert before['id']==after['id'] and abs(before['x']-after['x'])<.002 and abs(before['y']-after['y'])<.002,(before,after)
    assert zoom(page)=='250%'
    return{'before':before,'after':after,'samePdfPointAtNewViewportCenter':True,'globalSidebarPreferenceRetained':True}

def synchronous_external_batches(page,url):
    # A confirmation blocks tab switching without blocking native queue drains.
    # This builds distinct pending batches whose first item focuses an existing
    # tab synchronously, then verifies it cannot starve the later valid batch.
    fresh(page,url);open_files(page,['C:/alpha.pdf']);rotate(page);page.keyboard.press('Control+w')
    prompt=page.get_by_role('dialog',name='Save changes before closing this PDF?',exact=True);prompt.wait_for()
    drains=len(commands(page,'drain_open_requests'))
    for paths in [[],['C:/alpha.pdf'],['C:/beta.pdf']]:
        page.evaluate('(paths)=>harness.emitExternal(paths)',paths);drains+=1
        page.wait_for_function('(n)=>stats.calls.filter(item=>item.command==="drain_open_requests").length>=n&&stats.openQueue.length===0',arg=drains)
        page.wait_for_timeout(80)
    assert count(page)==1 and prompt.is_visible()
    page.get_by_role('button',name='Keep editing',exact=True).click()
    page.wait_for_function('document.querySelectorAll("[role=tab]").length===2');ready(page)
    assert selected_title(page)=='beta.pdf';assert len(snapshot(page)['opened'])==2
    select(page,'alpha.pdf');assert dirty(page);saved=save_project(page);assert saved['pages'][0]['rotation']==90
    return{'emptyNativeBatchDrained':True,'duplicateBatchFinishesWithoutNativeOpen':True,'followingValidBatchNotStarved':True,'confirmationCancelPreservesOriginalEdit':True}

def two_dirty_tabs_exit_cancel(page,url):
    fresh(page,url);open_files(page,['C:/alpha.pdf']);rotate(page);open_files(page,['C:/beta.pdf']);rotate(page)
    prompt=page.get_by_role('dialog',name='Save changes before quitting?',exact=True)
    rounds=[]
    for _ in range(2):
        page.evaluate('harness.requestWindowClose()');prompt.wait_for();first=selected_title(page)
        page.get_by_role('button',name='Quit without saving',exact=True).click()
        page.wait_for_function('(title)=>document.querySelector("[role=tab][aria-selected=true] .document-tab-name")?.textContent!==title',arg=first)
        prompt.wait_for();second=selected_title(page);assert {first,second}=={'alpha.pdf','beta.pdf'}
        assert snapshot(page)['destroyed']==0
        page.get_by_role('button',name='Keep editing',exact=True).click();assert count(page)==2
        assert page.locator('.document-tab.dirty').count()==2
        rounds.append([first,second])
    for name in ['alpha.pdf','beta.pdf']:
        select(page,name);assert dirty(page)
    return{'eachDirtyTabPromptsBeforeExit':True,'cancelSecondPromptRetainsBothHistories':True,'newExitAttemptResetsPreviousAcknowledgements':True,'promptRounds':rounds,'windowNotDestroyed':True}

def hold_import_chooser(page,result):
    page.evaluate('(result)=>{stats.holdChooser=true;harness.queueDialog(result);}',result)
    page.keyboard.press('Control+Shift+o');page.wait_for_function('stats.chooserBlocked===1')
    drains=len(commands(page,'drain_open_requests'))
    page.evaluate("harness.emitExternal(['C:/beta.pdf'])")
    page.wait_for_function('(n)=>stats.calls.filter(item=>item.command==="drain_open_requests").length>n&&stats.openQueue.length===0',arg=drains)
    page.wait_for_timeout(200)
    assert count(page)==1 and selected_title(page)=='alpha.pdf'
    assert len(snapshot(page)['opened'])==1,'An external request must not change the import destination while the native chooser is open'

def cancelled_chooser_releases_external_queue(page,url):
    fresh(page,url);open_files(page,['C:/alpha.pdf']);hold_import_chooser(page,None)
    page.evaluate('harness.releaseChooser()')
    page.wait_for_function('document.querySelectorAll("[role=tab]").length===2');ready(page)
    assert selected_title(page)=='beta.pdf';assert not page.get_by_role('dialog',name='Import and merge PDFs').count()
    select(page,'alpha.pdf');assert not dirty(page);saved=save_project(page);assert len(saved['pages'])==3
    assert len(snapshot(page)['opened'])==2
    return{'externalNativeQueueDrainsDuringChooser':True,'chooserCancelKeepsImportTargetUnchanged':True,'queuedExternalOpenResumesAfterCancel':True,'noAccidentalImport':True}

def completed_chooser_keeps_import_target(page,url):
    fresh(page,url);open_files(page,['C:/alpha.pdf']);hold_import_chooser(page,['C:/gamma.pdf'])
    page.evaluate('harness.releaseChooser()')
    dialog=page.get_by_role('dialog',name='Import and merge PDFs',exact=True);dialog.wait_for();page.wait_for_timeout(120)
    assert count(page)==1 and selected_title(page)=='alpha.pdf';assert len(snapshot(page)['opened'])==1
    page.get_by_role('button',name='Import pages',exact=True).click()
    page.wait_for_function('document.querySelectorAll("[role=tab]").length===2');ready(page)
    assert selected_title(page)=='beta.pdf'
    beta=save_project(page);assert len(beta['pages'])==2
    select(page,'alpha.pdf');assert dirty(page);merged=save_project(page);assert len(merged['pages'])==4
    assert len(set(item['documentId'] for item in merged['pages']))==2
    assert not ({item['documentId'] for item in merged['pages']}&{item['documentId'] for item in beta['pages']})
    assert [item['path'] for item in snapshot(page)['opened']]==['C:/alpha.pdf','C:/gamma.pdf','C:/beta.pdf']
    return{'externalOpenWaitsThroughChooserAndImportConfirmation':True,'chosenContentMergesOnlyIntoOriginalTab':True,'externalTabOpensAfterImportCompletes':True,'savedPlansProveSourceSeparation':True}

def main():
    out=ROOT/f'test-results/{VERSION}';out.mkdir(parents=True,exist_ok=True)
    (out/'document-tabs-harness.tsx').write_text(HARNESS,encoding='utf-8');(out/'document-tabs-harness.html').write_text(HTML,encoding='utf-8')
    tracked=[path for path in SOURCES if (ROOT/path).exists()]
    report={'method':'Real App/React and isolated headless Chrome with synthetic Tauri IPC; no physical printer, private PDF or OS associations','sourceSha256':{s:hashlib.sha256((ROOT/s).read_bytes()).hexdigest() for s in tracked},'cases':[],'pageErrors':[]}
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    log=(out/'document-tabs-vite.log').open('w',encoding='utf-8')
    server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',str(port),'--strictPort'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        url=f'http://127.0.0.1:{port}/test-results/{VERSION}/document-tabs-harness.html'
        for _ in range(100):
            try:urllib.request.urlopen(url,timeout=.3).close();break
            except Exception:time.sleep(.1)
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True)
            context=browser.new_context(viewport={'width':1460,'height':1000},device_scale_factor=1)
            page=context.new_page();page.set_default_timeout(9000);page.on('pageerror',lambda error:report['pageErrors'].append(str(error)))
            # Each case starts from a fresh synthetic workspace. Accept only this
            # isolated browser's navigation confirmation when resetting a failed case.
            page.on('dialog',lambda dialog:dialog.accept())
            for name,run in [('independent-workspace-history-view-and-save',state_isolation),('duplicate-file-focus',duplicate_focus),('dirty-and-last-tab-close',dirty_close),('startup-and-busy-external-queue',queued_external),('open-versus-import-merge',append_still_merges),('inactive-dirty-workspace-exit-guard',hidden_dirty_exit_guard),('keyboard-tab-navigation',tab_keyboard_navigation),('reader-anchor-after-sidebar-width-change',sidebar_width_anchor),('synchronous-external-batch-progress',synchronous_external_batches),('two-dirty-tabs-exit-cancel-and-retry',two_dirty_tabs_exit_cancel),('cancel-native-import-chooser-with-external-request',cancelled_chooser_releases_external_queue),('complete-native-import-chooser-with-external-request',completed_chooser_keeps_import_target)]:
                case={'name':name}
                try:case.update(status='PASS',result=run(page,url))
                except Exception as error:case.update(status='FAIL',error=str(error),traceback=traceback.format_exc(),body=page.locator('body').inner_text()[:3500],calls=page.evaluate('window.stats?.calls.slice(-20)??[]'))
                page.screenshot(path=str(out/f'document-tabs-{name}.png'));report['cases'].append(case);print(json.dumps({key:value for key,value in case.items() if key not in ['traceback','body','calls']},ensure_ascii=False),flush=True)
            context.close();browser.close()
    except Exception as error:report.update(fatalError=str(error),traceback=traceback.format_exc())
    finally:
        server.terminate()
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:server.kill();server.wait()
        log.close()
    report['changedSources']=[s for s,h in report['sourceSha256'].items() if hashlib.sha256((ROOT/s).read_bytes()).hexdigest()!=h]
    report['status']='FAIL' if report.get('fatalError') or report['pageErrors'] or report['changedSources'] or any(case['status']!='PASS' for case in report['cases']) else 'PASS'
    (out/'document-tabs-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print('REPORT '+report['status'])
    if report['status']!='PASS':sys.exit(1)
if __name__=='__main__':main()

