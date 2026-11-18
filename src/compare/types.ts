// SPDX-License-Identifier: MIT OR Apache-2.0
export interface Rect { x:number; y:number; width:number; height:number }
export type ScaleMode='normalized'|'physical';
export interface Options { pageA:number; pageB:number; dpi:number; threshold:number; offsetXmm:number; offsetYmm:number; ignored:Rect[];scaleMode?:ScaleMode }
export interface Picture { dataUrl:string; width:number; height:number }
export interface Source { fileName:string; fileSize:number; pages:{width:number;height:number}[] }
export interface Preview { a:Picture; b:Picture; widthPt:number;heightPt:number;originXPt:number;originYPt:number;uncovered:boolean }
export interface Region { id:number;bounds:Rect;pixels:number;added:number;removed:number;changed:number;point:[number,number] }
export interface Report { jobId:string;options:Options;widthPt:number;heightPt:number;originXPt:number;originYPt:number;pixelWidth:number;pixelHeight:number;changedPixels:number;ignoredPixels:number;uncovered:boolean;regions:Region[];mask:Picture;tileCount:number }
export interface Alignment { options:Options;offsetXmm:number;offsetYmm:number;reliable:boolean;agreement:number;ambiguityMargin:number;reason:string;samples:number }
export interface BatchItem {index:number;options:Options;status:'complete'|'failed';changedPixels:number|null;regionCount:number|null;ignoredPixels:number;uncovered:boolean;error:string|null;alignment:Alignment|null}
export interface BatchSummary {jobId:string;items:BatchItem[];allAnalyzed:boolean;unpairedA:number[];unpairedB:number[]}
export interface TextAssistance {status:'available'|'restricted'|'limited'|'visual-only';changes:{old:string;new:string;dimensionLike:boolean}[];limited:boolean}
export interface Progress { jobId:string;status:'idle'|'running'|'complete'|'cancelled'|'failed';completed:number;total:number;report:Report|null;error:string|null;alignment?:Alignment|null;batch?:BatchSummary|null }
// Rust IPC maps need not retain JavaScript property insertion order.
export const optionsKey=(o:Options)=>JSON.stringify([o.pageA,o.pageB,o.dpi,o.threshold,o.offsetXmm,o.offsetYmm,o.ignored.map(r=>[r.x,r.y,r.width,r.height]),o.scaleMode??'physical']);
export const validRect=(r:Rect)=>!!r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=1.000001&&r.y+r.height<=1.000001;
const count=(n:number)=>Number.isSafeInteger(n)&&n>=0;
export const validOptions=(o:Options)=>!!o&&[o.pageA,o.pageB].every(v=>count(v)&&v<5000)&&[150,300,600].includes(o.dpi)
  &&count(o.threshold)&&o.threshold<=255&&[o.offsetXmm,o.offsetYmm].every(v=>Number.isFinite(v)&&Math.abs(v)<=100)
  &&(o.scaleMode===undefined||['normalized','physical'].includes(o.scaleMode))
  &&Array.isArray(o.ignored)&&o.ignored.length<=16&&o.ignored.every(validRect);
export const validRegion=(v:Region)=>!!v&&count(v.id)&&v.id>0&&validRect(v.bounds)
  &&count(v.pixels)&&v.pixels>0&&[v.added,v.removed,v.changed].every(count)&&v.added+v.removed+v.changed===v.pixels
  &&Array.isArray(v.point)&&v.point.length===2&&v.point.every(p=>Number.isFinite(p)&&p>=0&&p<=1);
export function validateReport(r:Report,jobId:string):Report {
  const ids=new Set<number>();
  if (!r || r.jobId!==jobId || !Array.isArray(r.regions) || r.regions.length>5000 || ![r.widthPt,r.heightPt,r.pixelWidth,r.pixelHeight].every(v=>Number.isFinite(v)&&v>0)
    ||![r.originXPt,r.originYPt].every(Number.isFinite)||!validOptions(r.options)||![r.pixelWidth,r.pixelHeight].every(v=>count(v)&&v<=60000)
    ||r.pixelWidth*r.pixelHeight>600_000_000||!count(r.changedPixels)||!count(r.ignoredPixels)||r.changedPixels+r.ignoredPixels>r.pixelWidth*r.pixelHeight
    || r.regions.some(v=>{if(!validRegion(v)||ids.has(v.id))return true;ids.add(v.id);return false})
    || r.regions.reduce((n,v)=>n+v.pixels,0)!==r.changedPixels ||typeof r.mask?.dataUrl!=='string'||!r.mask.dataUrl.startsWith('data:image/png;base64,')
    ||![r.mask.width,r.mask.height].every(v=>count(v)&&v>0&&v<=4096)||!count(r.tileCount)||r.tileCount<1) throw Error('COMPARE_RESPONSE_INVALID');
  return r;
}
export function detailBounds(region:Region,frame:{widthPt:number;heightPt:number}):Rect {
  const b=region.bounds,side=Math.max(b.width*frame.widthPt,b.height*frame.heightPt,frame.widthPt*.025)*1.5;
  const width=Math.min(1,side/frame.widthPt),height=Math.min(1,side/frame.heightPt);
  return {x:Math.max(0,Math.min(1-width,b.x+b.width/2-width/2)),y:Math.max(0,Math.min(1-height,b.y+b.height/2-height/2)),width,height};
}
export function validateAlignment(a:Alignment):Alignment {
  if(!a||!validOptions(a.options)||typeof a.reliable!=='boolean'||![a.offsetXmm,a.offsetYmm].every(v=>Number.isFinite(v)&&Math.abs(v)<=(a.reliable?100:250))
    ||![a.agreement,a.ambiguityMargin].every(v=>Number.isFinite(v)&&v>=0&&v<=1)||!count(a.samples)||typeof a.reason!=='string')throw Error('COMPARE_RESPONSE_INVALID');
  return a;
}
export function validateBatch(b:BatchSummary,id:string):BatchSummary {
  const seen=new Set<string>();
  if(!b||b.jobId!==id||!Array.isArray(b.items)||!b.items.length||b.items.length>100||typeof b.allAnalyzed!=='boolean'
    ||![b.unpairedA,b.unpairedB].every(v=>Array.isArray(v)&&v.every(p=>count(p)&&p<5000)&&new Set(v).size===v.length)
    ||b.items.some((v,i)=>{if(!v||v.index!==i||!validOptions(v.options))return true;const k=v.options.pageA+':'+v.options.pageB;if(seen.has(k))return true;seen.add(k);
      if(!count(v.ignoredPixels)||typeof v.uncovered!=='boolean')return true;
      if(v.alignment)validateAlignment(v.alignment);
      return v.status==='complete'? !count(v.changedPixels!)||!count(v.regionCount!)||v.regionCount!>5000||v.changedPixels!>600_000_000||(v.changedPixels===0)!==(v.regionCount===0)||v.error!==null
        :v.status!=='failed'||v.changedPixels!==null||v.regionCount!==null||typeof v.error!=='string';})
    ||b.allAnalyzed!==b.items.every(v=>v.status==='complete'))throw Error('COMPARE_RESPONSE_INVALID');
  if(b.items.some(v=>b.unpairedA.includes(v.options.pageA)||b.unpairedB.includes(v.options.pageB)))throw Error('COMPARE_RESPONSE_INVALID');
  return b;
}
export function validateTextAssistance(v:TextAssistance):TextAssistance {
  if(!v||!['available','restricted','limited','visual-only'].includes(v.status)||typeof v.limited!=='boolean'||!Array.isArray(v.changes)||v.changes.length>200
    ||v.changes.some(c=>!c||typeof c.old!=='string'||typeof c.new!=='string'||typeof c.dimensionLike!=='boolean'||c.old.length+c.new.length>100000)
    ||(['restricted','visual-only'].includes(v.status)&&v.changes.length>0))throw Error('COMPARE_RESPONSE_INVALID');return v;
}
