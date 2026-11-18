// SPDX-License-Identifier: MIT OR Apache-2.0
export interface Rect { x:number; y:number; width:number; height:number }
export interface Options { pageA:number; pageB:number; dpi:number; threshold:number; offsetXmm:number; offsetYmm:number; ignored:Rect[] }
export interface Picture { dataUrl:string; width:number; height:number }
export interface Source { fileName:string; fileSize:number; pages:{width:number;height:number}[] }
export interface Preview { a:Picture; b:Picture; widthPt:number;heightPt:number;originXPt:number;originYPt:number;uncovered:boolean }
export interface Region { id:number;bounds:Rect;pixels:number;added:number;removed:number;changed:number;point:[number,number] }
export interface Report { jobId:string;options:Options;widthPt:number;heightPt:number;originXPt:number;originYPt:number;pixelWidth:number;pixelHeight:number;changedPixels:number;ignoredPixels:number;uncovered:boolean;regions:Region[];mask:Picture;tileCount:number }
export interface Progress { jobId:string;status:'idle'|'running'|'complete'|'cancelled'|'failed';completed:number;total:number;report:Report|null;error:string|null }
// Rust IPC maps need not retain JavaScript property insertion order.
export const optionsKey=(o:Options)=>JSON.stringify([o.pageA,o.pageB,o.dpi,o.threshold,o.offsetXmm,o.offsetYmm,o.ignored.map(r=>[r.x,r.y,r.width,r.height])]);
export const validRect=(r:Rect)=>!!r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=1.000001&&r.y+r.height<=1.000001;
const count=(n:number)=>Number.isSafeInteger(n)&&n>=0;
const validOptions=(o:Options)=>!!o&&[o.pageA,o.pageB].every(v=>count(v)&&v<5000)&&[150,300,600].includes(o.dpi)
  &&count(o.threshold)&&o.threshold<=255&&[o.offsetXmm,o.offsetYmm].every(v=>Number.isFinite(v)&&Math.abs(v)<=100)
  &&Array.isArray(o.ignored)&&o.ignored.length<=16&&o.ignored.every(validRect);
export function validateReport(r:Report,jobId:string):Report {
  const ids=new Set<number>();
  if (!r || r.jobId!==jobId || !Array.isArray(r.regions) || r.regions.length>5000 || ![r.widthPt,r.heightPt,r.pixelWidth,r.pixelHeight].every(v=>Number.isFinite(v)&&v>0)
    ||![r.originXPt,r.originYPt].every(Number.isFinite)||!validOptions(r.options)||![r.pixelWidth,r.pixelHeight].every(v=>count(v)&&v<=60000)
    ||r.pixelWidth*r.pixelHeight>600_000_000||!count(r.changedPixels)||!count(r.ignoredPixels)||r.changedPixels+r.ignoredPixels>r.pixelWidth*r.pixelHeight
    || r.regions.some(v=>{if(!v||!count(v.id)||v.id<1||ids.has(v.id))return true;ids.add(v.id);return !validRect(v.bounds)
      ||!count(v.pixels)||v.pixels<1||![v.added,v.removed,v.changed].every(count)||v.added+v.removed+v.changed!==v.pixels
      ||!Array.isArray(v.point)||v.point.length!==2||v.point.some(p=>!Number.isFinite(p)||p<0||p>1)})
    || r.regions.reduce((n,v)=>n+v.pixels,0)!==r.changedPixels ||typeof r.mask?.dataUrl!=='string'||!r.mask.dataUrl.startsWith('data:image/png;base64,')
    ||![r.mask.width,r.mask.height].every(v=>count(v)&&v>0&&v<=4096)||!count(r.tileCount)||r.tileCount<1) throw Error('COMPARE_RESPONSE_INVALID');
  return r;
}
export function detailBounds(region:Region,frame:{widthPt:number;heightPt:number}):Rect {
  const b=region.bounds,side=Math.max(b.width*frame.widthPt,b.height*frame.heightPt,frame.widthPt*.025)*1.5;
  const width=Math.min(1,side/frame.widthPt),height=Math.min(1,side/frame.heightPt);
  return {x:Math.max(0,Math.min(1-width,b.x+b.width/2-width/2)),y:Math.max(0,Math.min(1-height,b.y+b.height/2-height/2)),width,height};
}
