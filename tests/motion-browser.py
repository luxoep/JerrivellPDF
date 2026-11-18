# SPDX-License-Identifier: MIT OR Apache-2.0
"""Actual shipped CSS in Chrome: finite chrome motion, stationary PDF surfaces."""
from pathlib import Path
import hashlib,json,socket,subprocess,sys,time,traceback,urllib.request

ROOT=Path(__file__).resolve().parents[1]
VERSION=json.loads((ROOT/'package.json').read_text())['version']
sys.path.insert(0,str(ROOT/'test-results/0.8.3/browser-tools'))
from playwright.sync_api import sync_playwright

HTML='''<!doctype html><meta charset="utf-8"><div id="host"></div><script type="module">
import '/src/styles.css';
import '/src/components/reader-experience.css';
import '/src/components/overlay-editor.css';
import '/src/components/original-content.css';
import '/src/components/document-tools.css';
import '/src/components/image-workbench.css';
import '/src/components/print-dialog.css';
import '/src/jerry-theme.css';
import '/src/ui-polish.css';
window.motionFixture={mount(kind){
 const host=document.querySelector('#host');host.innerHTML='';
 const panel=document.createElement('section');
 const kinds={content:['oe-panel','oe-header'],original:['original-editor','oc-header'],pages:['dt-modal','dt-header'],image:['image-workbench','dt-header'],print:['print-dialog','print-heading'],ordinary:['modal','modal-symbol']};
 const [surface,header]=kinds[kind];panel.className=surface;
 if(['pages','image','print','ordinary'].includes(kind)){
  const backdrop=document.createElement('div');backdrop.className=kind==='pages'?'dt-backdrop':kind==='image'?'image-workbench-backdrop':'modal-backdrop';backdrop.append(panel);host.append(backdrop);
 }else host.append(panel);
 panel.style.height='650px';panel.style.width='min(900px,90vw)';panel.style.background='#fffdf6';
 panel.innerHTML=`<header class="${header}"><h2>Function controls</h2><button>Close</button></header><div class="pdf-sheet" style="width:300px;height:400px;align-self:center"><canvas width="600" height="800" style="width:300px;height:400px"></canvas></div>`;
 const canvas=panel.querySelector('canvas');const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,600,800);c.fillStyle='black';c.font='30px Arial';c.fillText('Stationary PDF pixels',25,80);
 window.pdfResizes=0;window.pdfObserver?.disconnect();window.pdfObserver=new ResizeObserver(()=>window.pdfResizes++);window.pdfObserver.observe(canvas);
 return true;
}, async sample(){
 const samples=[];const start=performance.now();
 while(performance.now()-start<260){
  const panel=document.querySelector('#host section'),canvas=panel.querySelector('canvas'),sheet=panel.querySelector('.pdf-sheet');
  const rect=canvas.getBoundingClientRect();const styles=[panel,sheet,canvas].map(e=>{const s=getComputedStyle(e);return {opacity:s.opacity,transform:s.transform,filter:s.filter};});
  const pseudo=getComputedStyle(panel,'::after');const header=getComputedStyle(panel.querySelector('header'));
  samples.push({time:performance.now()-start,rect:[rect.x,rect.y,rect.width,rect.height],styles,veilAnimation:pseudo.animationName,veilVisibility:pseudo.visibility,headerAnimation:header.animationName});
  await new Promise(requestAnimationFrame);
 }
 return {samples,resizes:window.pdfResizes,animations:document.getAnimations().filter(a=>a.playState==='running').map(a=>a.animationName),canvas:[document.querySelector('canvas').width,document.querySelector('canvas').height]};
}};
</script>'''

def main():
    out=ROOT/f'test-results/{VERSION}';out.mkdir(parents=True,exist_ok=True)
    (out/'motion-harness.html').write_text(HTML,encoding='utf-8')
    sources=['src/ui-polish.css','src/components/DeferredDialog.tsx','tests/motion-browser.py']
    report={'sourceSha256':{p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in sources},'cases':[],'pageErrors':[]}
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    log=(out/'motion-vite.log').open('w',encoding='utf-8')
    server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',str(port),'--strictPort'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        url=f'http://127.0.0.1:{port}/test-results/{VERSION}/motion-harness.html'
        for _ in range(100):
            try:urllib.request.urlopen(url,timeout=.3).close();break
            except Exception:time.sleep(.1)
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True)
            for reduced in [False,True]:
                context=browser.new_context(viewport={'width':1362,'height':950},reduced_motion='reduce' if reduced else 'no-preference');page=context.new_page();page.on('pageerror',lambda e:report['pageErrors'].append(str(e)))
                page.goto(url,wait_until='domcontentloaded',timeout=45000);page.wait_for_function('!!window.motionFixture')
                for kind in ['content','original','pages','image','print','ordinary']:
                    page.evaluate('(kind)=>motionFixture.mount(kind)',kind);result=page.evaluate('motionFixture.sample()');samples=result['samples']
                    assert samples and len(samples)>=2
                    first=samples[0]['rect']
                    for sample in samples:
                        assert sample['rect']==first,(kind,sample)
                        for style in sample['styles']:
                            assert style=={'opacity':'1','transform':'none','filter':'none'},(kind,style)
                    assert result['canvas']==[600,800],kind
                    assert result['resizes']<=1,(kind,result['resizes'])
                    assert result['animations']==[],(kind,result['animations'])
                    if reduced:assert all(sample['veilAnimation']=='none' and sample['headerAnimation']=='none' for sample in samples),kind
                    else:assert samples[0]['veilAnimation']=='jerrivell-surface-reveal',kind
                    assert samples[-1]['veilVisibility']=='hidden',kind
                    report['cases'].append({'kind':kind,'reducedMotion':reduced,'frames':len(samples),'pdfBoundsStationary':True,'pdfAncestorsOpaqueAndUntransformed':True,'canvasResizes':result['resizes'],'idleAnimations':0})
                context.close()
            browser.close()
    except Exception as error:report.update(error=str(error),traceback=traceback.format_exc())
    finally:
        server.terminate()
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:server.kill();server.wait()
        log.close()
    report['changedSources']=[p for p,h in report['sourceSha256'].items() if hashlib.sha256((ROOT/p).read_bytes()).hexdigest()!=h]
    report['status']='FAIL' if report.get('error') or report['pageErrors'] or report['changedSources'] or len(report['cases'])!=12 else 'PASS'
    (out/'motion-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2))
    if report['status']!='PASS':sys.exit(1)

if __name__=='__main__':main()
