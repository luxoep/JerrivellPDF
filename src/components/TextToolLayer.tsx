// SPDX-License-Identifier: MIT OR Apache-2.0
import {useRef,useState} from 'react';
import {InlineTextInput} from './InlineTextInput';
import type {TextOverlaySource} from './overlayCanvas';
import type {PageOverlay} from '../types';
import {useI18n} from '../i18n';

export function TextToolLayer({source,pageWidth,pageHeight,disabled,onCommit,onCancel,onEditingChange,onError}: {
  source:TextOverlaySource;pageWidth:number;pageHeight:number;disabled:boolean;
  onCommit:(item:PageOverlay)=>boolean|void;onCancel:()=>void;onEditingChange:(active:boolean)=>void;onError:(message:string)=>void;
}){
  const {t}=useI18n();const root=useRef<HTMLDivElement>(null);
  const drag=useRef<{x:number;y:number;pointer:number}|null>(null);
  const [rectangle,setRectangle]=useState<{x:number;y:number;width:number;height:number}|null>(null),[draft,setDraft]=useState<PageOverlay|null>(null);
  const rect=(clientX:number,clientY:number)=>{
    const box=root.current!.getBoundingClientRect(),start=drag.current!;
    const x=Math.max(0,Math.min(1,(clientX-box.left)/box.width)),y=Math.max(0,Math.min(1,(clientY-box.top)/box.height));
    return {x:Math.min(start.x,x),y:Math.min(start.y,y),width:Math.abs(start.x-x),height:Math.abs(start.y-y)};
  };
  return <div ref={root} className={`page-text-tool-layer ${draft?'editing':''}`} aria-label={t('在 PDF 页面拖出文字框','Draw a text box on the PDF page')}
    onPointerDown={event=>{
      if(disabled||draft||event.button!==0)return;event.preventDefault();event.stopPropagation();
      const box=event.currentTarget.getBoundingClientRect();drag.current={x:Math.max(0,Math.min(1,(event.clientX-box.left)/box.width)),y:Math.max(0,Math.min(1,(event.clientY-box.top)/box.height)),pointer:event.pointerId};
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event=>{if(drag.current?.pointer===event.pointerId)setRectangle(rect(event.clientX,event.clientY));}}
    onPointerUp={event=>{
      if(drag.current?.pointer!==event.pointerId)return;event.preventDefault();event.stopPropagation();
      const next=rect(event.clientX,event.clientY);drag.current=null;setRectangle(null);event.currentTarget.releasePointerCapture(event.pointerId);
      if(next.width*pageWidth<8||next.height*pageHeight<4){onError(t('请拖出有宽度和高度的文字框。','Drag a box with width and height.'));return;}
      const item:PageOverlay={id:crypto.randomUUID(),assetId:'',...next,opacity:1,rotation:0,textSource:{...source,content:'',padding:0,wrapWidth:undefined,frame:{width:Math.max(1,Math.floor(next.width*pageWidth*2)/2),height:Math.max(1,Math.floor(next.height*pageHeight*2)/2),autoHeight:true}}};
      setDraft(item);
    }} onPointerCancel={()=>{drag.current=null;setRectangle(null);}}>
    {rectangle&&<div className="draw-text-rectangle" style={{left:`${rectangle.x*100}%`,top:`${rectangle.y*100}%`,width:`${rectangle.width*100}%`,height:`${rectangle.height*100}%`}}/>}
    {draft&&<InlineTextInput item={draft} pageWidth={pageWidth} pageHeight={pageHeight} isNew onEditingChange={onEditingChange} onError={onError}
      onCommit={item=>{const result=onCommit(item);if(result!==false)setDraft(null);return result;}} onCancel={()=>{setDraft(null);onCancel();}}/>}
  </div>;
}
