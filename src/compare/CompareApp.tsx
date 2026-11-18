// SPDX-License-Identifier: MIT OR Apache-2.0
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {PointerEvent as ReactPointerEvent} from 'react';
import {open,save} from '@tauri-apps/plugin-dialog';
import {getCurrentWebviewWindow} from '@tauri-apps/api/webviewWindow';
import {ArrowLeftRight,Check,ChevronLeft,ChevronRight,Download,FileText,FolderOpen,Layers3,LoaderCircle,Maximize2,Minus,MousePointer2,Plus,ScanLine,ShieldCheck,SquareDashed,Trash2,X} from 'lucide-react';
import icon from '../brand/jerrivell-icon.svg';
import {compareCall,compareClose,comparePoll,compareReset,compareResetEvent,message} from './client';
import {detailBounds,optionsKey,validateReport} from './types';
import type {Options,Preview,Progress,Rect,Region,Report,Source} from './types';

type Mode='split'|'overlay'|'curtain'|'blink';
type Tool='pan'|'ignore'|'align';
const emptyJob:Progress={jobId:'',status:'idle',completed:0,total:0,report:null,error:null};
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));

export default function CompareApp(){
  const [language,setLanguage]=useState(()=>new URLSearchParams(location.search).get('lang')==='en-US'?'en-US':'zh-CN');
  const tr=useCallback((zh:string,en:string)=>language==='en-US'?en:zh,[language]);
  useEffect(()=>{document.documentElement.lang=language},[language]);
  const [a,setA]=useState<Source|null>(null),[b,setB]=useState<Source|null>(null);
  const [pageA,setPageA]=useState('1'),[pageB,setPageB]=useState('1'),[dx,setDx]=useState('0'),[dy,setDy]=useState('0');
  const [dpi,setDpi]=useState(300),[threshold,setThreshold]=useState(0),[ignored,setIgnored]=useState<Rect[]>([]);
  const [guard,setGuard]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState(''),[note,setNote]=useState('');
  const busyRef=useRef(false),[revision,setRevision]=useState(0);
  const [preview,setPreview]=useState<Preview|null>(null),[previewLoading,setPreviewLoading]=useState(false);
  const [job,setJob]=useState<Progress>(emptyJob),[report,setReport]=useState<Report|null>(null);
  const [selected,setSelected]=useState(0),[reviewed,setReviewed]=useState<Set<number>>(new Set()),[savedReview,setSavedReview]=useState('[]');
  const [mode,setMode]=useState<Mode>('split'),[tool,setTool]=useState<Tool>('pan'),[alpha,setAlpha]=useState(.5),[showDiff,setShowDiff]=useState(true);
  const [blink,setBlink]=useState(false),[blinkPaused,setBlinkPaused]=useState(false);
  const [zoom,setZoom]=useState(1),[paneWidth,setPaneWidth]=useState(500);
  const viewportA=useRef<HTMLDivElement>(null),viewportB=useRef<HTMLDivElement>(null),viewportMix=useRef<HTMLDivElement>(null);
  const paneRef=useRef<HTMLDivElement>(null),anchor=useRef<{x:number;y:number;screenX:number;screenY:number}|null>(null);
  const [draft,setDraft]=useState<Rect|null>(null),pointerStart=useRef<{x:number;y:number}|null>(null);
  const panGesture=useRef<{surface:HTMLDivElement;x:number;y:number;left:number;top:number}|null>(null);
  const [alignPoint,setAlignPoint]=useState<[number,number]|null>(null);
  const [detail,setDetail]=useState<Preview|null>(null),[detailLoading,setDetailLoading]=useState(false);
  const previewCache=useRef(new Map<string,Preview>()),detailCache=useRef(new Map<string,Preview>());
  const [password,setPassword]=useState<{side:'a'|'b';path:string}|null>(null),[passwordValue,setPasswordValue]=useState('');
  const [confirmation,setConfirmation]=useState<'close'|'run'|'reset'|'source-a'|'source-b'|null>(null);
  const mounted=useRef(true),jobRef=useRef(job),reviewDirtyRef=useRef(false);
  const [filter,setFilter]=useState('all');
  jobRef.current=job;
  const running=job.status==='running',working=!!busy||running;
  const reviewSignature=JSON.stringify([...reviewed].sort((a,b)=>a-b));
  reviewDirtyRef.current=!!report&&reviewSignature!==savedReview;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);

  const options=useMemo<Options|null>(()=>{
    if(!a||!b||[pageA,pageB,dx,dy].some(v=>v.trim()===''))return null;
    const pa=Number(pageA),pb=Number(pageB),x=Number(dx),y=Number(dy);
    if(!Number.isInteger(pa)||!Number.isInteger(pb)||pa<1||pb<1||pa>a.pages.length||pb>b.pages.length||![x,y].every(Number.isFinite)||Math.abs(x)>100||Math.abs(y)>100)return null;
    return {pageA:pa-1,pageB:pb-1,dpi,threshold,offsetXmm:x,offsetYmm:y,ignored};
  },[a,b,pageA,pageB,dx,dy,dpi,threshold,ignored]);
  const optionsRef=useRef(options);optionsRef.current=options;
  const fingerprint=options?optionsKey(options):'';
  const stale=!!report&&optionsKey(report.options)!==fingerprint;
  const renderKey=options?JSON.stringify([revision,options.pageA,options.pageB,options.offsetXmm,options.offsetYmm]):'';
  const selectedRegion=report?.regions.find(r=>r.id===selected);
  const aspect=preview?preview.heightPt/preview.widthPt:1.414;
  const canvasWidth=Math.max(200,paneWidth-40)*zoom,canvasHeight=canvasWidth*aspect;

  const checkGuard=useCallback(async()=>{try{const state=await comparePoll();if(mounted.current)setGuard(state.guardReady);return state.guardReady}catch(e){if(mounted.current)setError(message(e));return false}},[]);
  useEffect(()=>{let stopped=false;let timer=0;let tries=0;const check=async()=>{if(await checkGuard()||stopped)return;if(++tries<20)timer=window.setTimeout(check,250);else setError(tr('外部请求阻断未就绪，暂不读取图纸。请关闭本窗口后重新打开。','External request blocking is not ready. Close and reopen this workspace before loading drawings.'))};void check();return()=>{stopped=true;clearTimeout(timer)}},[checkGuard,tr]);
  useEffect(()=>{if(mode!=='blink'||blinkPaused)return;const timer=window.setInterval(()=>setBlink(v=>!v),600);return()=>clearInterval(timer)},[mode,blinkPaused]);
  useEffect(()=>{const pane=paneRef.current;if(!pane)return;const measure=()=>setPaneWidth(pane.clientWidth/(mode==='split'?2:1));measure();const observer=new ResizeObserver(measure);observer.observe(pane);return()=>observer.disconnect()},[mode]);
  const viewportList=()=>mode==='split'?[viewportA.current,viewportB.current]:[viewportMix.current];
  const syncScroll=(from:HTMLDivElement)=>{if(mode!=='split')return;for(const to of [viewportA.current,viewportB.current])if(to&&to!==from){if(Math.abs(to.scrollLeft-from.scrollLeft)>1)to.scrollLeft=from.scrollLeft;if(Math.abs(to.scrollTop-from.scrollTop)>1)to.scrollTop=from.scrollTop}};
  const zoomLatest=useRef({zoom,canvasWidth,canvasHeight});zoomLatest.current={zoom,canvasWidth,canvasHeight};
  useEffect(()=>{
    const elements=mode==='split'?[viewportA.current,viewportB.current]:[viewportMix.current];
    const wheel=(event:WheelEvent)=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();if(!event.deltaY)return;const surface=event.currentTarget as HTMLDivElement;const box=surface.getBoundingClientRect(),s=zoomLatest.current;
      anchor.current={x:(surface.scrollLeft+event.clientX-box.left-20)/s.canvasWidth,y:(surface.scrollTop+event.clientY-box.top-20)/s.canvasHeight,screenX:event.clientX-box.left,screenY:event.clientY-box.top};setZoom(clamp(s.zoom*Math.exp(-clamp(event.deltaY,-200,200)*.002),.25,8));};
    for(const element of elements)element?.addEventListener('wheel',wheel,{passive:false});return()=>{for(const element of elements)element?.removeEventListener('wheel',wheel)};
  },[mode,!!preview]);
  useLayoutEffect(()=>{const value=anchor.current;if(!value)return;for(const surface of viewportList())if(surface){surface.scrollLeft=value.x*canvasWidth+20-value.screenX;surface.scrollTop=value.y*canvasHeight+20-value.screenY}anchor.current=null},[zoom,canvasWidth,canvasHeight,mode]);
  const changeZoom=(value:number)=>{const surface=viewportList()[0];if(surface)anchor.current={x:(surface.scrollLeft+surface.clientWidth/2-20)/canvasWidth,y:(surface.scrollTop+surface.clientHeight/2-20)/canvasHeight,screenX:surface.clientWidth/2,screenY:surface.clientHeight/2};setZoom(clamp(value,.25,8))};

  const previewWidth=Math.min(4096,Math.max(512,Math.ceil(canvasWidth*(window.devicePixelRatio||1)*1.5/512)*512));
  useEffect(()=>{
    if(!renderKey||working){setPreviewLoading(false);return}const input=optionsRef.current;if(!input)return;let dead=false;const key=`${renderKey}:${previewWidth}`;
    const cached=previewCache.current.get(key);if(cached){setPreview(cached);setPreviewLoading(false);return}
    setPreviewLoading(true);const timer=window.setTimeout(()=>{void compareCall<Preview>('preview',{options:input,width:previewWidth}).then(async value=>{
      if(!value.a?.dataUrl?.startsWith('data:image/png;base64,')||value.a.width!==value.b.width||value.a.height!==value.b.height)throw Error('COMPARE_PREVIEW_INVALID');
      await Promise.all([value.a,value.b].map(p=>{const image=new Image();image.src=p.dataUrl;return image.decode()}));
      if(dead)return;previewCache.current.set(key,value);while(previewCache.current.size>4)previewCache.current.delete(previewCache.current.keys().next().value!);setPreview(value);
    }).catch(e=>{if(!dead)setError(message(e))}).finally(()=>{if(!dead)setPreviewLoading(false)})},140);
    return()=>{dead=true;clearTimeout(timer)};
  },[renderKey,previewWidth,working]);

  useEffect(()=>{if(!running)return;let dead=false,timer=0;const poll=async()=>{try{const state=await comparePoll();if(dead)return;if(state.progress.jobId===job.jobId||state.progress.error?.includes('COMPARE_RESET')){
      const value=state.progress;if(value.status==='complete'){const result=validateReport(value.report!,job.jobId);setReport(result);setSelected(result.regions[0]?.id??0);setReviewed(new Set());setSavedReview('[]');setNote(tr('完整分析已完成。请结合原图人工复核。','Full analysis complete. Review the findings against the original drawings.'));}
      if(value.status==='failed'){setError(value.error||tr('对比失败，未生成完整结论。','Comparison failed; no complete conclusion.'));if(value.error?.includes('COMPARE_RESET')){setA(null);setB(null);setPreview(null);setReport(null);previewCache.current.clear();detailCache.current.clear();}}
      setJob(value);if(value.status!=='running')return;
    }}catch(e){if(!dead){setError(message(e));setJob(v=>({...v,status:'failed'}))}return}if(!dead)timer=window.setTimeout(poll,250)};void poll();return()=>{dead=true;clearTimeout(timer)};
  },[running,job.jobId,tr]);

  useEffect(()=>{setDetail(null);if(!selectedRegion||!report||stale||working)return;const key=report.jobId+':'+selectedRegion.id;const cached=detailCache.current.get(key);if(cached){setDetail(cached);setDetailLoading(false);return}let dead=false;setDetailLoading(true);
    void compareCall<Preview>('preview',{options:report.options,width:640,rect:detailBounds(selectedRegion,report)}).then(value=>{if(!dead){detailCache.current.set(key,value);while(detailCache.current.size>5)detailCache.current.delete(detailCache.current.keys().next().value!);setDetail(value)}}).catch(e=>{if(!dead)setError(message(e))}).finally(()=>{if(!dead)setDetailLoading(false)});return()=>{dead=true};
  },[selected,report?.jobId,stale,working]);

  const clearResult=()=>{setReport(null);setSelected(0);setDetail(null);setJob(emptyJob);setReviewed(new Set());setSavedReview('[]');detailCache.current.clear()};
  useEffect(()=>{const invalidated=()=>{setA(null);setB(null);setPreview(null);clearResult();previewCache.current.clear();setError(tr('对比进程已停止，请重新选择图纸。主 PDF 工作区未受影响。','Comparison process stopped. Reselect drawings; the main PDF workspace is unaffected.'))};window.addEventListener(compareResetEvent,invalidated);return()=>window.removeEventListener(compareResetEvent,invalidated)},[tr]);
  const loadSource=async(side:'a'|'b',path:string,passwordText?:string)=>{
    busyRef.current=true;setBusy(tr('正在只读打开 PDF…','Opening PDF read-only…'));setError('');
    try{const source=await compareCall<Source>('open',{side,path,...(passwordText===undefined?{}:{password:passwordText})});if(!source.pages?.length)throw Error('COMPARE_SOURCE_INVALID');if(side==='a'){setA(source);setPageA('1')}else{setB(source);setPageB('1')}setPassword(null);setPasswordValue('');clearResult();setPreview(null);previewCache.current.clear();setRevision(v=>v+1);setIgnored([]);setDx('0');setDy('0');setZoom(1);setAlignPoint(null)}catch(e){const text=message(e);if(text.includes('PASSWORD_REQUIRED')){setPassword({side,path});setPasswordValue('');setError(passwordText===undefined?'':tr('密码不正确，请重试。','Incorrect password. Try again.'))}else setError(text)}finally{busyRef.current=false;setBusy('')}
  };
  const chooseSource=async(side:'a'|'b',confirmed=false)=>{if(busyRef.current||jobRef.current.status==='running'||!guard)return;if(reviewDirtyRef.current&&!confirmed){setConfirmation(side==='a'?'source-a':'source-b');return}busyRef.current=true;setBusy(tr('选择本地 PDF…','Choosing local PDF…'));try{const path=await open({directory:false,multiple:false,filters:[{name:'PDF',extensions:['pdf']}],title:tr(side==='a'?'选择旧版图纸 A':'选择新版图纸 B',side==='a'?'Choose old drawing A':'Choose new drawing B')});if(typeof path==='string')await loadSource(side,path)}catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}};
  const doStart=async()=>{const input=optionsRef.current;if(!input||busyRef.current||jobRef.current.status==='running')return;busyRef.current=true;setBusy(tr('正在启动完整分析…','Starting full analysis…'));setError('');setNote('');
    const id=crypto.randomUUID();try{await compareCall('start',{jobId:id,options:input});clearResult();setJob({...emptyJob,jobId:id,status:'running'});setTool('pan');setAlignPoint(null)}catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}};
  const stop=async()=>{if(busyRef.current||jobRef.current.status!=='running')return;busyRef.current=true;setBusy(tr('正在停止对比…','Stopping comparison…'));try{await compareCall('cancel',{jobId:jobRef.current.jobId});const until=Date.now()+2000;while(jobRef.current.status==='running'&&Date.now()<until){await new Promise(done=>setTimeout(done,100));const value=await comparePoll();if(value.progress.jobId===jobRef.current.jobId&&value.progress.status!=='running'){if(value.progress.status==='complete'&&value.progress.report){const done=validateReport(value.progress.report,jobRef.current.jobId);setReport(done);setSelected(done.regions[0]?.id??0)}setJob(value.progress);jobRef.current=value.progress;break}}if(jobRef.current.status==='running'){await compareReset();setA(null);setB(null);setPreview(null);clearResult();setNote(tr('已结束对比进程，请重新选择图纸；主工作区不受影响。','Comparison process stopped. Reselect drawings; the main workspace is unaffected.'))}}catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}};
  const reset=async()=>{busyRef.current=true;setBusy(tr('正在释放对比数据…','Releasing comparison data…'));try{await compareReset();setA(null);setB(null);setPreview(null);clearResult();previewCache.current.clear();detailCache.current.clear();setIgnored([]);setDx('0');setDy('0');setNote('');setError('')}catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}};
  const exportReport=async(kind:'png'|'csv')=>{if(!report||stale||working||busyRef.current)return;busyRef.current=true;setBusy(tr('正在本地导出…','Exporting locally…'));setError('');try{const path=await save({title:tr('导出到单位认可的本地目录','Export to an approved local folder'),defaultPath:`Jerrivell-comparison.${kind}`,filters:[{name:kind.toUpperCase(),extensions:[kind]}]});if(!path)return;await compareCall('export',{jobId:report.jobId,path,kind,reviewed:[...reviewed]});if(kind==='csv')setSavedReview(reviewSignature);setNote(tr('报告已写入你选择的文件；原图未改动。','Report written to the chosen file. Original drawings are unchanged.'))}catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}};
  const closeRef=useRef(()=>{});closeRef.current=()=>{if(busyRef.current||jobRef.current.status==='running'||reviewDirtyRef.current)setConfirmation('close');else void compareClose().catch(e=>setError(message(e)))};
  useEffect(()=>{let disposed=false,unlisten:(()=>void)|undefined;void getCurrentWebviewWindow().onCloseRequested(event=>{event.preventDefault();closeRef.current()}).then(off=>{if(disposed)off();else unlisten=off}).catch(()=>{});return()=>{disposed=true;unlisten?.()}},[]);

  const focusRegion=(region:Region)=>{setSelected(region.id);if(zoom<1.7)setZoom(1.7);requestAnimationFrame(()=>{const width=Math.max(200,paneWidth-40)*Math.max(zoom,1.7),height=width*aspect;for(const surface of viewportList())if(surface){surface.scrollLeft=(region.bounds.x+region.bounds.width/2)*width+20-surface.clientWidth/2;surface.scrollTop=(region.bounds.y+region.bounds.height/2)*height+20-surface.clientHeight/2}})};
  const changePages=(side:'a'|'b',value:string)=>{side==='a'?setPageA(value):setPageB(value);setIgnored([]);setAlignPoint(null)};
  const eventPoint=(event:ReactPointerEvent<SVGSVGElement>)=>{const rect=event.currentTarget.getBoundingClientRect();return {x:clamp((event.clientX-rect.left)/rect.width,0,1),y:clamp((event.clientY-rect.top)/rect.height,0,1)}};
  const pointerDown=(event:ReactPointerEvent<SVGSVGElement>,side:'a'|'b'|'mix')=>{if(event.button!==0)return;
    if(tool==='pan'){if((event.target as Element).closest('.compare-region'))return;const surface=event.currentTarget.closest('.compare-viewport') as HTMLDivElement|null;if(surface){event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);panGesture.current={surface,x:event.clientX,y:event.clientY,left:surface.scrollLeft,top:surface.scrollTop}}return}
    if(working)return;
    if(tool==='align'&&mode==='split'){const p=eventPoint(event);if(side==='a'){setAlignPoint([p.x,p.y]);setNote(tr('再点击 B 中同一个基准点。','Now click the same reference point in B.'))}else if(side==='b'&&alignPoint&&preview){setDx(String(Number((Number(dx)+(alignPoint[0]-p.x)*preview.widthPt*25.4/72).toFixed(3))));setDy(String(Number((Number(dy)+(alignPoint[1]-p.y)*preview.heightPt*25.4/72).toFixed(3))));setIgnored([]);setAlignPoint(null);setTool('pan');setNote(tr('已按基准点更新 B 的整体平移，请重新分析。','B translation updated from reference points. Run the comparison again.'))}return;}
    if(tool!=='ignore')return;if(ignored.length>=16){setError(tr('最多 16 个忽略区域。','Up to 16 ignored areas.'));return}event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);const p=eventPoint(event);pointerStart.current=p;setDraft({x:p.x,y:p.y,width:0,height:0});
  };
  const pointerMove=(event:ReactPointerEvent<SVGSVGElement>)=>{const pan=panGesture.current;if(pan){pan.surface.scrollLeft=pan.left+pan.x-event.clientX;pan.surface.scrollTop=pan.top+pan.y-event.clientY;syncScroll(pan.surface);return}const p=pointerStart.current;if(!p)return;const q=eventPoint(event);setDraft({x:Math.min(p.x,q.x),y:Math.min(p.y,q.y),width:Math.abs(p.x-q.x),height:Math.abs(p.y-q.y)})};
  const pointerUp=(event:ReactPointerEvent<SVGSVGElement>)=>{panGesture.current=null;if(!pointerStart.current)return;const p=eventPoint(event),start=pointerStart.current;pointerStart.current=null;setDraft(null);if(Math.abs(p.x-start.x)*canvasWidth<3||Math.abs(p.y-start.y)*canvasHeight<3)return;setIgnored(v=>[...v,{x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),width:Math.abs(p.x-start.x),height:Math.abs(p.y-start.y)}])};
  const visibleRegions=report?.regions.filter(r=>filter==='all'||filter==='reviewed'&&reviewed.has(r.id)||filter==='pending'&&!reviewed.has(r.id)||filter==='tiny'&&r.pixels<=25)||[];
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){setDraft(null);pointerStart.current=null;setAlignPoint(null);setTool('pan')}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='o'){event.preventDefault();void chooseSource(a?'b':'a')}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='w'){event.preventDefault();closeRef.current()}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[a,guard,tr]);

  const layer=(side:'a'|'b'|'mix')=>{
    if(!preview)return null;const mixed=side==='mix';const bOpacity=mode==='curtain'?1:mode==='blink'?(blink?1:0):alpha;
    return <div className="compare-sheet" style={{width:canvasWidth,height:canvasHeight}}>
      <img className="compare-paper-image" src={side==='b'?preview.b.dataUrl:preview.a.dataUrl} alt={tr(side==='b'?'新版 B 页面':'旧版 A 页面',side==='b'?'New page B':'Old page A')} draggable={false}/>
      {mixed&&<img className="compare-paper-image compare-b-image" src={preview.b.dataUrl} alt={tr('新版 B 叠加','New page B overlay')} draggable={false} style={{opacity:bOpacity,clipPath:mode==='curtain'?`inset(0 ${(1-alpha)*100}% 0 0)`:undefined}}/>}
      {showDiff&&report&&!stale&&<img className="compare-mask" src={report.mask.dataUrl} alt={tr('差异精确高亮','Exact difference highlights')} draggable={false}/>}
      <svg className={`compare-hit-layer tool-${tool}`} viewBox="0 0 1000 1000" preserveAspectRatio="none" onPointerDown={event=>pointerDown(event,side)} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={()=>{pointerStart.current=null;panGesture.current=null;setDraft(null)}}>
        {!stale&&showDiff&&report?.regions.map(region=><g key={region.id} role="button" tabIndex={tool==='pan'?0:-1} aria-label={tr(`定位差异 ${region.id}`,`Locate difference ${region.id}`)} className={`compare-region ${region.id===selected?'selected':''}`} onClick={()=>{if(tool==='pan')focusRegion(region)}} onKeyDown={event=>{if(event.key==='Enter')focusRegion(region)}}>
          <rect x={region.bounds.x*1000-2} y={region.bounds.y*1000-2} width={Math.max(region.bounds.width*1000+4,8)} height={Math.max(region.bounds.height*1000+4,8)}/>
          <circle cx={region.point[0]*1000} cy={region.point[1]*1000} r={Math.max(2.5,4000/canvasWidth)}/>
        </g>)}
        {ignored.map((r,i)=><rect key={i} className="compare-ignored" x={r.x*1000} y={r.y*1000} width={r.width*1000} height={r.height*1000}/>)}
        {draft&&<rect className="compare-draft" x={draft.x*1000} y={draft.y*1000} width={draft.width*1000} height={draft.height*1000}/>}
        {tool==='align'&&side==='a'&&alignPoint&&<circle className="compare-anchor" cx={alignPoint[0]*1000} cy={alignPoint[1]*1000} r="5"/>}
      </svg>
    </div>;
  };
  const sourceCard=(side:'a'|'b',source:Source|null,page:string)=><div className="compare-source-card"><span className={`compare-side side-${side}`}>{side.toUpperCase()}</span><div className="compare-source-title"><strong title={source?.fileName}>{source?.fileName||tr(side==='a'?'旧版图纸':'新版图纸',side==='a'?'Old drawing':'New drawing')}</strong><small>{source?tr(`${source.pages.length} 页 · ${(source.fileSize/1024).toFixed(0)} KB`,`${source.pages.length} pages · ${(source.fileSize/1024).toFixed(0)} KB`):tr('只读载入本地 PDF','Read-only local PDF')}</small></div><button className="button secondary" onClick={()=>void chooseSource(side)} disabled={working||!guard} aria-label={tr(`选择 ${side.toUpperCase()}`,`Choose ${side.toUpperCase()}`)}><FolderOpen size={15}/>{source?tr('更换','Change'):tr('选择 PDF','Choose PDF')}</button>{source&&<label className="compare-page-input">{tr('页','Page')}<input inputMode="numeric" aria-label={tr(`${side.toUpperCase()} 页码`,`${side.toUpperCase()} page`)} value={page} onChange={e=>changePages(side,e.target.value)} disabled={working}/><span>/ {source.pages.length}</span></label>}</div>;

  return <div className="compare-app">
    <header className="compare-header"><div className="compare-brand"><img src={icon} alt=""/><div><strong>Jerrivell <span>{tr('图纸对比','Drawing Compare')}</span></strong><small>{tr('独立工作区 · 原图只读 · 本地处理','Independent workspace · Read-only originals · Local processing')}</small></div></div><div className={`compare-policy ${guard?'ready':''}`} title={tr('应用界面阻断外部资源；不是整机隔离认证。','External resources blocked in this workspace; this is not system isolation certification.')}><ShieldCheck size={16}/>{guard?tr('外部资源已阻断','External resources blocked'):tr('正在检查离线策略…','Checking offline policy…')}</div><select aria-label={tr('界面语言','Interface language')} className="language-select" value={language} onChange={e=>setLanguage(e.target.value)}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select><button className="icon-button" aria-label={tr('关闭对比工作区','Close comparison workspace')} onClick={()=>closeRef.current()}><X size={19}/></button></header>
    <section className="compare-sources" aria-label={tr('对比来源','Comparison sources')}>{sourceCard('a',a,pageA)}<ArrowLeftRight size={19}/>{sourceCard('b',b,pageB)}</section>
    <section className="compare-options" aria-label={tr('对比参数','Comparison settings')}>
      <label>{tr('分析 DPI','Analysis DPI')}<select value={dpi} onChange={e=>setDpi(Number(e.target.value))} disabled={working}><option value="150">150</option><option value="300">300</option><option value="600">600</option></select></label>
      <label>{tr('灰度/颜色容差','Pixel tolerance')}<select value={threshold} onChange={e=>setThreshold(Number(e.target.value))} disabled={working}><option value="0">{tr('严格 · 0','Strict · 0')}</option><option value="16">16 / 255</option><option value="32">32 / 255</option></select></label>
      <label>{tr('B 水平 mm','B horizontal mm')}<input aria-label={tr('B 水平偏移','B horizontal offset')} inputMode="decimal" value={dx} disabled={working} onChange={e=>{setDx(e.target.value);setIgnored([])}}/></label>
      <label>{tr('B 垂直 mm','B vertical mm')}<input aria-label={tr('B 垂直偏移','B vertical offset')} inputMode="decimal" value={dy} disabled={working} onChange={e=>{setDy(e.target.value);setIgnored([])}}/></label>
      <button className={`button secondary ${tool==='align'?'active':''}`} disabled={!preview||working||mode!=='split'} onClick={()=>{setTool(tool==='align'?'pan':'align');setAlignPoint(null);setNote(tr('先在 A 点击稳定基准点，再在 B 点击对应点；仅平移，不缩放。','Click a stable reference in A, then its match in B. Translation only, no scaling.'))}}><ScanLine size={15}/>{tr('两点平移对齐','Point alignment')}</button>
      {running?<button className="button compare-stop" disabled={!!busy} onClick={()=>void stop()}><X size={15}/>{tr('停止计算','Stop')}</button>:<button className="button primary compare-start" disabled={!options||working||!guard} onClick={()=>reviewDirtyRef.current?setConfirmation('run'):void doStart()}><Layers3 size={16}/>{report?tr('重新分析','Run again'):tr('开始对比','Compare drawings')}</button>}
      <button className="icon-button" disabled={working||(!a&&!b)} onClick={()=>reviewDirtyRef.current?setConfirmation('reset'):void reset()} title={tr('清空并释放本工作区','Clear and release this workspace')} aria-label={tr('清空对比','Clear comparison')}><Trash2 size={16}/></button>
    </section>
    {a&&b&&!options&&<div className="compare-caution" role="status">{tr('请输入有效页码；水平与垂直偏移需在 −100～100 mm 内。输入完成后即可继续预览与分析。','Enter valid page numbers and offsets between −100 and 100 mm to continue previewing and analyzing.')}</div>}
    {error&&<div className="compare-message error" role="alert"><span>{error==='COMPARE_RESPONSE_INVALID'?tr('对比响应校验失败，未生成完整结论。','Invalid comparison response; no complete conclusion.'):error}</span><button aria-label={tr('关闭错误','Dismiss error')} onClick={()=>setError('')}><X size={15}/></button></div>}
    <div className="compare-workspace">
      <main className="compare-main">
        <div className="compare-view-tools"><div className="compare-segment">{([['split',tr('并排','Side by side')],['overlay',tr('叠加','Overlay')],['curtain',tr('拉幕','Curtain')],['blink',tr('闪烁','Blink')]]as const).map(([key,label])=><button key={key} aria-pressed={mode===key} className={mode===key?'active':''} onClick={()=>{setMode(key);setTool('pan');setAlignPoint(null)}}>{label}</button>)}</div>
          {mode!=='split'&&<label className="compare-opacity">{mode==='curtain'?tr('位置','Position'):tr('B 显示','B opacity')}<input type="range" min="0" max="1" step=".01" aria-label={tr('B 显示比例','B display proportion')} value={alpha} onChange={e=>setAlpha(Number(e.target.value))}/></label>}
          {mode==='blink'&&<button className="text-button" onClick={()=>setBlinkPaused(v=>!v)}>{blinkPaused?tr('继续闪烁','Resume'):tr('暂停闪烁','Pause')}</button>}
          <div className="compare-tool-toggles"><button aria-label={tr('查看工具','Inspect tool')} aria-pressed={tool==='pan'} onClick={()=>setTool('pan')}><MousePointer2 size={15}/></button><button aria-label={tr('框选忽略区域','Draw ignored area')} aria-pressed={tool==='ignore'} disabled={!preview||working} onClick={()=>setTool(tool==='ignore'?'pan':'ignore')}><SquareDashed size={15}/></button>{ignored.length>0&&<button disabled={working} onClick={()=>setIgnored([])}>{tr(`清除忽略 ${ignored.length}`,`Clear ${ignored.length} exclusions`)}</button>}</div>
          <label className="compare-highlight-toggle"><input type="checkbox" checked={showDiff} onChange={e=>setShowDiff(e.target.checked)}/>{tr('差异高亮','Highlights')}</label>
        </div>
        {(stale||preview?.uncovered||ignored.length>0)&&<div className="compare-caution">{stale?tr('参数已变化，当前为旧结果；重新分析后才能导出。','Settings changed. These are old findings; run again before exporting.'):preview?.uncovered?tr('图幅或有效覆盖范围不同。非重叠区需要人工检查。','Page sizes or coverage differ. Review non-overlapping areas.'):tr('已设置忽略区域，结论不包含这些区域。','Ignored areas are excluded from the conclusion.')}</div>}
        <div className={`compare-panes ${mode==='split'?'split':'mixed'}`} ref={paneRef}>
          {!preview?<div className="compare-empty"><Layers3 size={42}/><h2>{tr('让图纸变化一目了然','See drawing changes clearly')}</h2><p>{a&&b?tr('正在准备同步预览…','Preparing synchronized previews…'):tr('选择旧版 A 与新版 B。每份 PDF 可独立选择页码。','Choose old PDF A and new PDF B, then select their pages.')}</p><span>{tr('支持矢量、轮廓化文字与扫描页的视觉对比。','Visual comparison supports vectors, outlined text and scanned pages.')}</span></div>:mode==='split'?<>
            <section className="compare-pane"><div className="compare-pane-label"><span className="compare-side side-a">A</span>{a?.fileName}<small>{tr('旧版','Old')}</small></div><div ref={viewportA} className="compare-viewport" onScroll={e=>syncScroll(e.currentTarget)}>{layer('a')}</div></section>
            <section className="compare-pane"><div className="compare-pane-label"><span className="compare-side side-b">B</span>{b?.fileName}<small>{tr('新版','New')}</small></div><div ref={viewportB} className="compare-viewport" onScroll={e=>syncScroll(e.currentTarget)}>{layer('b')}</div></section>
          </>:<section className="compare-pane"><div className="compare-pane-label"><span className="compare-side side-a">A</span><ArrowLeftRight size={13}/><span className="compare-side side-b">B</span>{tr('同步叠加工作区','Synchronized overlay workspace')}</div><div ref={viewportMix} className="compare-viewport">{layer('mix')}</div></section>}
          {previewLoading&&<div className="compare-preview-loading"><LoaderCircle className="spin" size={14}/>{tr('更新清晰预览…','Updating preview…')}</div>}
        </div>
        <div className="compare-view-footer"><span>{note||tr('绿：新增 · 紫红：删除 · 橙：颜色变化 · 小点不会按面积剔除','Green: added · Magenta: removed · Orange: color change · Small points retained')}</span><button aria-label={tr('缩小对比视图','Zoom out comparison')} onClick={()=>changeZoom(zoom/1.2)}><Minus size={15}/></button><span className="compare-zoom">{Math.round(zoom*100)}%</span><button aria-label={tr('放大对比视图','Zoom in comparison')} onClick={()=>changeZoom(zoom*1.2)}><Plus size={15}/></button><button onClick={()=>{setZoom(1);for(const v of viewportList())if(v){v.scrollLeft=0;v.scrollTop=0}}}><Maximize2 size={14}/>{tr('适宽','Fit')}</button></div>
      </main>
      <aside className="compare-results" aria-label={tr('差异与复核','Differences and review')}>
        <div className="compare-result-heading"><h2>{tr('差异与复核','Differences & review')}</h2><span>{report?.regions.length??'—'}</span></div>
        {running?<div className="compare-progress" role="status"><LoaderCircle size={21} className="spin"/><strong>{tr('正在完整分析','Analyzing the full pages')}</strong><progress max={job.total||1} value={job.completed}/><span>{job.completed} / {job.total||'—'} {tr('瓦片','tiles')}</span><small>{tr('尚未完成，不能据此判定图纸相同。','Incomplete analysis cannot establish that drawings match.')}</small></div>:report?<div className={`compare-summary ${stale?'stale':''}`}><strong>{report.changedPixels?tr(`${report.regions.length} 个差异区域`,`${report.regions.length} difference regions`):tr('当前参数下未发现像素差异','No pixel differences under these settings')}</strong><span>{report.changedPixels.toLocaleString()} {tr('变化像素','changed pixels')} · {report.options.dpi} DPI</span>{(report.uncovered||report.ignoredPixels>0)&&<small>{tr('结论有限定：有非重叠区或忽略区，请人工核对。','Qualified result: non-overlapping or excluded areas require review.')}</small>}</div>:<div className="compare-result-empty"><FileText size={25}/><p>{job.status==='cancelled'?tr('分析已取消，没有完整结论。','Analysis cancelled; no complete conclusion.'):job.status==='failed'?tr('分析未完成，请检查错误后重试。','Analysis incomplete. Review the error and retry.'):tr('预览就绪后，点击“开始对比”。','When previews are ready, choose Compare drawings.')}</p></div>}
        {report&&<><div className="compare-list-controls"><select aria-label={tr('差异筛选','Filter differences')} value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">{tr('全部变化','All changes')}</option><option value="tiny">{tr('细小变化 ≤25 像素','Tiny changes ≤25 pixels')}</option><option value="pending">{tr('待复核','Pending review')}</option><option value="reviewed">{tr('已复核','Reviewed')}</option></select><button disabled={!report.regions.length||stale} aria-label={tr('上一处差异','Previous difference')} onClick={()=>{const list=report.regions;focusRegion(list[(list.findIndex(r=>r.id===selected)-1+list.length)%list.length])}}><ChevronLeft size={16}/></button><button disabled={!report.regions.length||stale} aria-label={tr('下一处差异','Next difference')} onClick={()=>{const list=report.regions;focusRegion(list[(list.findIndex(r=>r.id===selected)+1)%list.length])}}><ChevronRight size={16}/></button></div>
        <div className="compare-region-list">{visibleRegions.map(r=><button key={r.id} className={`compare-region-row ${r.id===selected?'active':''}`} disabled={stale||working} onClick={()=>focusRegion(r)}><span className="compare-region-id">{r.id}</span><span><strong>{r.pixels<=25?tr('细小变化','Tiny change'):tr('变化区域','Changed region')}</strong><small>{r.pixels.toLocaleString()} px · +{r.added} / −{r.removed}{r.changed?` / ~${r.changed}`:''}</small></span>{reviewed.has(r.id)&&<Check size={15}/>}</button>)}</div>
        {selectedRegion&&!stale&&<div className="compare-detail"><div className="compare-detail-title"><strong>{tr(`差异 ${selectedRegion.id} · 局部查看`,`Difference ${selectedRegion.id} · Detail`)}</strong>{detailLoading&&<LoaderCircle size={14} className="spin"/>}</div><div className="compare-detail-images"><figure><figcaption>A</figcaption>{detail&&<img src={detail.a.dataUrl} alt={tr('旧版局部放大','Old drawing detail')}/>}</figure><figure><figcaption>B</figcaption>{detail&&<img src={detail.b.dataUrl} alt={tr('新版局部放大','New drawing detail')}/>}</figure></div><small>{tr('局部高清查看不改变已完成分析的差异数量。','Detail previews do not change the completed analysis counts.')}</small><label><input type="checkbox" checked={reviewed.has(selectedRegion.id)} onChange={e=>setReviewed(previous=>{const next=new Set(previous);e.target.checked?next.add(selectedRegion.id):next.delete(selectedRegion.id);return next})}/>{tr('已人工复核','Manually reviewed')}</label></div>}</>}
        <div className="compare-export"><button className="button secondary" disabled={!report||stale||working} onClick={()=>void exportReport('png')}><Download size={15}/>{tr('标记概览 PNG','Marked PNG')}</button><button className="button primary" disabled={!report||stale||working} onClick={()=>void exportReport('csv')}><Download size={15}/>{tr('差异清单 CSV','Difference CSV')}</button></div>
      </aside>
    </div>
    <footer className="compare-status"><span><ShieldCheck size={12}/>{tr('原图只读 · 不上传 · 不修改主工作区','Read-only originals · No uploads · Main workspace unchanged')}</span><span>{busy||tr('Ctrl+滚轮缩放 · 两侧同步滚动','Ctrl+wheel zoom · Synchronized scrolling')}</span></footer>
    {password&&<div className="modal-backdrop"><form className="modal compare-password" role="dialog" aria-modal="true" aria-labelledby="compare-password-title" onSubmit={e=>{e.preventDefault();void loadSource(password.side,password.path,passwordValue)}}><h2 id="compare-password-title">{tr('输入 PDF 打开密码','Enter the PDF opening password')}</h2><p>{tr('密码仅用于本次打开，不记录到日志或配置。','The password is used only for this open operation, without logs or saved settings.')}</p><input className="text-input" type="password" autoFocus autoComplete="off" aria-label={tr('PDF 密码','PDF password')} value={passwordValue} onChange={e=>setPasswordValue(e.target.value)} disabled={!!busy}/><div className="modal-actions"><button className="button secondary" type="button" disabled={!!busy} onClick={()=>{setPassword(null);setPasswordValue('')}}>{tr('取消','Cancel')}</button><button className="button primary" disabled={!!busy} type="submit">{tr('打开','Open')}</button></div></form></div>}
    {confirmation&&<div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="compare-confirm-title"><h2 id="compare-confirm-title">{tr('保留本次复核记录？','Keep this review?')}</h2><p>{running?tr('关闭会停止当前对比。原始 PDF 和主工作区保持原样。','Closing stops this analysis. Original PDFs and the main workspace stay unchanged.'):tr('该操作会清除本次复核状态。需要保留时，请先导出差异清单 CSV。','This clears the current review state. Export the difference CSV first if you need to keep it.')}</p><div className="modal-actions"><button className="button secondary" onClick={()=>setConfirmation(null)}>{tr('返回工作区','Keep working')}</button><button className="button primary" onClick={()=>{const action=confirmation;setConfirmation(null);if(action==='close')void compareClose().catch(e=>setError(message(e)));else if(action==='reset')void reset();else if(action==='source-a'||action==='source-b')void chooseSource(action==='source-a'?'a':'b',true);else void doStart()}}>{confirmation==='close'?tr('关闭对比','Close comparison'):tr('继续','Continue')}</button></div></div></div>}
  </div>;
}
