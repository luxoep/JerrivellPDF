// SPDX-License-Identifier: MIT OR Apache-2.0
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {PointerEvent as ReactPointerEvent} from 'react';
import {open,save} from '@tauri-apps/plugin-dialog';
import {getCurrentWebviewWindow} from '@tauri-apps/api/webviewWindow';
import {ArrowLeftRight,Check,ChevronLeft,ChevronRight,Download,FileText,FolderOpen,Layers3,LoaderCircle,Maximize2,Minus,MousePointer2,Plus,Save,ScanLine,ShieldCheck,SquareDashed,Trash2,X} from 'lucide-react';
import icon from '../brand/jerrivell-icon.svg';
import {DetailDock} from './DetailDock';
import {BatchDialog} from './BatchDialog';
import {ProjectDialog} from './ProjectDialog';
import type {ProjectPrompt} from './ProjectDialog';
import {captureReview,checkpointReviewKey,maxReviewNoteBytes,nextPendingRegion,projectExtension,restoreProjectReview,reviewKey,validateOpenedProject} from './project';
import type {OpenedProject,OpenProjectRequest,ReviewCheckpoint,SaveProjectRequest} from './project';
import {comparisonFrame,sheetGeometry,pointInFrame,cachePreview,pairOptions} from './geometry';
import {useSourcePreview,decodePictures} from './useSourcePreview';
import type {PagePair} from './pairs';
import {compareCall,compareClose,comparePoll,compareReset,compareResetEvent,message} from './client';
import {detailBounds,optionsKey,validateReport,validateAlignment,validateBatch,validateTextAssistance} from './types';
import type {Alignment,BatchSummary,BatchItem,TextAssistance,Options,Preview,Progress,Rect,Region,Report,Source,ScaleMode} from './types';

type Mode='split'|'overlay'|'curtain'|'blink';
type Tool='pan'|'ignore'|'align';
type Confirmation='close'|'run'|'reset'|'source-a'|'source-b'|'clear-a'|'clear-b'|'apply-align'|'batch'|'inspect-pair'|'open-project';
type ProjectCheckpoint={path:string;fileName:string;options:string;selected:number;review:string};
type PendingReview={kind:'project'|'rerun';checkpoint:ReviewCheckpoint;savedReview:string;dirty:boolean};
const emptyJob:Progress={jobId:'',status:'idle',completed:0,total:0,report:null,error:null};
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));

export default function CompareApp(){
  const [language,setLanguage]=useState(()=>new URLSearchParams(location.search).get('lang')==='en-US'?'en-US':'zh-CN');
  const tr=useCallback((zh:string,en:string)=>language==='en-US'?en:zh,[language]);
  useEffect(()=>{document.documentElement.lang=language},[language]);
  const [a,setA]=useState<Source|null>(null),[b,setB]=useState<Source|null>(null);
  const [pageA,setPageA]=useState('1'),[pageB,setPageB]=useState('1'),[dx,setDx]=useState('0'),[dy,setDy]=useState('0');
  const [dpi,setDpi]=useState(300),[threshold,setThreshold]=useState(0),[ignored,setIgnored]=useState<Rect[]>([]);
  const [scaleMode,setScaleMode]=useState<ScaleMode>('normalized');
  const [guard,setGuard]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState(''),[note,setNote]=useState('');
  const busyRef=useRef(false),[revision,setRevision]=useState(0);
  const [preview,setPreview]=useState<Preview|null>(null),[previewLoading,setPreviewLoading]=useState(false);
  const [job,setJob]=useState<Progress>(emptyJob),[report,setReport]=useState<Report|null>(null);
  const [selected,setSelected]=useState(0),[reviewed,setReviewed]=useState<Set<number>>(new Set()),[savedReview,setSavedReview]=useState('[]');
  const [reviewNotes,setReviewNotes]=useState(new Map<number,string>());
  const [projectFile,setProjectFile]=useState<ProjectCheckpoint|null>(null);
  const [projectPrompt,setProjectPrompt]=useState<ProjectPrompt|null>(null);
  const projectOpenRequest=useRef<OpenProjectRequest|null>(null),projectSaveRequest=useRef<SaveProjectRequest|null>(null);
  const restorePending=useRef<PendingReview|null>(null),resumeFocus=useRef(0);
  const [mode,setMode]=useState<Mode>('split'),[tool,setTool]=useState<Tool>('pan'),[alpha,setAlpha]=useState(.5),[showDiff,setShowDiff]=useState(true);
  const [blink,setBlink]=useState(false),[blinkPaused,setBlinkPaused]=useState(false);
  const [zoom,setZoom]=useState(1),[paneWidth,setPaneWidth]=useState(500),[paneHeight,setPaneHeight]=useState(550);
  const [unified,setUnified]=useState(true),[epochs,setEpochs]=useState({a:0,b:0}),[detailWidth,setDetailWidth]=useState(1024);
  const [proposal,setProposal]=useState<Alignment|null>(null),[batch,setBatch]=useState<BatchSummary|null>(null),[batchDialog,setBatchDialog]=useState(false),[resultTab,setResultTab]=useState<'single'|'batch'>('single');
  const [assistance,setAssistance]=useState<TextAssistance|null>(null),[assistLoading,setAssistLoading]=useState(false);
  const pendingPair=useRef<BatchItem|null>(null);const textEpoch=useRef(0);
  const task=useRef<'compare'|'align'|'batch'>('compare'),pendingBatch=useRef<{pairs:PagePair[];automatic:boolean}|null>(null);
  const viewportA=useRef<HTMLDivElement>(null),viewportB=useRef<HTMLDivElement>(null),viewportMix=useRef<HTMLDivElement>(null);
  const paneRef=useRef<HTMLDivElement>(null),anchor=useRef<{x:number;y:number;screenX:number;screenY:number}|null>(null);
  const [draft,setDraft]=useState<Rect|null>(null),pointerStart=useRef<{x:number;y:number}|null>(null);
  const panGesture=useRef<{surface:HTMLDivElement;x:number;y:number;left:number;top:number}|null>(null);
  const [alignPoint,setAlignPoint]=useState<[number,number]|null>(null);
  const [detail,setDetail]=useState<Preview|null>(null),[detailLoading,setDetailLoading]=useState(false);
  const previewCache=useRef(new Map<string,Preview>()),detailCache=useRef(new Map<string,Preview>());
  const [password,setPassword]=useState<{side:'a'|'b';path:string}|null>(null),[passwordValue,setPasswordValue]=useState('');
  const [confirmation,setConfirmation]=useState<Confirmation|null>(null);
  const mounted=useRef(true),jobRef=useRef(job),reviewDirtyRef=useRef(false),projectDirtyRef=useRef(false);
  const [filter,setFilter]=useState('all');
  jobRef.current=job;
  const running=job.status==='running',working=!!busy||running;
  const reviewSignature=useMemo(()=>reviewKey(reviewed,reviewNotes),[reviewed,reviewNotes]);
  reviewDirtyRef.current=(!!report&&reviewSignature!==savedReview)||!!restorePending.current?.dirty;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);

  const options=useMemo<Options|null>(()=>{
    if(!a||!b||[pageA,pageB,dx,dy].some(v=>v.trim()===''))return null;
    const pa=Number(pageA),pb=Number(pageB),x=Number(dx),y=Number(dy);
    if(!Number.isInteger(pa)||!Number.isInteger(pb)||pa<1||pb<1||pa>a.pages.length||pb>b.pages.length||![x,y].every(Number.isFinite)||Math.abs(x)>100||Math.abs(y)>100)return null;
    return {pageA:pa-1,pageB:pb-1,dpi,threshold,offsetXmm:x,offsetYmm:y,ignored,scaleMode};
  },[a,b,pageA,pageB,dx,dy,dpi,threshold,ignored,scaleMode]);
  const optionsRef=useRef(options);optionsRef.current=options;
  const fingerprint=options?optionsKey(options):'';
  const stale=!!report&&optionsKey(report.options)!==fingerprint;
  const changedReviewContext=stale||!!restorePending.current&&optionsKey(restorePending.current.checkpoint.options)!==fingerprint;
  const renderKey=options?JSON.stringify([revision,options.pageA,options.pageB,options.offsetXmm,options.offsetYmm,options.scaleMode]):'';
  const selectedRegion=report?.regions.find(r=>r.id===selected);
  const nextPending=report&&!stale?nextPendingRegion(report.regions,reviewed,selected):undefined;
  const persistableSelection=stale?0:selectedRegion?.id??0;
  const projectDirty=reviewDirtyRef.current||!!projectFile&&(projectFile.options!==fingerprint
    ||!restorePending.current&&(projectFile.selected!==persistableSelection||projectFile.review!==reviewSignature));
  projectDirtyRef.current=projectDirty;
  const canSaveProject=!!options&&!working&&guard&&!restorePending.current&&(!stale||reviewSignature==='[]');
  const frame=useMemo(()=>comparisonFrame(a,b,Number(pageA)-1,Number(pageB)-1,Number(dx)||0,Number(dy)||0,scaleMode),[a,b,pageA,pageB,dx,dy,scaleMode]);
  const geometry=(side:'a'|'b'|'mix',level=zoom)=>sheetGeometry(frame,side,mode==='split'&&unified,paneWidth,paneHeight,level);
  const canvasWidth=geometry('mix').width;
  const previewWidth=Math.min(4096,Math.max(512,Math.ceil(Math.max(geometry('a').width,geometry('b').width,canvasWidth)*(window.devicePixelRatio||1)*1.5/512)*512));
  const soloA=useSourcePreview('a',a,Number(pageA)-1,epochs.a,previewWidth,working||!(mode==='split'&&unified));
  const soloB=useSourcePreview('b',b,Number(pageB)-1,epochs.b,previewWidth,working||!(mode==='split'&&unified));
  const sourceViews={a:soloA.picture,b:soloB.picture};
  const viewReady=mode==='split'&&unified?!!(soloA.picture&&soloB.picture):!!preview;
  useEffect(()=>{if(soloA.error||soloB.error)setError(soloA.error||soloB.error)},[soloA.error,soloB.error]);


  const checkGuard=useCallback(async()=>{try{const state=await comparePoll();if(mounted.current)setGuard(state.guardReady);return state.guardReady}catch(e){if(mounted.current)setError(message(e));return false}},[]);
  useEffect(()=>{let stopped=false;let timer=0;let tries=0;const check=async()=>{if(await checkGuard()||stopped)return;if(++tries<20)timer=window.setTimeout(check,250);else setError(tr('外部请求阻断未就绪，暂不读取图纸。请关闭本窗口后重新打开。','External request blocking is not ready. Close and reopen this workspace before loading drawings.'))};void check();return()=>{stopped=true;clearTimeout(timer)}},[checkGuard,tr]);
  useEffect(()=>{if(mode!=='blink'||blinkPaused)return;const timer=window.setInterval(()=>setBlink(v=>!v),600);return()=>clearInterval(timer)},[mode,blinkPaused]);
  useEffect(()=>{const pane=paneRef.current;if(!pane)return;const measure=()=>{const surface=mode==='split'?viewportA.current:viewportMix.current;setPaneWidth(surface?.clientWidth??pane.clientWidth/(mode==='split'?2:1));setPaneHeight(surface?.clientHeight??pane.clientHeight-33)};measure();const observer=new ResizeObserver(measure);observer.observe(pane);return()=>observer.disconnect()},[mode]);
  const viewportList=()=>mode==='split'?[viewportA.current,viewportB.current]:[viewportMix.current];
  const sideOf=(surface:HTMLDivElement)=>(surface.dataset.compareSide||'mix')as 'a'|'b'|'mix';
  const scrollTargets=useRef(new WeakMap<HTMLDivElement,[number,number]>());
  const syncScroll=(from:HTMLDivElement)=>{if(mode!=='split')return;const expected=scrollTargets.current.get(from);if(expected){scrollTargets.current.delete(from);if(Math.abs(expected[0]-from.scrollLeft)<1&&Math.abs(expected[1]-from.scrollTop)<1)return}const g=geometry(sideOf(from));for(const to of [viewportA.current,viewportB.current])if(to&&to!==from){const t=geometry(sideOf(to));const left=(from.scrollLeft+from.clientWidth/2-20)/g.width*t.width+20-to.clientWidth/2;const top=(from.scrollTop+from.clientHeight/2-20)/g.height*t.height+20-to.clientHeight/2;if(Math.abs(to.scrollLeft-Math.max(0,left))>1)to.scrollLeft=Math.max(0,left);if(Math.abs(to.scrollTop-Math.max(0,top))>1)to.scrollTop=Math.max(0,top);scrollTargets.current.set(to,[to.scrollLeft,to.scrollTop])}};
  const zoomLatest=useRef({zoom,geometry});zoomLatest.current={zoom,geometry};
  useEffect(()=>{const elements=mode==='split'?[viewportA.current,viewportB.current]:[viewportMix.current];const wheel=(event:WheelEvent)=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();if(!event.deltaY)return;const surface=event.currentTarget as HTMLDivElement,box=surface.getBoundingClientRect(),s=zoomLatest.current,g=s.geometry(sideOf(surface));anchor.current={x:(surface.scrollLeft+event.clientX-box.left-20)/g.width,y:(surface.scrollTop+event.clientY-box.top-20)/g.height,screenX:event.clientX-box.left,screenY:event.clientY-box.top};setZoom(clamp(s.zoom*Math.exp(-clamp(event.deltaY,-200,200)*.002),.25,8))};for(const el of elements)el?.addEventListener('wheel',wheel,{passive:false});return()=>{for(const el of elements)el?.removeEventListener('wheel',wheel)}},[mode]);
  useLayoutEffect(()=>{const value=anchor.current;if(!value)return;for(const surface of viewportList())if(surface){const g=geometry(sideOf(surface));surface.scrollLeft=value.x*g.width+20-value.screenX;surface.scrollTop=value.y*g.height+20-value.screenY}anchor.current=null},[zoom,paneWidth,paneHeight,mode,unified]);
  const changeZoom=(value:number)=>{const surface=viewportList()[0];if(surface){const g=geometry(sideOf(surface));anchor.current={x:(surface.scrollLeft+surface.clientWidth/2-20)/g.width,y:(surface.scrollTop+surface.clientHeight/2-20)/g.height,screenX:surface.clientWidth/2,screenY:surface.clientHeight/2}}setZoom(clamp(value,.25,8))};
  useEffect(()=>{
    if(!renderKey||working||(mode==='split'&&unified)){setPreviewLoading(false);return}const input=optionsRef.current;if(!input)return;let dead=false;const key=`${renderKey}:${previewWidth}`;
    const cached=previewCache.current.get(key);if(cached){setPreview(cached);setPreviewLoading(false);return}
    setPreviewLoading(true);const timer=window.setTimeout(()=>{void compareCall<Preview>('preview',{options:input,width:previewWidth}).then(async value=>{
      if(!value.a?.dataUrl?.startsWith('data:image/png;base64,')||value.a.width!==value.b.width||value.a.height!==value.b.height)throw Error('COMPARE_PREVIEW_INVALID');
      await Promise.all([value.a,value.b].map(p=>{const image=new Image();image.src=p.dataUrl;return image.decode()}));
      if(dead)return;previewCache.current.set(key,value);while(previewCache.current.size>2)previewCache.current.delete(previewCache.current.keys().next().value!);setPreview(value);
    }).catch(e=>{if(!dead)setError(message(e))}).finally(()=>{if(!dead)setPreviewLoading(false)})},140);
    return()=>{dead=true;clearTimeout(timer)};
  },[renderKey,previewWidth,working,mode,unified]);

  useEffect(()=>{if(!running)return;let dead=false,timer=0;const poll=async()=>{try{const state=await comparePoll();if(dead)return;if(state.progress.jobId===job.jobId||state.progress.error?.includes('COMPARE_RESET')){
      const value=state.progress;if(value.status==='complete')acceptCompletion(value);
      if(value.status==='failed'){setError(value.error||tr('对比失败，未生成完整结论。','Comparison failed; no complete conclusion.'));if(value.error?.includes('COMPARE_RESET')){setBatch(null);setProposal(null);setA(null);setB(null);setPreview(null);setProjectFile(null);clearResult();previewCache.current.clear();}}
      setJob(value);if(value.status!=='running')return;
    }}catch(e){if(!dead){setError(message(e));setJob(v=>({...v,status:'failed'}))}return}if(!dead)timer=window.setTimeout(poll,250)};void poll();return()=>{dead=true;clearTimeout(timer)};
  },[running,job.jobId,tr]);

  const detailBase=useRef('');
  useEffect(()=>{const base=report?.jobId+':'+selected;if(!selectedRegion||!report||stale||working){if(!selectedRegion||stale)setDetail(null);return}if(detailBase.current!==base){detailBase.current=base;setDetail(null)}const key=base+':'+detailWidth;const cached=detailCache.current.get(key);if(cached){setDetail(cached);setDetailLoading(false);return}let dead=false;setDetailLoading(true);const timer=window.setTimeout(()=>{void compareCall<Preview>('preview',{options:report.options,width:detailWidth,rect:detailBounds(selectedRegion,report)}).then(async value=>{await decodePictures([value.a,value.b]);if(!dead){cachePreview(detailCache.current,key,value,v=>v.a.dataUrl.length+v.b.dataUrl.length,3);setDetail(value)}}).catch(e=>{if(!dead)setError(message(e))}).finally(()=>{if(!dead)setDetailLoading(false)})},140);return()=>{dead=true;clearTimeout(timer)}},[selected,report?.jobId,stale,working,detailWidth]);


  const acceptCompletion=(value:Progress)=>{
    if(task.current==='align'){
      setProposal(validateAlignment(value.alignment!));
      setNote(tr('平移建议已准备，请检查可靠程度后应用。','Translation proposal ready. Review its confidence before applying.'));
      return;
    }
    if(task.current==='batch'){
      setBatch(validateBatch(value.batch!,value.jobId));setResultTab('batch');
      setNote(tr('批量处理结束，请检查未配对和失败页面。','Batch processing finished. Review unpaired and failed pages.'));
      return;
    }
    const result=validateReport(value.report!,value.jobId);
    setReport(result);
    const saved=restorePending.current;
    restorePending.current=null;
    if(saved){
      const opened=saved.kind==='project';
      const restored=restoreProjectReview(result,saved.checkpoint,opened);
      setSelected(restored.selected);setReviewed(restored.reviewed);setReviewNotes(restored.notes);
      setSavedReview(saved.savedReview);
      if(opened)setProjectFile(file=>file?{...file,selected:restored.selected}:null);
      resumeFocus.current=restored.selected;
      if(restored.unmatched){
        setError(tr(`${restored.unmatched} 项复核记录与本次分析不匹配。请重新核对这些差异。`,`${restored.unmatched} review entries did not match this analysis. Review those findings again.`));
        setNote(tr('分析已完成，请核对待复核差异。','Analysis complete. Check the pending findings.'));
      }else if(opened){
        setNote(restored.reviewed.size<result.regions.length
          ?tr('已重新打开对比项目，可继续核对下一处差异。','Comparison project reopened. Continue reviewing the next pending difference.')
          :tr('已重新打开对比项目，已匹配原复核记录。','Comparison project reopened with its matching review records.'));
      }else{
        setNote(tr('分析已完成，已保留匹配的复核记录。','Analysis complete. Matching review records were kept.'));
      }
    }else{
      setSelected(result.regions[0]?.id??0);setReviewed(new Set());setReviewNotes(new Map());setSavedReview('[]');
      setNote(tr('完整分析已完成。请结合原图人工复核。','Full analysis complete. Review the findings against the original drawings.'));
    }
  };
  const clearResult=(keepResume=false)=>{
    if(!keepResume)restorePending.current=null;
    resumeFocus.current=0;textEpoch.current++;setAssistance(null);setReport(null);setSelected(0);setDetail(null);setJob(emptyJob);
    setReviewed(new Set());setReviewNotes(new Map());setSavedReview('[]');detailCache.current.clear();
  };
  useEffect(()=>{const invalidated=()=>{setBatch(null);setProposal(null);setA(null);setB(null);setPreview(null);setProjectFile(null);clearResult();previewCache.current.clear();setError(tr('对比进程已停止，请重新选择图纸。主 PDF 工作区未受影响。','Comparison process stopped. Reselect drawings; the main PDF workspace is unaffected.'))};window.addEventListener(compareResetEvent,invalidated);return()=>window.removeEventListener(compareResetEvent,invalidated)},[tr]);
  const loadSource=async(side:'a'|'b',path:string,passwordText?:string)=>{
    busyRef.current=true;setBusy(tr('正在只读打开 PDF…','Opening PDF read-only…'));setError('');
    try{const source=await compareCall<Source>('open',{side,path,...(passwordText===undefined?{}:{password:passwordText})});if(!source.pages?.length)throw Error('COMPARE_SOURCE_INVALID');if(side==='a'){setA(source);setPageA('1')}else{setB(source);setPageB('1')}setEpochs(v=>({...v,[side]:v[side]+1}));setBatch(null);setProposal(null);setPassword(null);setPasswordValue('');setProjectFile(null);clearResult();setPreview(null);previewCache.current.clear();setRevision(v=>v+1);setIgnored([]);setDx('0');setDy('0');setZoom(1);setAlignPoint(null)}catch(e){const text=message(e);if(text.includes('PASSWORD_REQUIRED')){setPassword({side,path});setPasswordValue('');setError(passwordText===undefined?'':tr('密码不正确，请重试。','Incorrect password. Try again.'))}else setError(text)}finally{busyRef.current=false;setBusy('')}
  };
  const chooseSource=async(side:'a'|'b',confirmed=false)=>{if(busyRef.current||jobRef.current.status==='running'||!guard)return;if(projectDirtyRef.current&&!confirmed){setConfirmation(side==='a'?'source-a':'source-b');return}busyRef.current=true;setBusy(tr('选择本地 PDF…','Choosing local PDF…'));try{const path=await open({directory:false,multiple:false,filters:[{name:'PDF',extensions:['pdf']}],title:tr(side==='a'?'选择旧版图纸 A':'选择新版图纸 B',side==='a'?'Choose old drawing A':'Choose new drawing B')});if(typeof path==='string')await loadSource(side,path)}catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}};
  const applyOptions=(o:Options)=>{
    setPageA(String(o.pageA+1));setPageB(String(o.pageB+1));setDx(String(o.offsetXmm));setDy(String(o.offsetYmm));
    setDpi(o.dpi);setThreshold(o.threshold);setScaleMode(o.scaleMode??'physical');setIgnored(o.ignored);
  };
  const beginAnalysis=async(input:Options)=>{
    const id=crypto.randomUUID();
    await compareCall('start',{jobId:id,options:input});
    const key=optionsKey(input);
    const resume=restorePending.current;
    let keepResume=!!resume&&optionsKey(resume.checkpoint.options)===key;
    if(!keepResume&&report&&optionsKey(report.options)===key){
      restorePending.current={kind:'rerun',checkpoint:{options:report.options,
        review:captureReview(report.regions,reviewed,reviewNotes),selectedRegion:selectedRegion??null},savedReview,dirty:reviewDirtyRef.current};
      keepResume=true;
    }
    task.current='compare';setResultTab('single');clearResult(keepResume);
    setJob({...emptyJob,jobId:id,status:'running'});setTool('pan');setAlignPoint(null);
  };
  const doStart=async(override?:Options)=>{
    const input=override??optionsRef.current;if(!input||busyRef.current||jobRef.current.status==='running')return;
    busyRef.current=true;setBusy(tr('正在启动完整分析…','Starting full analysis…'));setError('');setNote('');
    try{await beginAnalysis(input)}catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}
  };
  const openProject=async(request:OpenProjectRequest)=>{
    busyRef.current=true;setBusy(tr('正在核验对比项目及原图…','Verifying the comparison project and its drawings…'));setError('');
    let project:OpenedProject;
    try{
      project=validateOpenedProject(await compareCall<OpenedProject>('open_project',{...request}));
    }catch(e){
      const failure=message(e);
      const match=/PROJECT_SOURCE_([AB])_(MISSING|CHANGED|PASSWORD_REQUIRED)/.exec(failure);
      if(match){
        const side=match[1] as 'A'|'B',kind=match[2]==='MISSING'?'missing':match[2]==='CHANGED'?'changed':'password';
        projectOpenRequest.current=request;
        setProjectPrompt({kind,side,retry:kind==='password'&&(side==='A'?request.passwordA:request.passwordB)!==undefined});
      }else{
        projectOpenRequest.current=null;setProjectPrompt(null);setError(failure);
      }
      busyRef.current=false;setBusy('');
      return;
    }

    projectOpenRequest.current=null;setProjectPrompt(null);setPassword(null);setPasswordValue('');
    setA(project.a);setB(project.b);applyOptions(project.options);
    setEpochs(value=>({a:value.a+1,b:value.b+1}));setRevision(value=>value+1);
    setBatch(null);setProposal(null);setPreview(null);setZoom(1);setDraft(null);setAlignPoint(null);setTool('pan');setFilter('all');setResultTab('single');
    const saved=checkpointReviewKey(project.review);
    previewCache.current.clear();clearResult();restorePending.current={kind:'project',checkpoint:project,savedReview:saved,dirty:false};
    setProjectFile({path:request.path,fileName:project.fileName,options:optionsKey(project.options),selected:0,review:saved});
    setNote(tr('已核验原图，正在恢复对比结果…','Drawings verified. Restoring the comparison…'));
    try{
      await beginAnalysis(project.options);
    }catch(e){
      setError(message(e));setNote(tr('可点击“开始对比”重试恢复。','Choose Compare drawings to retry restoration.'));
    }finally{
      busyRef.current=false;setBusy('');
    }
  };
  const chooseProject=async(confirmed=false)=>{
    if(busyRef.current||jobRef.current.status==='running'||!guard)return;
    if(projectDirtyRef.current&&!confirmed){setConfirmation('open-project');return}
    busyRef.current=true;setBusy(tr('选择本地对比项目…','Choosing a local comparison project…'));
    try{
      const path=await open({multiple:false,directory:false,title:tr('打开对比项目','Open comparison project'),filters:[{name:'Jerrivell',extensions:[projectExtension]}]});
      if(typeof path==='string')await openProject({path});
    }catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}
  };
  const writeProject=async(request:SaveProjectRequest,overwrite=false)=>{
    busyRef.current=true;setBusy(tr('正在本地保存对比项目…','Saving the comparison project locally…'));setError('');
    try{
      const result=await compareCall<{fileName:string;bytes:number}>('save_project',{...request,overwrite});
      setSavedReview(reviewSignature);
      setProjectFile({path:request.path,fileName:result.fileName,options:optionsKey(request.options),selected:request.selectedRegionId??0,review:reviewSignature});
      projectSaveRequest.current=null;setProjectPrompt(null);
      setNote(tr('对比项目已保存，可重新打开继续复核。','Comparison project saved. Reopen it to continue reviewing.'));
    }catch(e){
      const failure=message(e);
      if(!overwrite&&failure.includes('PROJECT_EXISTS')){projectSaveRequest.current=request;setProjectPrompt({kind:'overwrite'})}
      else{projectSaveRequest.current=null;setProjectPrompt(null);setError(failure)}
    }finally{busyRef.current=false;setBusy('')}
  };
  const chooseProjectSave=async()=>{
    if(!canSaveProject||!options||busyRef.current)return;
    const analysis=!stale?report:null;
    const review=analysis?captureReview(analysis.regions,reviewed,reviewNotes).map(entry=>({
      regionId:entry.region.id,reviewed:entry.reviewed,note:entry.note,
    })):[];
    if(new TextEncoder().encode([...reviewNotes.values()].join('')).length>maxReviewNoteBytes){
      setError(tr('备注总大小超过 256 KiB，请缩短部分备注后保存。','Review notes exceed 256 KiB. Shorten some notes before saving.'));return;
    }
    busyRef.current=true;setBusy(tr('选择项目保存位置…','Choosing where to save the project…'));
    try{
      const path=await save({title:tr('保存对比项目','Save comparison project'),defaultPath:projectFile?.path??`Jerrivell-comparison.${projectExtension}`,filters:[{name:'Jerrivell',extensions:[projectExtension]}]});
      if(path)await writeProject({path,options,jobId:analysis?.jobId??null,review,selectedRegionId:analysis?selectedRegion?.id??null:null});
    }catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}
  };
  const cancelProjectPrompt=useCallback(()=>{
    if(busyRef.current)return;
    projectOpenRequest.current=null;projectSaveRequest.current=null;setProjectPrompt(null);
  },[]);
  const continueProjectPrompt=async(passwordText?:string)=>{
    if(busyRef.current||!projectPrompt)return;
    if(projectPrompt.kind==='overwrite'){
      if(projectSaveRequest.current)await writeProject(projectSaveRequest.current,true);
      return;
    }
    const request=projectOpenRequest.current;
    if(!request)return;
    const side=projectPrompt.side;
    if(projectPrompt.kind==='password'){
      await openProject({...request,[side==='A'?'passwordA':'passwordB']:passwordText??''});
      return;
    }
    busyRef.current=true;setBusy(tr('选择原始图纸…','Choosing the original drawing…'));
    try{
      const path=await open({directory:false,multiple:false,title:tr(`定位原始图纸 ${side}`,`Locate original drawing ${side}`),filters:[{name:'PDF',extensions:['pdf']}]});
      if(typeof path==='string')await openProject({...request,[side==='A'?'sourceAPath':'sourceBPath']:path});
    }catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}
  };
  const stop=async()=>{if(busyRef.current||jobRef.current.status!=='running')return;busyRef.current=true;setBusy(tr('正在停止对比…','Stopping comparison…'));try{await compareCall('cancel',{jobId:jobRef.current.jobId});const until=Date.now()+2000;while(jobRef.current.status==='running'&&Date.now()<until){await new Promise(done=>setTimeout(done,100));const value=await comparePoll();if(value.progress.jobId===jobRef.current.jobId&&value.progress.status!=='running'){if(value.progress.status==='complete')acceptCompletion(value.progress);setJob(value.progress);jobRef.current=value.progress;break}}if(jobRef.current.status==='running'){await compareReset();setBatch(null);setProposal(null);setA(null);setB(null);setPreview(null);setProjectFile(null);clearResult();setNote(tr('已结束对比进程，请重新选择图纸；主工作区不受影响。','Comparison process stopped. Reselect drawings; the main workspace is unaffected.'))}}catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}};
  const reset=async()=>{busyRef.current=true;setBusy(tr('正在释放对比数据…','Releasing comparison data…'));try{await compareReset();setBatch(null);setProposal(null);setA(null);setB(null);setPreview(null);setProjectFile(null);clearResult();previewCache.current.clear();detailCache.current.clear();setIgnored([]);setDx('0');setDy('0');setNote('');setError('')}catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}};
  const exportReport=async(kind:'png'|'csv')=>{if(!report||stale||working||busyRef.current)return;busyRef.current=true;setBusy(tr('正在本地导出…','Exporting locally…'));setError('');try{const path=await save({title:tr('导出到单位认可的本地目录','Export to an approved local folder'),defaultPath:`Jerrivell-comparison.${kind}`,filters:[{name:kind.toUpperCase(),extensions:[kind]}]});if(!path)return;await compareCall('export',{jobId:report.jobId,path,kind,reviewed:[...reviewed]});if(kind==='csv'&&!projectFile&&!reviewNotes.size)setSavedReview(reviewSignature);setNote(tr('报告已写入你选择的文件；原图未改动。','Report written to the chosen file. Original drawings are unchanged.'))}catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}};
  const clearSide=async(side:'a'|'b')=>{if(busyRef.current||running)return;busyRef.current=true;setBusy(tr('正在清除所选来源…','Clearing the selected source…'));try{await compareCall('clear',{side});if(side==='a'){setA(null);setPageA('1')}else{setB(null);setPageB('1')}setEpochs(v=>({...v,[side]:v[side]+1}));setBatch(null);setProposal(null);setProjectFile(null);clearResult();setPreview(null);previewCache.current.clear();setIgnored([]);setDx('0');setDy('0');setAlignPoint(null);setError('');setNote(tr('仅所选来源已清除，另一侧保持可用。','Only the selected source was cleared. The other side stays available.'))}catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}};
  const startExtra=async(kind:'align'|'batch',plan?:{pairs:PagePair[];automatic:boolean})=>{const input=optionsRef.current;if(!input||busyRef.current||running)return;busyRef.current=true;setBusy(tr('正在启动任务…','Starting task…'));setError('');const id=crypto.randomUUID();task.current=kind;if(kind==='align')setProposal(null);else{setBatch(null);clearResult();setResultTab('batch')}
    try{await compareCall('start',{jobId:id,options:input,task:kind,...(plan?{pairs:plan.pairs.map(p=>pairOptions(input,p.a,p.b)),autoAlign:plan.automatic}:{})});setJob({...emptyJob,jobId:id,status:'running'});setTool('pan')}catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}};
  const applyProposal=()=>{if(!proposal?.reliable||!options||optionsKey(proposal.options)!==optionsKey(options))return;setDx(String(Number(proposal.offsetXmm.toFixed(6))));setDy(String(Number(proposal.offsetYmm.toFixed(6))));setIgnored([]);setProposal(null);setNote(tr('已应用整体平移，请按当前图幅模式重新分析。','Global translation applied. Run analysis again under the selected scale mode.'))};
  const inspectPair=(item:BatchItem,confirmed=false)=>{if(reviewDirtyRef.current&&!confirmed){pendingPair.current=item;setConfirmation('inspect-pair');return}const o=item.options;applyOptions(o);setProposal(null);setResultTab('single');setZoom(1);if(item.status==='complete')void doStart(o);else{clearResult();setNote(tr('请先人工对齐该配对，再进行完整分析。','Align this pair manually before running full analysis.'))}};
  const exportBatch=async()=>{if(!batch||working||busyRef.current)return;busyRef.current=true;setBusy(tr('正在导出批量清单…','Exporting batch report…'));try{const path=await save({defaultPath:'Jerrivell-batch.csv',filters:[{name:'CSV',extensions:['csv']}]});if(path){await compareCall('export_batch',{jobId:batch.jobId,path});setNote(tr('批量清单已导出，失败与未配对情况已保留。','Batch report exported, including failed and unpaired pages.'))}}catch(e){setError(message(e))}finally{busyRef.current=false;setBusy('')}};
  const askText=async()=>{if(!report||stale||working||assistLoading)return;const epoch=++textEpoch.current;setAssistLoading(true);try{const value=await compareCall<TextAssistance>('text_assist',{options:report.options});if(epoch===textEpoch.current)setAssistance(validateTextAssistance(value))}catch(e){setError(message(e))}finally{setAssistLoading(false)}};
  const closeRef=useRef(()=>{});closeRef.current=()=>{if(projectPrompt){cancelProjectPrompt();return}if(busyRef.current||jobRef.current.status==='running'||projectDirtyRef.current)setConfirmation('close');else void compareClose().catch(e=>setError(message(e)))};
  useEffect(()=>{let disposed=false,unlisten:(()=>void)|undefined;void getCurrentWebviewWindow().onCloseRequested(event=>{event.preventDefault();closeRef.current()}).then(off=>{if(disposed)off();else unlisten=off}).catch(()=>{});return()=>{disposed=true;unlisten?.()}},[]);

  const changeScaleMode=(value:ScaleMode)=>{if(working||value===scaleMode)return;setScaleMode(value);setIgnored([]);setDx('0');setDy('0');setAlignPoint(null);setProposal(null);setDraft(null);pointerStart.current=null;setTool('pan');setZoom(1);setPreview(null);previewCache.current.clear();setNote(tr('分析图幅已切换；偏移和忽略区已清空，请重新分析。','Analysis scale changed. Offsets and exclusions were cleared; run again.'))};
  const focusRegion=(region:Region)=>{setSelected(region.id);const level=Math.max(zoom,1.7);setZoom(level);requestAnimationFrame(()=>{for(const surface of viewportList())if(surface){const g=geometry(sideOf(surface),level);surface.scrollLeft=((region.bounds.x+region.bounds.width/2-g.rect.x)/g.rect.width)*g.width+20-surface.clientWidth/2;surface.scrollTop=((region.bounds.y+region.bounds.height/2-g.rect.y)/g.rect.height)*g.height+20-surface.clientHeight/2}})};
  useEffect(()=>{
    if(!viewReady||!selectedRegion||working||stale||resumeFocus.current!==selectedRegion.id)return;
    resumeFocus.current=0;focusRegion(selectedRegion);
  },[viewReady,selectedRegion,working,stale]);
  const changePages=(side:'a'|'b',value:string)=>{side==='a'?setPageA(value):setPageB(value);setIgnored([]);setAlignPoint(null)};
  const eventPoint=(event:ReactPointerEvent<SVGSVGElement>)=>{const rect=event.currentTarget.getBoundingClientRect();return pointInFrame(geometry(event.currentTarget.dataset.side as 'a'|'b'|'mix').rect,clamp((event.clientX-rect.left)/rect.width,0,1),clamp((event.clientY-rect.top)/rect.height,0,1))};
  const pointerDown=(event:ReactPointerEvent<SVGSVGElement>,side:'a'|'b'|'mix')=>{if(event.button!==0)return;
    if(tool==='pan'){if((event.target as Element).closest('.compare-region'))return;const surface=event.currentTarget.closest('.compare-viewport') as HTMLDivElement|null;if(surface){event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);panGesture.current={surface,x:event.clientX,y:event.clientY,left:surface.scrollLeft,top:surface.scrollTop}}return}
    if(working)return;
    if(tool==='align'&&mode==='split'){const p=eventPoint(event);if(side==='a'){setAlignPoint([p.x,p.y]);setNote(tr('再点击 B 中同一个基准点。','Now click the same reference point in B.'))}else if(side==='b'&&alignPoint&&frame){setDx(String(Number((Number(dx)+(alignPoint[0]-p.x)*frame.widthPt*25.4/72).toFixed(3))));setDy(String(Number((Number(dy)+(alignPoint[1]-p.y)*frame.heightPt*25.4/72).toFixed(3))));setIgnored([]);setAlignPoint(null);setTool('pan');setNote(tr('已按基准点更新 B 的整体平移，请重新分析。','B translation updated from reference points. Run the comparison again.'))}return;}
    if(tool!=='ignore')return;if(ignored.length>=16){setError(tr('最多 16 个忽略区域。','Up to 16 ignored areas.'));return}event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);const p=eventPoint(event);pointerStart.current=p;setDraft({x:p.x,y:p.y,width:0,height:0});
  };
  const pointerMove=(event:ReactPointerEvent<SVGSVGElement>)=>{const pan=panGesture.current;if(pan){pan.surface.scrollLeft=pan.left+pan.x-event.clientX;pan.surface.scrollTop=pan.top+pan.y-event.clientY;syncScroll(pan.surface);return}const p=pointerStart.current;if(!p)return;const q=eventPoint(event);setDraft({x:Math.min(p.x,q.x),y:Math.min(p.y,q.y),width:Math.abs(p.x-q.x),height:Math.abs(p.y-q.y)})};
  const pointerUp=(event:ReactPointerEvent<SVGSVGElement>)=>{panGesture.current=null;if(!pointerStart.current)return;const p=eventPoint(event),start=pointerStart.current;pointerStart.current=null;setDraft(null);const g=geometry(event.currentTarget.dataset.side as 'a'|'b'|'mix');if(Math.abs(p.x-start.x)/g.rect.width*g.width<3||Math.abs(p.y-start.y)/g.rect.height*g.height<3)return;setIgnored(v=>[...v,{x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),width:Math.abs(p.x-start.x),height:Math.abs(p.y-start.y)}])};
  const visibleRegions=report?.regions.filter(r=>filter==='all'||filter==='reviewed'&&reviewed.has(r.id)||filter==='pending'&&!reviewed.has(r.id)||filter==='tiny'&&r.pixels<=25)||[];
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(projectPrompt||confirmation||password)return;if(event.key==='Escape'){setDraft(null);pointerStart.current=null;setAlignPoint(null);setTool('pan')}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='o'){event.preventDefault();void chooseSource(a?'b':'a')}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='w'){event.preventDefault();closeRef.current()}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[a,guard,tr,projectPrompt,confirmation,password]);

  const layer=(side:'a'|'b'|'mix')=>{
    const mixed=side==='mix',g=geometry(side),picture=side!=='mix'&&unified?sourceViews[side]:side==='b'?preview?.b:preview?.a;if(!picture||!frame)return null;const bOpacity=mode==='curtain'?1:mode==='blink'?(blink?1:0):alpha;
    return <div className="compare-sheet" style={{width:g.width,height:g.height}} data-source-side={side}>
      <img className="compare-paper-image" src={picture.dataUrl} alt={tr(side==='b'?'新版 B 页面':'旧版 A 页面',side==='b'?'New page B':'Old page A')} draggable={false}/>
      {mixed&&preview&&<img className="compare-paper-image compare-b-image" src={preview.b.dataUrl} alt={tr('新版 B 叠加','New page B overlay')} draggable={false} style={{opacity:bOpacity,clipPath:mode==='curtain'?`inset(0 ${(1-alpha)*100}% 0 0)`:undefined}}/>}
      {showDiff&&report&&!stale&&<img className="compare-mask" src={report.mask.dataUrl} alt={tr('差异精确高亮','Exact difference highlights')} draggable={false} style={{left:-g.rect.x/g.rect.width*g.width,top:-g.rect.y/g.rect.height*g.height,width:g.width/g.rect.width,height:g.height/g.rect.height}}/>}
      <svg className={`compare-hit-layer tool-${tool}`} data-side={side} viewBox={`${g.rect.x*1000} ${g.rect.y*1000} ${g.rect.width*1000} ${g.rect.height*1000}`} preserveAspectRatio="none" onPointerDown={event=>pointerDown(event,side)} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={()=>{pointerStart.current=null;panGesture.current=null;setDraft(null)}}>
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
  const sourceCard=(side:'a'|'b',source:Source|null,page:string)=><div className="compare-source-card"><span className={`compare-side side-${side}`}>{side.toUpperCase()}</span><div className="compare-source-title"><strong title={source?.fileName}>{source?.fileName||tr(side==='a'?'旧版图纸':'新版图纸',side==='a'?'Old drawing':'New drawing')}</strong><small>{source?tr(`${source.pages.length} 页 · ${(source.fileSize/1024).toFixed(0)} KB`,`${source.pages.length} pages · ${(source.fileSize/1024).toFixed(0)} KB`):tr('只读载入本地 PDF','Read-only local PDF')}</small></div><button className="button secondary" onClick={()=>void chooseSource(side)} disabled={working||!guard} aria-label={tr(`选择 ${side.toUpperCase()}`,`Choose ${side.toUpperCase()}`)}><FolderOpen size={15}/>{source?tr('更换','Change'):tr('选择 PDF','Choose PDF')}</button>{source&&<button className="compare-source-clear" title={tr(`清除 ${side.toUpperCase()} 来源`,`Clear source ${side.toUpperCase()}`)} disabled={working} aria-label={tr(`清除 ${side.toUpperCase()}`,`Clear ${side.toUpperCase()}`)} onClick={()=>projectDirtyRef.current?setConfirmation(side==='a'?'clear-a':'clear-b'):void clearSide(side)}><X size={14}/></button>}{source&&<label className="compare-page-input">{tr('页','Page')}<input inputMode="numeric" aria-label={tr(`${side.toUpperCase()} 页码`,`${side.toUpperCase()} page`)} value={page} onChange={e=>changePages(side,e.target.value)} disabled={working}/><span>/ {source.pages.length}</span></label>}</div>;

  return <div className="compare-app">
    <header className="compare-header"><div className="compare-brand"><img src={icon} alt=""/><div><strong>Jerrivell <span>{tr('图纸对比','Drawing Compare')}</span></strong><small>{tr('独立工作区 · 原图只读 · 本地处理','Independent workspace · Read-only originals · Local processing')}</small></div></div><div className={`compare-policy ${guard?'ready':''}`} title={tr('应用界面阻断外部资源；不是整机隔离认证。','External resources blocked in this workspace; this is not system isolation certification.')}><ShieldCheck size={16}/>{guard?tr('外部资源已阻断','External resources blocked'):tr('正在检查离线策略…','Checking offline policy…')}</div><select aria-label={tr('界面语言','Interface language')} className="language-select" value={language} onChange={e=>setLanguage(e.target.value)}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select><button className="icon-button" aria-label={tr('关闭对比工作区','Close comparison workspace')} onClick={()=>closeRef.current()}><X size={19}/></button></header>
    <section className="compare-project-tools" aria-label={tr('对比项目','Comparison project')}>
      <button className="button secondary" disabled={working||!guard} onClick={()=>void chooseProject()}><FolderOpen size={15}/>{tr('打开对比项目','Open comparison project')}</button>
      <button className="button secondary" disabled={!canSaveProject} onClick={()=>void chooseProjectSave()}><Save size={15}/>{tr('保存对比项目','Save comparison project')}</button>
      {projectFile&&<span className="compare-project-name" title={projectFile.fileName}>{projectFile.fileName}</span>}
      {projectDirty&&<span className="compare-project-dirty" role="status">{tr('有未保存的更改','Unsaved changes')}</span>}
    </section>
    <section className="compare-sources" aria-label={tr('对比来源','Comparison sources')}>{sourceCard('a',a,pageA)}<ArrowLeftRight size={19}/>{sourceCard('b',b,pageB)}</section>
    <section className="compare-options" aria-label={tr('对比参数','Comparison settings')}>
      <label>{tr('分析 DPI','Analysis DPI')}<select value={dpi} onChange={e=>setDpi(Number(e.target.value))} disabled={working}><option value="150">150</option><option value="300">300</option><option value="600">600</option></select></label>
      <label>{tr('灰度/颜色容差','Pixel tolerance')}<select value={threshold} onChange={e=>setThreshold(Number(e.target.value))} disabled={working}><option value="0">{tr('严格 · 0','Strict · 0')}</option><option value="16">16 / 255</option><option value="32">32 / 255</option></select></label>
      <label className="compare-scale-select" title={tr('统一图幅会将 B 等比例适配到 A 后分析；整体出图比例变化会被归一，不作为差异。长宽比不同时保留留白，不拉伸。','Fit B proportionally to A before analysis. Overall print-scale changes are normalized and are not findings. Different aspect ratios retain padding without stretching.')}><span>{tr('分析尺寸','Analysis scale')}</span><select aria-label={tr('分析尺寸模式','Analysis scale mode')} value={scaleMode} onChange={e=>changeScaleMode(e.target.value as ScaleMode)} disabled={working}><option value="normalized">{tr('按统一图幅（推荐）','Fit to A (recommended)')}</option><option value="physical">{tr('按原始尺寸','Original paper sizes')}</option></select></label>
      <label title={scaleMode==='normalized'?tr('按 A 页基准计量的参考毫米，不代表真实纸张或零件尺寸。','Reference millimetres in the A-page coordinate system, not a physical paper or part measurement.'):undefined}>{tr(scaleMode==='normalized'?'B 水平参考 mm':'B 水平 mm',scaleMode==='normalized'?'B horizontal ref mm':'B horizontal mm')}<input aria-label={tr('B 水平偏移','B horizontal offset')} inputMode="decimal" value={dx} disabled={working} onChange={e=>{setDx(e.target.value);setIgnored([])}}/></label>
      <label title={scaleMode==='normalized'?tr('按 A 页基准计量的参考毫米，不代表真实纸张或零件尺寸。','Reference millimetres in the A-page coordinate system, not a physical paper or part measurement.'):undefined}>{tr(scaleMode==='normalized'?'B 垂直参考 mm':'B 垂直 mm',scaleMode==='normalized'?'B vertical ref mm':'B vertical mm')}<input aria-label={tr('B 垂直偏移','B vertical offset')} inputMode="decimal" value={dy} disabled={working} onChange={e=>{setDy(e.target.value);setIgnored([])}}/></label>
      <button className={`button secondary ${tool==='align'?'active':''}`} disabled={!viewReady||working||mode!=='split'} onClick={()=>{setTool(tool==='align'?'pan':'align');setAlignPoint(null);setNote(tr('先在 A 点击稳定基准点，再在 B 点击对应点；在当前分析图幅中仅平移。','Click a stable reference in A, then its match in B. Translation within the selected analysis frame.'))}}><ScanLine size={15}/>{tr('两点平移对齐','Point alignment')}</button>
      <button className="button secondary" disabled={!options||working||!guard} onClick={()=>void startExtra('align')}>{tr('自动平移配准','Auto translation')}</button>
      <button className="button secondary" disabled={!options||working} onClick={()=>setBatchDialog(true)}>{tr('多页对比','Multi-page')}</button>
      {running?<button className="button compare-stop" disabled={!!busy} onClick={()=>void stop()}><X size={15}/>{tr('停止计算','Stop')}</button>:<button className="button primary compare-start" disabled={!options||working||!guard} onClick={()=>reviewDirtyRef.current&&changedReviewContext?setConfirmation('run'):void doStart()}><Layers3 size={16}/>{report?tr('重新分析','Run again'):tr('开始对比','Compare drawings')}</button>}
      <button className="icon-button" disabled={working||(!a&&!b)} onClick={()=>projectDirtyRef.current?setConfirmation('reset'):void reset()} title={tr('清空并释放本工作区','Clear and release this workspace')} aria-label={tr('清空对比','Clear comparison')}><Trash2 size={16}/></button>
    </section>
    {proposal&&<div className="compare-alignment-proposal" role="status"><span>{tr('整体平移建议','Translation proposal')}: X {proposal.offsetXmm.toFixed(3)} {tr(scaleMode==='normalized'?'参考 mm':'mm',scaleMode==='normalized'?'ref mm':'mm')} · Y {proposal.offsetYmm.toFixed(3)} {tr(scaleMode==='normalized'?'参考 mm':'mm',scaleMode==='normalized'?'ref mm':'mm')} · {tr('边缘吻合','Edge agreement')} {Math.round(proposal.agreement*100)}% · {proposal.reliable?tr('可供确认','Ready for review'):tr('不可靠，请人工对齐','Unreliable; align manually')}</span><button className="button secondary" disabled={!proposal.reliable||!options||optionsKey(proposal.options)!==fingerprint||working} onClick={()=>reviewDirtyRef.current?setConfirmation('apply-align'):applyProposal()}>{tr('确认应用平移','Apply translation')}</button><button aria-label={tr('关闭配准建议','Dismiss alignment proposal')} onClick={()=>setProposal(null)}><X size={15}/></button></div>}
    {a&&b&&!options&&<div className="compare-caution" role="status">{tr('请输入有效页码；水平与垂直偏移需在 −100～100 mm 内。输入完成后即可继续预览与分析。','Enter valid page numbers and offsets between −100 and 100 mm to continue previewing and analyzing.')}</div>}
    {error&&<div className="compare-message error" role="alert"><span>{error==='COMPARE_RESPONSE_INVALID'?tr('对比响应校验失败，未生成完整结论。','Invalid comparison response; no complete conclusion.'):error}</span><button aria-label={tr('关闭错误','Dismiss error')} onClick={()=>setError('')}><X size={15}/></button></div>}
    <div className="compare-workspace">
      <main className="compare-main">
        <div className="compare-view-tools"><div className="compare-segment">{([['split',tr('并排','Side by side')],['overlay',tr('叠加','Overlay')],['curtain',tr('拉幕','Curtain')],['blink',tr('闪烁','Blink')]]as const).map(([key,label])=><button key={key} aria-pressed={mode===key} className={mode===key?'active':''} onClick={()=>{setMode(key);setTool('pan');setAlignPoint(null)}}>{label}</button>)}</div>
          {mode!=='split'&&<label className="compare-opacity">{mode==='curtain'?tr('位置','Position'):tr('B 显示','B opacity')}<input type="range" min="0" max="1" step=".01" aria-label={tr('B 显示比例','B display proportion')} value={alpha} onChange={e=>setAlpha(Number(e.target.value))}/></label>}
          {mode==='blink'&&<button className="text-button" onClick={()=>setBlinkPaused(v=>!v)}>{blinkPaused?tr('继续闪烁','Resume'):tr('暂停闪烁','Pause')}</button>}
          <label className="compare-display-mode" title={tr('只控制两侧各自适应窗口；实际分析尺寸由上方“分析尺寸”选择。','Only fits each viewport. The Analysis scale selector controls the actual comparison dimensions.')}><input type="checkbox" checked={unified} disabled={mode!=='split'} onChange={e=>{setUnified(e.target.checked);setZoom(1)}}/>{tr('各自适应窗口','Fit each viewport')}</label><div className="compare-tool-toggles"><button aria-label={tr('查看工具','Inspect tool')} aria-pressed={tool==='pan'} onClick={()=>setTool('pan')}><MousePointer2 size={15}/></button><button aria-label={tr('框选忽略区域','Draw ignored area')} aria-pressed={tool==='ignore'} disabled={!viewReady||working} onClick={()=>setTool(tool==='ignore'?'pan':'ignore')}><SquareDashed size={15}/></button>{ignored.length>0&&<button disabled={working} onClick={()=>setIgnored([])}>{tr(`清除忽略 ${ignored.length}`,`Clear ${ignored.length} exclusions`)}</button>}</div>
          <label className="compare-highlight-toggle"><input type="checkbox" checked={showDiff} onChange={e=>setShowDiff(e.target.checked)}/>{tr('差异高亮','Highlights')}</label>
        </div>
        {(stale||frame?.uncovered||ignored.length>0)&&<div className="compare-caution">{stale?tr('参数已变化，当前为旧结果；重新分析后才能导出。','Settings changed. These are old findings; run again before exporting.'):frame?.uncovered?(scaleMode==='normalized'&&frame.aspectMismatch?tr('长宽比不同：B 已等比例适配并居中，保留留白；未覆盖区域请人工检查。','Aspect ratios differ: B is fitted proportionally and centered with padding. Review uncovered areas.'):tr('图幅或有效覆盖范围不同。非重叠区需要人工检查。','Page sizes or coverage differ. Review non-overlapping areas.')):tr('已设置忽略区域，结论不包含这些区域。','Ignored areas are excluded from the conclusion.')}</div>}
        {stale&&report&&reviewSignature!=='[]'&&<div className="compare-caution compare-project-stale"><button className="button secondary" disabled={working} onClick={()=>applyOptions(report.options)}>{tr('恢复本次复核参数','Restore reviewed settings')}</button></div>}
        <div className={`compare-panes ${mode==='split'?'split':'mixed'}`} ref={paneRef}>
          {mode==='split'?(['a','b']as const).map(side=><section className="compare-pane" key={side}><div className="compare-pane-label"><span className={`compare-side side-${side}`}>{side.toUpperCase()}</span>{(side==='a'?a:b)?.fileName}<small>{tr(side==='a'?'旧版':'新版',side==='a'?'Old':'New')}</small></div><div ref={side==='a'?viewportA:viewportB} data-compare-side={side} className="compare-viewport" onScroll={e=>syncScroll(e.currentTarget)}>{layer(side)||<div className="compare-empty"><Layers3 size={30}/><p>{(side==='a'?a:b)?tr('正在准备页面…','Preparing page…'):tr(`请选择 ${side.toUpperCase()} 侧 PDF`,`Choose PDF ${side.toUpperCase()}`)}</p></div>}</div></section>):<section className="compare-pane"><div className="compare-pane-label">{scaleMode==='normalized'?tr('按 A 统一图幅 · 同步叠加','Fit to A · Synchronized overlay'):tr('原始纸面尺寸 · 同步叠加','Original paper sizes · Synchronized overlay')}</div><div ref={viewportMix} data-compare-side="mix" className="compare-viewport">{layer('mix')||<div className="compare-empty">{a&&b?tr('正在准备分析图幅预览…','Preparing analysis-frame preview…'):tr('请先选择两份 PDF','Choose both PDFs first')}</div>}</div></section>}

          {(previewLoading||soloA.loading||soloB.loading)&&<div className="compare-preview-loading"><LoaderCircle className="spin" size={14}/>{tr('更新清晰预览…','Updating preview…')}</div>}
        </div>
        {selectedRegion&&!stale&&report&&<DetailDock detail={detail} loading={detailLoading} id={selectedRegion.id}
          resetKey={report.jobId+':'+selectedRegion.id} tr={tr} reviewed={reviewed.has(selectedRegion.id)}
          note={reviewNotes.get(selectedRegion.id)??''} disabled={working||!!projectPrompt||!!confirmation}
          aspect={(()=>{const r=detailBounds(selectedRegion,report);return r.height*report.heightPt/(r.width*report.widthPt)})()}
          onResolution={setDetailWidth} onNext={nextPending?()=>focusRegion(nextPending):undefined}
          onReview={checked=>setReviewed(v=>{const next=new Set(v);checked?next.add(selectedRegion.id):next.delete(selectedRegion.id);return next})}
          onNote={value=>setReviewNotes(v=>{const next=new Map(v);if(value)next.set(selectedRegion.id,value);else next.delete(selectedRegion.id);return next})}/>}
        <div className="compare-view-footer"><span title={scaleMode==='normalized'?tr('按 A 页统一图幅参与分析，整体出图比例变化会被归一；参考毫米不代表真实尺寸。','Analysis fits B to A. Overall print-scale changes are normalized; reference millimetres are not physical dimensions.'):undefined}>{scaleMode==='normalized'?tr('按 A 统一图幅 · ','Fit to A · '):tr('原始尺寸 · ','Original sizes · ')}{note||tr('绿：新增 · 紫红：删除 · 橙：颜色变化 · 小点不会按面积剔除','Green: added · Magenta: removed · Orange: color change · Small points retained')}</span><button aria-label={tr('缩小对比视图','Zoom out comparison')} onClick={()=>changeZoom(zoom/1.2)}><Minus size={15}/></button><span className="compare-zoom">{Math.round(zoom*100)}%</span><button aria-label={tr('放大对比视图','Zoom in comparison')} onClick={()=>changeZoom(zoom*1.2)}><Plus size={15}/></button><button onClick={()=>{setZoom(1);for(const v of viewportList())if(v){v.scrollLeft=0;v.scrollTop=0}}}><Maximize2 size={14}/>{tr('适页','Fit')}</button></div>
      </main>
      <aside className="compare-results" aria-label={tr('差异与复核','Differences and review')}>
        <div className="compare-result-heading"><h2>{tr('差异与复核','Differences & review')}</h2><span>{report?.regions.length??'—'}</span></div>
        {batch&&<div className="compare-result-tabs"><button aria-pressed={resultTab==='single'} onClick={()=>setResultTab('single')}>{tr('单页差异','Page findings')}</button><button aria-pressed={resultTab==='batch'} onClick={()=>setResultTab('batch')}>{tr('多页结果','Batch results')} ({batch.items.length})</button></div>}
        {batch&&resultTab==='batch'&&!running&&<div className="compare-batch-results"><strong>{batch.allAnalyzed?tr('已分析全部指定配对','All requested pairs analyzed'):tr('有配对未能完成分析','Some pairs could not be analyzed')}</strong><p>{tr('未配对或未包含','Unpaired or not included')}: A {batch.unpairedA.length} {tr('页','pages')} · B {batch.unpairedB.length} {tr('页','pages')}</p>{(batch.unpairedA.length>0||batch.unpairedB.length>0||!batch.allAnalyzed)&&<small>{tr('本结果不能作为整本文档无变化的结论。','This cannot establish that the entire documents are unchanged.')}</small>}{batch.items.map(item=><button className="compare-batch-row" key={item.index} disabled={working} onClick={()=>inspectPair(item)}><strong>A {item.options.pageA+1} ↔ B {item.options.pageB+1}</strong><span>{item.status==='complete'?tr(`${item.regionCount} 区域 · ${item.changedPixels} 变化像素`,`${item.regionCount} regions · ${item.changedPixels} changed pixels`):tr('失败 · 需要人工检查','Failed · Needs manual review')}</span><small>{item.options.scaleMode==='normalized'?tr('统一图幅 · ','Fit to A · '):tr('原始尺寸 · ','Original sizes · ')}{item.status==='complete'?tr('点击重新精细分析','Click to rerun detailed analysis'):item.error}</small></button>)}<button className="button secondary" onClick={()=>void exportBatch()} disabled={working}><Download size={14}/>{tr('导出批量 CSV','Export batch CSV')}</button></div>}
        {running?<div className="compare-progress" role="status"><LoaderCircle size={21} className="spin"/><strong>{task.current==='align'?tr('正在计算平移建议','Estimating translation'):task.current==='batch'?tr('正在批量分析','Analyzing page pairs'):tr('正在完整分析','Analyzing the full pages')}</strong><progress max={job.total||1} value={job.completed}/><span>{job.completed} / {job.total||'—'} {task.current==='batch'?tr('组','pairs'):task.current==='align'?'%':tr('瓦片','tiles')}</span><small>{tr('尚未完成，不能据此判定图纸相同。','Incomplete analysis cannot establish that drawings match.')}</small></div>:report?<div className={`compare-summary ${stale?'stale':''}`}><strong>{report.changedPixels?tr(`${report.regions.length} 个差异区域`,`${report.regions.length} difference regions`):tr('当前参数下未发现像素差异','No pixel differences under these settings')}</strong><span>{report.changedPixels.toLocaleString()} {tr('变化像素','changed pixels')} · {report.options.dpi} DPI</span>{report.options.scaleMode==='normalized'&&<small>{tr('按 A 统一图幅；整体出图比例变化不计为差异，非真实尺寸测量。','Fitted to A; overall print-scale changes are normalized, not physical measurements.')}</small>}{(report.uncovered||report.ignoredPixels>0)&&<small>{tr('结论有限定：有非重叠区或忽略区，请人工核对。','Qualified result: non-overlapping or excluded areas require review.')}</small>}</div>:<div className="compare-result-empty"><FileText size={25}/><p>{job.status==='cancelled'?tr('分析已取消，没有完整结论。','Analysis cancelled; no complete conclusion.'):job.status==='failed'?tr('分析未完成，请检查错误后重试。','Analysis incomplete. Review the error and retry.'):tr('预览就绪后，点击“开始对比”。','When previews are ready, choose Compare drawings.')}</p></div>}
        {report&&resultTab==='single'&&<><div className="compare-list-controls"><select aria-label={tr('差异筛选','Filter differences')} value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">{tr('全部变化','All changes')}</option><option value="tiny">{tr('细小变化 ≤25 像素','Tiny changes ≤25 pixels')}</option><option value="pending">{tr('待复核','Pending review')}</option><option value="reviewed">{tr('已复核','Reviewed')}</option></select><button disabled={!report.regions.length||stale} aria-label={tr('上一处差异','Previous difference')} onClick={()=>{const list=report.regions;focusRegion(list[(list.findIndex(r=>r.id===selected)-1+list.length)%list.length])}}><ChevronLeft size={16}/></button><button disabled={!report.regions.length||stale} aria-label={tr('下一处差异','Next difference')} onClick={()=>{const list=report.regions;focusRegion(list[(list.findIndex(r=>r.id===selected)+1)%list.length])}}><ChevronRight size={16}/></button></div>
        <div className="compare-region-list">{visibleRegions.map(r=><button key={r.id} className={`compare-region-row ${r.id===selected?'active':''}`} disabled={stale||working} onClick={()=>focusRegion(r)}><span className="compare-region-id">{r.id}</span><span><strong>{r.pixels<=25?tr('细小变化','Tiny change'):tr('变化区域','Changed region')}</strong><small>{r.pixels.toLocaleString()} px · +{r.added} / −{r.removed}{r.changed?` / ~${r.changed}`:''}</small></span>{reviewed.has(r.id)&&<Check size={15}/>}</button>)}</div>
        </>}
        {report&&!stale&&resultTab==='single'&&<div className="compare-text-assist"><button className="button secondary" disabled={working||assistLoading} onClick={()=>void askText()}>{assistLoading?<LoaderCircle className="spin" size={13}/>:<FileText size={13}/>} {tr('文字与尺寸变化辅助','Text and dimension assistance')}</button>{assistance&&<><small>{tr('仅辅助提取的文字差异；图纸顺序和编码也会影响结果，不代替视觉复核。','Extracted text assistance only; ordering and encoding can affect findings. Review the visual differences.')}</small>{assistance.status!=='available'&&<p>{tr(assistance.status==='restricted'?'来源不允许或无法核实复制权限，保留视觉对比。':assistance.status==='limited'?'文字处理达到预算，未完成全文语义检查。':'缺少可提取文字，保留视觉对比。',assistance.status==='restricted'?'Copy permissions are restricted or unverified; visual comparison remains available.':assistance.status==='limited'?'Text budget reached; semantic review is incomplete.':'No usable text layer; visual comparison remains available.')}</p>}{assistance.status==='available'&&!assistance.changes.length&&<p>{tr('提取的文字序列未发现变化。','No change in the extracted text sequence.')}</p>}<div className="compare-text-changes">{assistance.changes.map((c,i)=><div key={i}>{c.dimensionLike&&<b>{tr('疑似尺寸/符号','Possible dimension/symbol')}</b>}<del>{c.old||'—'}</del><ins>{c.new||'—'}</ins></div>)}</div></>}</div>}
        <div className="compare-export"><button className="button secondary" disabled={!report||stale||working} onClick={()=>void exportReport('png')}><Download size={15}/>{tr('标记概览 PNG','Marked PNG')}</button><button className="button primary" disabled={!report||stale||working} onClick={()=>void exportReport('csv')}><Download size={15}/>{tr('差异清单 CSV','Difference CSV')}</button></div>
      </aside>
    </div>
    <footer className="compare-status"><span><ShieldCheck size={12}/>{tr('原图只读 · 不上传 · 不修改主工作区','Read-only originals · No uploads · Main workspace unchanged')}</span><span>{busy||tr('Ctrl+滚轮缩放 · 两侧同步滚动','Ctrl+wheel zoom · Synchronized scrolling')}</span></footer>
    {batchDialog&&a&&b&&<BatchDialog countA={a.pages.length} countB={b.pages.length} tr={tr} onClose={()=>setBatchDialog(false)} onStart={(pairs,automatic)=>{setBatchDialog(false);pendingBatch.current={pairs,automatic};if(reviewDirtyRef.current)setConfirmation('batch');else void startExtra('batch',pendingBatch.current)}}/>}
    {projectPrompt&&<ProjectDialog prompt={projectPrompt} busy={working} tr={tr} onCancel={cancelProjectPrompt} onContinue={value=>void continueProjectPrompt(value)}/>}
    {password&&<div className="modal-backdrop"><form className="modal compare-password" role="dialog" aria-modal="true" aria-labelledby="compare-password-title" onSubmit={e=>{e.preventDefault();void loadSource(password.side,password.path,passwordValue)}}><h2 id="compare-password-title">{tr('输入 PDF 打开密码','Enter the PDF opening password')}</h2><p>{tr('密码仅用于本次打开，不记录到日志或配置。','The password is used only for this open operation, without logs or saved settings.')}</p><input className="text-input" type="password" autoFocus autoComplete="off" aria-label={tr('PDF 密码','PDF password')} value={passwordValue} onChange={e=>setPasswordValue(e.target.value)} disabled={!!busy}/><div className="modal-actions"><button className="button secondary" type="button" disabled={!!busy} onClick={()=>{setPassword(null);setPasswordValue('')}}>{tr('取消','Cancel')}</button><button className="button primary" disabled={!!busy} type="submit">{tr('打开','Open')}</button></div></form></div>}
    {confirmation&&<div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="compare-confirm-title"><h2 id="compare-confirm-title">{tr('保留本次复核记录？','Keep this review?')}</h2><p>{running?tr('关闭会停止当前对比。原始 PDF 和主工作区保持原样。','Closing stops this analysis. Original PDFs and the main workspace stay unchanged.'):tr('该操作会清除本次复核状态。需要保留时，请先保存对比项目。','Save the comparison project first to keep your current changes.')}</p><div className="modal-actions"><button className="button secondary" onClick={()=>setConfirmation(null)}>{tr('返回工作区','Keep working')}</button><button className="button primary" onClick={()=>{const action=confirmation;setConfirmation(null);if(action==='close')void compareClose().catch(e=>setError(message(e)));else if(action==='open-project')void chooseProject(true);else if(action==='reset')void reset();else if(action==='clear-a'||action==='clear-b')void clearSide(action==='clear-a'?'a':'b');else if(action==='apply-align')applyProposal();else if(action==='inspect-pair'&&pendingPair.current)inspectPair(pendingPair.current,true);else if(action==='batch'&&pendingBatch.current)void startExtra('batch',pendingBatch.current);else if(action==='source-a'||action==='source-b')void chooseSource(action==='source-a'?'a':'b',true);else void doStart()}}>{confirmation==='close'?tr('关闭对比','Close comparison'):tr('继续','Continue')}</button></div></div></div>}
  </div>;
}
