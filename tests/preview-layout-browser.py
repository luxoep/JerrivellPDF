# SPDX-License-Identifier: MIT OR Apache-2.0
"""Real-Chromium preview layout regression in a new isolated headless profile.

Development-only requirements: TypeScript in node_modules, Python Playwright,
Chrome or Edge. No PDF, native backend, app dependency or user browser is used.
Example:
  python tests/preview-layout-browser.py --single --seconds 12
  python tests/preview-layout-browser.py --matrix --seconds 2 --operations

Playwright's default --hide-scrollbars is deliberately removed: it otherwise
masks the exact feedback loop this test must detect.
"""
from pathlib import Path
from functools import lru_cache
import argparse, hashlib, json, os, subprocess, sys

ROOT = Path(__file__).resolve().parents[1]
TOOL_DIR = ROOT / 'test-results/0.8.3/browser-tools'
if TOOL_DIR.is_dir():
    sys.path.insert(0, str(TOOL_DIR))
from playwright.sync_api import sync_playwright

SOURCES = ['src/components/preview-zoom.css', 'src/components/document-tools.css',
           'src/styles.css', 'src/jerry-theme.css', 'src/ui-polish.css']

@lru_cache(maxsize=4)
def transpile(path):
    code = "import fs from 'node:fs';import ts from 'typescript';process.stdout.write(ts.transpileModule(fs.readFileSync(process.argv[1],'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText);"
    return subprocess.check_output(['node', '--input-type=module', '-e', code, str(path)], cwd=ROOT, text=True, encoding='utf-8')

PROBE = r'''
window.samples=[];
const NativeRO=ResizeObserver;
window.stats={ro:0,scaleCallbacks:0,draws:0,styleMutations:0,lastScale:1};
window.ResizeObserver=class extends NativeRO{constructor(callback){super((entries, observer)=>{stats.ro+=entries.length;callback(entries,observer);});}};
const draw=CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage=function(...args){stats.draws++;return draw.apply(this,args);};
function state(){
 const v=document.querySelector('.preview-zoom-viewport'),p=document.querySelector('.preview-zoom-paper'),c=document.querySelector('canvas'),r=v.getBoundingClientRect(),pr=p.getBoundingClientRect(),cr=c.getBoundingClientRect();
 return {cw:v.clientWidth,ch:v.clientHeight,sw:v.scrollWidth,sh:v.scrollHeight,vw:r.width,vh:r.height,pw:pr.width,ph:pr.height,bw:c.width,bh:c.height,canvasWidth:cr.width,canvasHeight:cr.height,scrollLeft:v.scrollLeft,scrollTop:v.scrollTop,scale:stats.lastScale};
}
window.boot=async(width,height)=>{
 await document.fonts.ready;
 const source=new Image();source.src='data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><text x="32" y="80" font-size="38">Original preview fixture</text></svg>`);await source.decode();
 const v=document.querySelector('.preview-zoom-viewport'),e=document.querySelector('.preview-zoom-extent'),p=document.querySelector('.preview-zoom-paper');
 window.controller=zoom.createPreviewZoomController(v,e,p,width,height,value=>{stats.scaleCallbacks++;stats.lastScale=value;});
 window.destroyRaster=raster.createPreviewRasterPainter(document.querySelector('canvas'),source);
};
window.start=async(width,height)=>{
 const mutation=new MutationObserver(records=>{stats.styleMutations+=records.length;});
 for(const node of document.querySelectorAll('.preview-zoom-viewport,.preview-zoom-extent,.preview-zoom-paper,canvas'))mutation.observe(node,{attributes:true,attributeFilter:['style','width','height']});
 await boot(width,height);
 let elapsed=0;window.timer=setInterval(()=>{samples.push({elapsed:elapsed+=100,ro:stats.ro,scaleCallbacks:stats.scaleCallbacks,draws:stats.draws,styleMutations:stats.styleMutations,...state()});},100);
};
window.replaceSource=async(width,height)=>{destroyRaster();controller.destroy();await boot(width,height);};
'''
PAPER = '<div class="preview-zoom"><div class="preview-zoom-tools"><span>Ctrl + 滚轮</span><button>-</button><button class="preview-zoom-reset">100%</button><button>+</button></div><div class="preview-zoom-viewport"><div class="preview-zoom-extent"><div class="preview-zoom-paper"><div class="dt-tool-page" style="width:100%;height:100%"><canvas class="tool-preview-raster"></canvas></div></div></div></div></div>'

@lru_cache(maxsize=4)
def resources(base):
    css = '\n'.join((base/name).read_text(encoding='utf-8') for name in SOURCES)
    script = '{const exports={};'+transpile(base/'src/previewZoom.ts')+';window.zoom=exports;}\n{const exports={};'+transpile(base/'src/previewRaster.ts')+';window.raster=exports;}'
    return css, script

def html(base, full=True, extra=''):
    css, script = resources(base)
    if full:
        content = ('<div class="dt-backdrop"><div class="dt-modal page-tools-modal"><header class="dt-header"><div><h2>页面与批量工具</h2><p>页面修改可撤销；导出前会检查页序、大小与结构风险。</p></div><button>X</button></header><nav class="dt-tabs">'+''.join('<button>○ '+s+'</button>' for s in ['图片转PDF','批量拆分','页码','水印','裁剪'])+'</nav><div class="page-tools-body"><section class="page-tools-fields"><label class="dt-field">处理页面<select><option>全部页面</option></select></label></section><section class="tool-preview-workspace"><div class="tool-preview-heading"><div><b>拆分文件与页序</b><span>来源页 1 · Original synthetic fixture.pdf</span></div></div><div class="tool-split-groups"><button class="active"><b>1. Original_fixture_001.pdf</b><span>1 页 · 1</span></button></div><div class="tool-preview-stage">'+PAPER+'</div><div class="dt-page-nav"><button>‹</button><span>1 / 1</span><button>›</button></div></section></div><footer class="dt-footer"><button class="button secondary">取消</button><button class="button primary">预览拆分结果</button></footer></div></div>')
    else:
        content = '<div class="tool-preview-stage" style="width:950px;height:400.5px">'+PAPER+'</div>'
    return '<!doctype html><meta charset="utf-8"><style>'+css+'\n'+extra+'</style>'+content+'<script>'+PROBE+'\n'+script+'</script>'

def idle(page, label):
    page.wait_for_timeout(300)
    before = page.evaluate('({...stats,...state()})')
    page.wait_for_timeout(1200)
    after = page.evaluate('({...stats,...state()})')
    for key in ['ro','draws','styleMutations']:
        assert after[key] == before[key], (label, key, before, after)
    assert abs(after['pw']-after['canvasWidth']) < .05 and abs(after['ph']-after['canvasHeight']) < .05, (label,'canvas must match the paper')
    return {'step':label,'idleDraws':after['draws']-before['draws'],'idleRO':after['ro']-before['ro'],'state':after}

def operations(browser, base):
    ctx=browser.new_context(viewport={'width':1362,'height':932},device_scale_factor=1.25)
    page=ctx.new_page();page.set_content(html(base));page.evaluate('start(842,595)')
    records=[idle(page,'initial fit')]
    page.evaluate('controller.zoomBy(1.2)');records.append(idle(page,'120 percent'))
    assert records[-1]['state']['scale'] == 1.2
    box=page.locator('.preview-zoom-viewport').bounding_box();page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2)
    before=page.evaluate('state().scrollTop');page.mouse.wheel(0,180);page.wait_for_timeout(250)
    assert page.evaluate('state().scrollTop') > before, 'Normal wheel must scroll at enlarged size'
    page.keyboard.down('Control');page.mouse.wheel(0,-100);page.keyboard.up('Control');records.append(idle(page,'Ctrl wheel'))
    assert records[-1]['state']['scale'] > 1.2
    page.evaluate('controller.reset()');records.append(idle(page,'reset'))
    assert records[-1]['state']['scale'] == 1 and records[-1]['state']['scrollLeft'] == records[-1]['state']['scrollTop'] == 0
    page.set_viewport_size({'width':1366,'height':931});records.append(idle(page,'window resize'))
    page.evaluate('replaceSource(595,842)');records.append(idle(page,'source switch to portrait'))
    assert records[-1]['state']['ph'] > records[-1]['state']['pw']
    # Canvas backing dimensions remain within the production memory ceiling.
    assert records[-1]['state']['bw'] <= 4096 and records[-1]['state']['bh'] <= 4096
    ctx.close();return records

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--baseline',action='store_true');parser.add_argument('--seconds',type=float,default=12);parser.add_argument('--output',default='test-results/0.8.3/browser-layout.json');parser.add_argument('--matrix',action='store_true');parser.add_argument('--single',action='store_true');parser.add_argument('--zoom',type=float,default=1);parser.add_argument('--operations',action='store_true');parser.add_argument('--browser',default=os.environ.get('JERRIVELL_TEST_BROWSER',r'C:\Program Files\Google\Chrome\Application\chrome.exe'));args=parser.parse_args()
    base=ROOT/'test-results/0.8.3/browser-baseline' if args.baseline else ROOT
    files=SOURCES+['src/previewZoom.ts','src/previewRaster.ts']
    report={'source':'baseline' if args.baseline else 'current','sourceSha256':{name:hashlib.sha256((base/name).read_bytes()).hexdigest() for name in files},'cases':[]}
    with sync_playwright() as pw:
        browser=pw.chromium.launch(executable_path=args.browser,headless=True,ignore_default_args=['--hide-scrollbars'],args=['--disable-features=OverlayScrollbar'])
        configs=[(1362,h,dpr,842,595,True,'') for h in ([932] if args.single else [932,900,931,933]) for dpr in ([1,1.25,1.5] if args.matrix else [1])]
        if args.matrix:
            configs += [(1362,932,1,w,h,False,f'.tool-preview-stage{{height:{400+f}px!important}}') for w,h in [(842,595),(595,842)] for f in [.125,.25,.375,.5,.625,.75,.875]]
            configs += [(1362,932,1,w,h,False,f'.tool-preview-stage{{width:{950+f}px!important}}') for w,h in [(842,595),(595,842)] for f in [.125,.25,.375,.5,.625,.75,.875]]
            configs += [(w,932,1.25,842,595,True,'') for w in [1000,1280,1366,1536,1920]]
            configs += [(1362,932,dpr,595,842,True,'') for dpr in [1,1.25,1.5]]
        for W,H,DPR,pw_,ph_,full,extra in configs:
            ctx=browser.new_context(viewport={'width':W,'height':H},device_scale_factor=DPR);page=ctx.new_page();page.set_content(html(base,full,extra));page.evaluate('([w,h])=>start(w,h)',[pw_,ph_])
            if args.zoom!=1:page.evaluate('(z)=>controller.zoomBy(z)',args.zoom)
            page.wait_for_timeout(args.seconds*1000)
            data=page.evaluate('({stats,samples,last:state()})')
            tail=[s for s in data['samples'] if s['elapsed']>=1000]
            unique={tuple(s[k] for k in ['cw','ch','pw','ph','sw','sh']) for s in tail}
            case={'viewport':[W,H],'dpr':DPR,'zoom':args.zoom,'paper':[pw_,ph_],'fullModal':full,'extra':extra,'ro':data['stats']['ro'],'scaleCallbacks':data['stats']['scaleCallbacks'],'draws':data['stats']['draws'],'tailUnique':len(unique),'tailRO':tail[-1]['ro']-tail[0]['ro'] if tail else 0,'tailDraws':tail[-1]['draws']-tail[0]['draws'] if tail else 0,'tailStyleMutations':tail[-1]['styleMutations']-tail[0]['styleMutations'] if tail else 0,'last':data['last'],'samples':data['samples']}
            report['cases'].append(case);print(json.dumps({k:v for k,v in case.items() if k!='samples'}),flush=True);ctx.close()
        if args.operations:
            report['operations']=operations(browser,base)
        browser.close()
    report['loopingCases']=sum(c['tailDraws']>0 or c['tailRO']>0 or c['tailStyleMutations']>0 or c['tailUnique']>1 for c in report['cases'])
    report['status']=('REPRODUCED' if report['loopingCases'] else 'NO_REPRODUCTION') if args.baseline else ('FAIL' if report['loopingCases'] else 'PASS')
    output=ROOT/args.output;output.parent.mkdir(exist_ok=True,parents=True);output.write_text(json.dumps(report,indent=2),encoding='utf-8');print('REPORT '+str(output)+' looping='+str(report['loopingCases']))
    if not args.baseline and report['loopingCases']:sys.exit(1)
if __name__=='__main__':main()
