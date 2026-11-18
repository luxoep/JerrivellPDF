// SPDX-License-Identifier: MIT OR Apache-2.0
import {useMemo,useState,useRef,useCallback} from 'react';
import {Plus,Trash2,X} from 'lucide-react';
import {useDialogFocus} from './useDialogFocus';
import {rangePairs,validatePairs} from './pairs';
import type {PagePair} from './pairs';
type Tr=(zh:string,en:string)=>string;
export function BatchDialog({countA,countB,tr,onClose,onStart}:{countA:number;countB:number;tr:Tr;onClose:()=>void;onStart:(pairs:PagePair[],automatic:boolean)=>void}){
  const dialog=useRef<HTMLElement>(null),close=useRef(onClose);close.current=onClose;const dismiss=useCallback(()=>close.current(),[]);useDialogFocus(dialog,true,dismiss);
  const[rangeA,setRangeA]=useState(''),[rangeB,setRangeB]=useState(''),[rows,setRows]=useState<{a:string;b:string}[]>([]),[error,setError]=useState(''),[automatic,setAutomatic]=useState(false);
  const pairs=useMemo(()=>rows.map(v=>({a:v.a.trim()?Number(v.a)-1:NaN,b:v.b.trim()?Number(v.b)-1:NaN})),[rows]);const valid=validatePairs(pairs,countA,countB);
  const generate=()=>{try{const p=rangePairs(rangeA,rangeB,countA,countB);setRows(p.pairs.map(v=>({a:String(v.a+1),b:String(v.b+1)})));setError(p.unmatchedA.length||p.unmatchedB.length?tr('选择范围页数不等，未配对页面会明确列在结果中。','Selected ranges have different counts. Unpaired pages will be listed.'): '')}catch{setError(tr('请输入有效页码范围；每次最多 100 组。','Enter valid page ranges; up to 100 pairs per run.'))}};
  return <div className="modal-backdrop"><section ref={dialog} className="modal compare-batch-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-heading"><header><h2 id="batch-heading">{tr('多页配对与批量对比','Multi-page pairing and comparison')}</h2><button aria-label={tr('关闭多页配对','Close page pairing')} onClick={onClose}><X size={18}/></button></header>
    <p>{tr('按选定范围顺序配对，支持逐组修改。不自动拉伸图纸；未配对页单独列出。','Pair selected ranges in page order, then edit individual pairs. Paper is never stretched; unpaired pages are listed.')}</p>
    <div className="compare-batch-ranges"><label>A {tr('页码范围','page range')}<input aria-label={tr('A 批量页码范围','A batch page range')} placeholder={tr(`留空表示全部 ${countA} 页`,`Blank = all ${countA} pages`)} value={rangeA} onChange={e=>setRangeA(e.target.value)}/></label><label>B {tr('页码范围','page range')}<input aria-label={tr('B 批量页码范围','B batch page range')} placeholder={tr(`留空表示全部 ${countB} 页`,`Blank = all ${countB} pages`)} value={rangeB} onChange={e=>setRangeB(e.target.value)}/></label><button className="button secondary" onClick={generate}>{tr('生成配对','Generate pairs')}</button><button className="button secondary" disabled={rows.length>=100} onClick={()=>setRows(v=>[...v,{a:'',b:''}])}><Plus size={14}/>{tr('添加一组','Add pair')}</button></div>
    {error&&<p role="status" className="compare-batch-warning">{error}</p>}
    <div className="compare-pair-list">{!rows.length?<p>{tr('点击“生成配对”开始，也可以手动添加。','Generate pairs to begin, or add pairs manually.')}</p>:rows.map((r,i)=><div key={i}><span>{i+1}</span><label>A<input inputMode="numeric" aria-label={`A ${tr('配对','pair')} ${i+1}`} value={r.a} onChange={e=>setRows(v=>v.map((p,j)=>i===j?{...p,a:e.target.value}:p))}/></label><span>↔</span><label>B<input inputMode="numeric" aria-label={`B ${tr('配对','pair')} ${i+1}`} value={r.b} onChange={e=>setRows(v=>v.map((p,j)=>i===j?{...p,b:e.target.value}:p))}/></label><button aria-label={tr(`删除配对 ${i+1}`,`Remove pair ${i+1}`)} onClick={()=>setRows(v=>v.filter((_,j)=>j!==i))}><Trash2 size={14}/></button></div>)}</div>
    <label className="compare-batch-auto"><input type="checkbox" checked={automatic} onChange={e=>setAutomatic(e.target.checked)}/>{tr('逐页尝试自动平移配准；不可靠的配对记录为失败','Try automatic translation for each pair; unreliable matches are marked as failed')}</label>
    <small>{tr('采用当前 DPI/容差；不沿用单页忽略区域。总预算 12 亿像素，最多 100 组。','Uses current DPI/tolerance; single-page exclusions are not reused. Up to 100 pairs and 1.2 billion estimated pixels.')}</small>
    <footer><span>{rows.length} {tr('组','pairs')}{rows.length&&!valid?tr(' · 请检查空值、重复和超出范围的页码',' · Check blank, duplicate or out-of-range pages'):''}</span><button className="button secondary" onClick={onClose}>{tr('取消','Cancel')}</button><button className="button primary" disabled={!valid} onClick={()=>onStart(pairs,automatic)}>{tr('开始批量对比','Start batch comparison')}</button></footer>
  </section></div>;
}
