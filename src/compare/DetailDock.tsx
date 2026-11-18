// SPDX-License-Identifier: MIT OR Apache-2.0
import {useEffect,useRef,useState,useCallback} from 'react';
import {Maximize2,Minimize2,Minus,Plus,X,LoaderCircle} from 'lucide-react';
import {createPreviewZoomController} from '../previewZoom';
import {useDialogFocus} from './useDialogFocus';
import type {Preview} from './types';
type Tr=(zh:string,en:string)=>string;
export function DetailDock({detail,loading,id,resetKey,aspect,tr,reviewed,onReview,onResolution}:{detail:Preview|null;loading:boolean;id:number;resetKey:string;aspect:number;tr:Tr;reviewed:boolean;onReview:(value:boolean)=>void;onResolution:(width:number)=>void}){
  const[expanded,setExpanded]=useState(false),[zoom,setZoom]=useState(1),[height,setHeight]=useState(280);
  const viewport=useRef<HTMLDivElement>(null),extent=useRef<HTMLDivElement>(null),paper=useRef<HTMLDivElement>(null),controller=useRef<ReturnType<typeof createPreviewZoomController>|null>(null);
  const resize=useRef<{y:number;height:number}|null>(null),resolution=useRef(onResolution);resolution.current=onResolution;
  useEffect(()=>{if(!viewport.current||!extent.current||!paper.current)return;controller.current=createPreviewZoomController(viewport.current,extent.current,paper.current,2000,aspect*1000,v=>{setZoom(v);resolution.current(Math.min(4096,Math.ceil(Math.max(1024,(expanded?1536:1024)*v)*(window.devicePixelRatio||1)/512)*512))});return()=>{controller.current?.destroy();controller.current=null}},[resetKey,expanded,aspect]);
  const dock=useRef<HTMLElement>(null),collapse=useCallback(()=>setExpanded(false),[]);useDialogFocus(dock,expanded,collapse);
  return <section ref={dock} role={expanded?'dialog':undefined} aria-modal={expanded||undefined} className={`compare-detail-dock ${expanded?'expanded':''}`} style={expanded?undefined:{height}} aria-label={tr('差异详情','Difference details')}>
    {!expanded&&<div className="compare-detail-resizer" role="separator" aria-label={tr('调整详情高度','Resize detail height')} aria-orientation="horizontal" tabIndex={0}
      onPointerDown={e=>{resize.current={y:e.clientY,height};e.currentTarget.setPointerCapture(e.pointerId)}} onPointerMove={e=>{if(resize.current)setHeight(Math.max(190,Math.min(window.innerHeight*.55,resize.current.height+resize.current.y-e.clientY)))}} onPointerUp={()=>resize.current=null} onPointerCancel={()=>resize.current=null} onKeyDown={e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();setHeight(h=>Math.max(190,Math.min(window.innerHeight*.55,h+(e.key==='ArrowUp'?20:-20))))}}}/>} 
    <header className="compare-detail-header"><strong>{tr(`差异 ${id} · 局部查看`,`Difference ${id} · Detail`)}</strong>{loading&&<LoaderCircle size={14} className="spin"/>}
      <span>{tr('Ctrl+滚轮缩放 · 可展开查看','Ctrl+wheel zoom · Expand for more room')}</span>
      <button aria-label={tr('缩小详情','Zoom detail out')} onClick={()=>controller.current?.zoomBy(1/1.2)}><Minus size={14}/></button><button onClick={()=>controller.current?.reset()}>{Math.round(zoom*100)}%</button><button aria-label={tr('放大详情','Zoom detail in')} onClick={()=>controller.current?.zoomBy(1.2)}><Plus size={14}/></button>
      <button aria-label={expanded?tr('收起详情','Restore detail dock'):tr('展开详情','Expand details')} onClick={()=>setExpanded(v=>!v)}>{expanded?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button>{expanded&&<button aria-label={tr('退出详情放大','Close expanded details')} onClick={()=>setExpanded(false)}><X size={15}/></button>}
    </header>
    <div ref={viewport} className="compare-detail-viewport" tabIndex={0}><div ref={extent} className="compare-detail-extent"><div ref={paper} className="compare-detail-paper">
      <figure><figcaption>{tr('A · 旧版','A · Old')}</figcaption>{detail&&<img draggable={false} src={detail.a.dataUrl} alt={tr('旧版局部放大','Old drawing detail')}/>}</figure>
      <figure><figcaption>{tr('B · 新版','B · New')}</figcaption>{detail&&<img draggable={false} src={detail.b.dataUrl} alt={tr('新版局部放大','New drawing detail')}/>}</figure>
    </div></div></div>
    <footer><small>{tr('原生局部预览，缩放不改变差异数量。','Native detail preview; zoom does not change analysis counts.')}</small><label><input type="checkbox" checked={reviewed} onChange={e=>onReview(e.target.checked)}/>{tr('已人工复核','Manually reviewed')}</label></footer>
  </section>;
}
