// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { measureTextFrame } from '../textFrame';
import { inlineRows, rowForOffset, inlineAdvance, nearestInlineOffset } from '../inlineTextGeometry';
import { cssFontFamily, ensureFontReady } from './overlayCanvas';
import type { PageOverlay } from '../types';
import { useI18n } from '../i18n';
import './inline-text-input.css';

export const finishInlineTextEvent = 'jerrivell-finish-inline-text';
/** Local DOM input and measure-only layout; one commit on blur, never per key. */
export function InlineTextInput({ item, pageWidth, pageHeight, isNew = false, onCommit, onCancel, onPreview, onError, onEditingChange }: {
  item: PageOverlay; pageWidth: number; pageHeight: number; isNew?: boolean;
  onCommit: (item: PageOverlay) => boolean | void; onCancel: () => void;
  onPreview?: (item: PageOverlay | null) => void; onError?: (message: string) => void;
  onEditingChange?: (active: boolean) => void;
}) {
  const {t}=useI18n();const source=item.textSource!;
  const [content,setContent]=useState(isNew?'':source.content.replace(/\r\n?/g,'\n')),[scale,setScale]=useState(1),[message,setMessage]=useState(''),[fontRevision,setFontRevision]=useState(0);
  const [selection,setSelection]=useState({start:0,end:0,direction:'none' as 'none'|'forward'|'backward'});
  const selecting=useRef<{pointer:number;anchor:number}|null>(null);
  const affinity=useRef<{offset:number;row:number}|null>(null),hitRow=useRef(0);
  const input=useRef<HTMLTextAreaElement>(null),host=useRef<HTMLDivElement>(null),ended=useRef(false),composing=useRef(false);
  const latest=useRef({content,onCommit,onCancel,onPreview,onError,onEditingChange});latest.current={content,onCommit,onCancel,onPreview,onError,onEditingChange};
  const layout=useMemo(()=>{try{return content.trim()?measureTextFrame({...item,textSource:{...source,content}},pageWidth,pageHeight):null;}catch{return null;}},[item,content,pageWidth,pageHeight,fontRevision]);
  const current=layout?.overlay??item;
  const geometry=useMemo(()=>{
    const context=document.createElement('canvas').getContext('2d');
    if(context)context.font=`${source.italic?'italic ':''}${source.bold?'600':'400'} ${source.fontSize*2}px ${cssFontFamily(source.fontFamily)}`;
    const cache=new Map<string,number>(),measure=(value:string)=>{if(!cache.has(value))cache.set(value,(context?.measureText(value).width??0)/2);return cache.get(value)!;};
    const lines=layout?.layoutLines??[{text:content,x:source.padding??0,y:source.fontSize*.85,width:0}];
    return {rows:inlineRows(content,lines),measure};
  },[content,layout,source.fontFamily,source.fontSize,source.bold,source.italic,source.padding,fontRevision]);
  const focusOffset=selection.direction==='backward'?selection.start:selection.end;
  const caretRowIndex=Math.min(geometry.rows.length-1,affinity.current?.offset===focusOffset?affinity.current.row:rowForOffset(geometry.rows,focusOffset));
  const caretRow=geometry.rows[caretRowIndex];
  const caretX=caretRow.x+inlineAdvance(caretRow,focusOffset,geometry.measure,source.charSpacing??0),caretY=caretRow.y;
  const setCaret=(anchor:number,focus:number,rowHint?:number)=>{
    const start=Math.max(0,Math.min(content.length,Math.min(anchor,focus))),end=Math.max(0,Math.min(content.length,Math.max(anchor,focus)));
    affinity.current=rowHint===undefined?null:{offset:focus,row:rowHint};
    setSelection({start,end,direction:focus<anchor?'backward':'forward'});input.current?.focus({preventScroll:true});input.current?.setSelectionRange(start,end,focus<anchor?'backward':'forward');
  };
  const hit=(clientX:number,clientY:number)=>{
    const box=host.current!.getBoundingClientRect(),angle=(item.rotation??0)*Math.PI/180;
    const dx=(clientX-(box.left+box.width/2))/scale,dy=(clientY-(box.top+box.height/2))/scale;
    const quarter=(item.rotation??0)%180!==0;
    const width=quarter?current.height*pageHeight:current.width*pageWidth,height=quarter?current.width*pageWidth:current.height*pageHeight;
    const x=dx*Math.cos(angle)+dy*Math.sin(angle)+width/2,y=-dx*Math.sin(angle)+dy*Math.cos(angle)+height/2;
    let row=geometry.rows[0],distance=Infinity;
    geometry.rows.forEach((candidate,index)=>{const next=Math.abs(candidate.y-source.fontSize*.4-y);if(next<distance){distance=next;row=candidate;hitRow.current=index;}});
    return nearestInlineOffset(row,x,geometry.measure,source.charSpacing??0);
  };
  useLayoutEffect(()=>{const field=input.current;if(field){if(!composing.current)field.setSelectionRange(selection.start,selection.end,selection.direction);field.scrollLeft=0;field.scrollTop=0;}},[content,selection,layout,scale]);
  const reported=useRef(false);const report=(active:boolean)=>{if(reported.current!==active){reported.current=active;latest.current.onEditingChange?.(active);}};
  useLayoutEffect(()=>{
    const page=host.current?.closest('.pdf-sheet');if(!page)return;
    const resize=()=>{const ratio=page.getBoundingClientRect().width/pageWidth;if(ratio>0)setScale(previous=>Math.abs(previous-ratio)<.0001?previous:ratio);};
    resize();const observer=new ResizeObserver(resize);observer.observe(page);return()=>observer.disconnect();
  },[pageWidth]);
  useEffect(()=>{let alive=true;void ensureFontReady(source.fontFamily,content||'Aa 中文',source.bold,source.italic).then(()=>{if(alive)setFontRevision(value=>value+1);}).catch(()=>{if(alive)setMessage(t('字体未就绪，请稍后完成编辑。','Font is not ready; finish editing after it loads.'));});return()=>{alive=false;};},[source.fontFamily,source.bold,source.italic]);
  useLayoutEffect(()=>{ended.current=false;report(true);input.current?.focus({preventScroll:true});return()=>{latest.current.onPreview?.(null);report(false);};},[]);
  useEffect(()=>{onPreview?.({...current,opacity:0});},[current,onPreview]);
  const finish=(cancel=false,autoHeight=false)=>{
    if(ended.current)return true;
    if(composing.current && !cancel)return false;
    const live=latest.current;
    if(cancel || !live.content.trim()&&isNew){ended.current=true;report(false);live.onPreview?.(null);live.onCancel();return true;}
    let next:PageOverlay;
    try {
      if(!live.content.trim())throw Error('empty');
      const measured=measureTextFrame({...item,textSource:{...source,content:live.content,...(autoHeight&&source.frame?{frame:{...source.frame,autoHeight:true}}:{})}},pageWidth,pageHeight);
      if(measured.overflow)throw Error('overflow');next=measured.overlay;
    }catch{
      const reason=t('文字放不下或为空，草稿已保留。请调整内容、字号，或选择自动加高。','Text is empty or does not fit; the draft is retained. Adjust it or choose auto height.');
      setMessage(reason);live.onError?.(reason);requestAnimationFrame(()=>input.current?.focus({preventScroll:true}));return false;
    }
    let accepted=true;flushSync(()=>{accepted=live.onCommit(next)!==false;});
    if(!accepted){setMessage(t('未能保存此修改，草稿已保留。','Could not save the change; the draft is retained.'));requestAnimationFrame(()=>input.current?.focus({preventScroll:true}));return false;}
    ended.current=true;report(false);live.onPreview?.(null);return true;
  };
  const finishRef=useRef(finish);finishRef.current=finish;
  useEffect(()=>{const listener=()=>{finishRef.current();};window.addEventListener(finishInlineTextEvent,listener);return()=>window.removeEventListener(finishInlineTextEvent,listener);},[]);
  const angle=item.rotation??0,quarter=angle%180!==0;
  const w=(quarter?current.height*pageHeight:current.width*pageWidth),h=(quarter?current.width*pageWidth:current.height*pageHeight);
  const font=source.fontSize,lineHeight=font*(source.lineHeight??1.45);
  // Match the first Canvas glyph baseline, rather than add the old 8pt inset.
  const baseline=useMemo(()=>{
    const context=document.createElement('canvas').getContext('2d');if(!context)return font;
    context.font=`${source.italic?'italic ':''}${source.bold?'600':'400'} ${font}px ${cssFontFamily(source.fontFamily)}`;
    const metrics=context.measureText(content.split('\n')[0]||'Mg');
    const ascent=metrics.fontBoundingBoxAscent??font*.9,descent=metrics.fontBoundingBoxDescent??font*.25;
    return (lineHeight-ascent-descent)/2+ascent;
  },[font,lineHeight,source.fontFamily,source.bold,source.italic,content,fontRevision]);
  const prefix=content.slice(0,focusOffset),paragraphs=prefix.split('\n'),paragraphPrefix=paragraphs.at(-1)??'';
  // Keep the hidden native input's IME anchor at the visible renderer caret.
  // Native text remains unchanged, preserving clipboard, undo and composition.
  const nativePrefix=geometry.measure(paragraphPrefix)+Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(paragraphPrefix)).length*(source.charSpacing??0);
  return <div ref={host} className={`inline-page-text ${layout?.overflow?'overflow':''}`} data-inline-text-edit
    style={{position:'absolute',left:`${(current.x+current.width/2)*100}%`,top:`${(current.y+current.height/2)*100}%`,width:w*scale,height:h*scale,transform:`translate(-50%,-50%) rotate(${angle}deg)`}}
    onPointerDown={event=>{event.stopPropagation();if(event.button!==0||(event.target as Element).closest('.inline-text-actions'))return;event.preventDefault();const offset=hit(event.clientX,event.clientY);selecting.current={pointer:event.pointerId,anchor:offset};setCaret(offset,offset,hitRow.current);event.currentTarget.setPointerCapture(event.pointerId);}}
    onPointerMove={event=>{if(selecting.current?.pointer===event.pointerId){event.preventDefault();setCaret(selecting.current.anchor,hit(event.clientX,event.clientY),hitRow.current);}}}
    onPointerUp={event=>{if(selecting.current?.pointer===event.pointerId){setCaret(selecting.current.anchor,hit(event.clientX,event.clientY),hitRow.current);selecting.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}}
    onPointerCancel={()=>{selecting.current=null;}}
    onDoubleClick={event=>{event.preventDefault();event.stopPropagation();const offset=hit(event.clientX,event.clientY),segments=Array.from(new Intl.Segmenter(undefined,{granularity:'word'}).segment(content));const word=segments.find(value=>offset>=value.index&&offset<value.index+value.segment.length);if(word)setCaret(word.index,word.index+word.segment.length);}}>
    <svg className="inline-rendered-text" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {geometry.rows.map((row,index)=>{
        const start=Math.max(row.start,selection.start),end=Math.min(row.end,selection.end);
        const x=row.x+inlineAdvance(row,start,geometry.measure,source.charSpacing??0),right=row.x+inlineAdvance(row,end,geometry.measure,source.charSpacing??0);
        return <g key={index}>{end>start&&<rect x={x} y={row.y-font*.9} width={Math.max(.5,right-x)} height={font*1.2} fill="#8bb4d2" opacity=".45"/>}
          <text data-inline-text-row x={row.x} y={row.y} fill={source.color} fontFamily={cssFontFamily(source.fontFamily)} fontSize={font} fontWeight={source.bold?600:400} fontStyle={source.italic?'italic':'normal'} letterSpacing={source.charSpacing??0} xmlSpace="preserve">{row.text}</text>
          {source.underline&&<path d={`M${row.decorationX??row.x} ${row.y+font*.1}h${row.width}`} stroke={source.color} strokeWidth={Math.max(.5,font/18)}/>}
          {source.strikeout&&<path d={`M${row.decorationX??row.x} ${row.y-font*.33}h${row.width}`} stroke={source.color} strokeWidth={Math.max(.5,font/18)}/>}</g>;
      })}
      {!content&&<text x={0} y={font*.85} fill="#8997a0" fontSize={font} fontFamily={cssFontFamily(source.fontFamily)}>{t('输入文字…','Type here…')}</text>}
      {selection.start===selection.end&&<path className="inline-text-caret" d={`M${Math.max(.3,Math.min(w-.3,caretX))} ${caretY-font*.9}v${font*1.1}`} stroke="#294e66" strokeWidth={1/scale}/>}
    </svg>
    <div className="inline-text-clip"><textarea ref={input} wrap="off" aria-label={t('直接编辑文字','Edit text in place')} maxLength={4000} value={content}
      style={{fontFamily:cssFontFamily(source.fontFamily),fontSize:font*scale,fontWeight:source.bold?600:400,fontStyle:source.italic?'italic':'normal',lineHeight:`${lineHeight*scale}px`,letterSpacing:(source.charSpacing??0)*scale,textAlign:'left',color:'transparent',caretColor:'transparent',
        left:(caretX-nativePrefix)*scale,top:(caretY-baseline-(paragraphs.length-1)*lineHeight)*scale,width:Math.max(w,nativePrefix+font*5)*scale,height:Math.max(h,(content.split('\n').length+1)*lineHeight)*scale}}
      onSelect={event=>{const field=event.currentTarget;setSelection(previous=>previous.start===field.selectionStart&&previous.end===field.selectionEnd&&previous.direction===field.selectionDirection?previous:{start:field.selectionStart,end:field.selectionEnd,direction:field.selectionDirection});}}
      onChange={event=>{affinity.current=null;const field=event.target;setSelection({start:field.selectionStart,end:field.selectionEnd,direction:field.selectionDirection});setContent(field.value);setMessage('');}} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={event=>{composing.current=false;const field=event.currentTarget;setSelection({start:field.selectionStart,end:field.selectionEnd,direction:field.selectionDirection});setContent(field.value);}}
      onBlur={()=>{finish();}} onKeyDown={event=>{
        const modifier=event.ctrlKey||event.metaKey;
        if(modifier&&['s','o','p','w'].includes(event.key.toLowerCase())){if(!finish()){event.preventDefault();event.stopPropagation();}return;}
        event.stopPropagation();if(event.nativeEvent.isComposing||composing.current)return;
        if(!['ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))affinity.current=null;
        if(!modifier&&['ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)){
          event.preventDefault();const rowIndex=caretRowIndex;
          const targetRow=Math.max(0,Math.min(geometry.rows.length-1,rowIndex+(['ArrowUp','PageUp'].includes(event.key)?-1:1)*(event.key.startsWith('Page')?10:1)));
          const target=event.key==='Home'?caretRow.start:event.key==='End'?caretRow.end:nearestInlineOffset(geometry.rows[targetRow],caretX,geometry.measure,source.charSpacing??0);
          const anchor=event.shiftKey?(selection.direction==='backward'?selection.end:selection.start):target;setCaret(anchor,target,['Home','End'].includes(event.key)?rowIndex:targetRow);return;
        }
        if(event.key==='Escape'){event.preventDefault();finish(true);}else if(event.key==='Enter'&&modifier){event.preventDefault();finish();}
      }}/></div>
    <div className="inline-text-actions" onPointerDown={event=>event.preventDefault()}><span>{message||t('点击框外完成 · Ctrl+Enter 完成 · Esc 取消','Click outside to finish · Ctrl+Enter · Esc cancels')}</span>{layout?.overflow&&<button type="button" onClick={()=>finish(false,true)}>{t('自动加高并完成','Auto-height and finish')}</button>}</div>
  </div>;
}
