// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { getPageText, errorMessage, rasterReference } from '../backend';
import { nearestGlyph, selectedText, wordGlyphRange } from '../textSelection';
import type { PageText } from '../textSelection';
import type { WorkspacePage } from '../types';
import { useI18n } from '../i18n';
import './page-text-layer.css';

export function PageTextLayer({ page, disabled = false }: { page: WorkspacePage; disabled?: boolean }) {
  const { t } = useI18n();
  const [data, setData] = useState<PageText | null>(null), [error, setError] = useState('');
  const [range, setRange] = useState<[number,number] | null>(null), [notice,setNotice]=useState('');
  const root=useRef<HTMLDivElement>(null), drag=useRef<{pointer:number;anchor:number}|null>(null), frame=useRef(0);
  const key=JSON.stringify(rasterReference(page));
  useEffect(() => {
    let alive=true; setData(null);setRange(null);setError('');setNotice('');
    void getPageText(page).then(value=>{if(alive)setData(value);}).catch(reason=>{if(alive)setError(errorMessage(reason));});
    return ()=>{alive=false;cancelAnimationFrame(frame.current);};
  },[key]);
  const point=(x:number,y:number)=>{
    const bounds=root.current?.getBoundingClientRect();
    return data && bounds ? nearestGlyph(data.glyphs,(x-bounds.left)/bounds.width,(y-bounds.top)/bounds.height,bounds.width/bounds.height) : -1;
  };
  const text=data && range ? selectedText(data,...range) : '';
  const copy=async()=>{
    if(!text)return;
    try { await navigator.clipboard.writeText(text);setNotice(t('已复制','Copied')); }
    catch { setNotice(t('请按 Ctrl+C 复制选中文字。','Press Ctrl+C to copy the selection.'));root.current?.focus({preventScroll:true}); }
  };
  const unavailable=error ? t('文字层加载失败，可重新切换选字工具重试。','Text loading failed. Toggle text selection to retry.')
    :data?.status==='restricted'?t(data.reason==='copy-forbidden'?'此 PDF 不允许复制文字。':'无法确认此 PDF 的复制权限，未提取文字。',data.reason==='copy-forbidden'?'This PDF does not allow copying.':'Copy permission could not be verified; no text was extracted.')
    :data?.status==='empty'?t('此页没有可选文字层；扫描图片需先进行 OCR。','No selectable text on this page; scanned images require OCR.')
    :data?.status==='limited'?t('此页文字过多，超过选字预算，请先拆分或裁剪。','This page exceeds the text selection budget; split or crop it first.'):'';
  if(disabled)return null;
  return <div ref={root} tabIndex={0} role="region" aria-label={t('选择 PDF 文字并复制','Select and copy PDF text')} className={`pdf-text-layer ${data?.status==='ready'?'ready':''}`}
    onCopy={event=>{if(text){event.preventDefault();event.stopPropagation();event.clipboardData.setData('text/plain',text);setNotice(t('已复制','Copied'));}}}
    onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'&&data?.glyphs.length){event.preventDefault();event.stopPropagation();setRange([0,data.glyphs.length-1]);}
      if(event.key==='Escape'){event.stopPropagation();setRange(null);setNotice('');}}}
    onPointerDown={event=>{
      if(event.button!==0 || event.target instanceof Element && event.target.closest('button'))return;
      event.preventDefault();event.stopPropagation();root.current?.focus({preventScroll:true});setNotice('');
      if(data?.status!=='ready')return;
      const index=point(event.clientX,event.clientY);if(index<0)return;
      const pageBounds=root.current!.getBoundingClientRect(),glyph=data.glyphs[index].bounds;
      const x=event.clientX-pageBounds.left,y=event.clientY-pageBounds.top;
      const dx=Math.max(glyph.x*pageBounds.width-x,0,x-(glyph.x+glyph.width)*pageBounds.width);
      const dy=Math.max(glyph.y*pageBounds.height-y,0,y-(glyph.y+glyph.height)*pageBounds.height);
      if(Math.hypot(dx,dy)>Math.max(8,glyph.height*pageBounds.height)){setRange(null);return;}
      drag.current={pointer:event.pointerId,anchor:index};setRange([index,index]);event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event=>{
      const gesture=drag.current;if(!gesture || gesture.pointer!==event.pointerId)return;
      const x=event.clientX,y=event.clientY;cancelAnimationFrame(frame.current);
      frame.current=requestAnimationFrame(()=>{const focus=point(x,y);if(drag.current===gesture&&focus>=0)setRange([gesture.anchor,focus]);});
    }}
    onPointerUp={event=>{const gesture=drag.current;if(gesture?.pointer===event.pointerId){cancelAnimationFrame(frame.current);const focus=point(event.clientX,event.clientY);if(focus>=0)setRange([gesture.anchor,focus]);drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}}
    onPointerCancel={()=>{drag.current=null;cancelAnimationFrame(frame.current);}}
    onLostPointerCapture={()=>{drag.current=null;cancelAnimationFrame(frame.current);}}
    onDoubleClick={event=>{if(data?.status==='ready'){event.preventDefault();const index=point(event.clientX,event.clientY);if(index>=0)setRange(wordGlyphRange(data,index));}}}>
    {data && range && <svg className="pdf-text-selection" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><path d={data.glyphs.slice(Math.min(...range),Math.max(...range)+1).map(({bounds:b})=>`M${b.x} ${b.y}h${b.width}v${b.height}h${-b.width}z`).join('')}/></svg>}
    {text && <div className="pdf-text-copy-bar"><button type="button" onPointerDown={event=>event.stopPropagation()} onClick={()=>void copy()}>{t('复制文字','Copy text')}</button><span role="status">{notice || t('Ctrl+C 复制 · Esc 取消选择','Ctrl+C to copy · Esc to clear')}</span></div>}
    {(unavailable || !data && !error) && <span className="pdf-text-note" role="status">{unavailable || t('正在读取文字层…','Loading text…')}</span>}
  </div>;
}
