// SPDX-License-Identifier: MIT OR Apache-2.0
import type {Options,Rect,Source} from './types';
export interface Frame {widthPt:number;heightPt:number;originXPt:number;originYPt:number;uncovered:boolean;a?:Rect;b?:Rect}
export function comparisonFrame(a:Source|null,b:Source|null,pageA:number,pageB:number,xMm:number,yMm:number):Frame|null{
  const pa=a?.pages[pageA],pb=b?.pages[pageB];if(!pa&&!pb)return null;
  const dx=pa&&pb?xMm*72/25.4:0,dy=pa&&pb?yMm*72/25.4:0,x=pa&&pb?Math.min(0,dx):0,y=pa&&pb?Math.min(0,dy):0;
  const widthPt=Math.max(pa?.width??0,dx+(pb?.width??0))-x,heightPt=Math.max(pa?.height??0,dy+(pb?.height??0))-y;
  return{widthPt,heightPt,originXPt:x,originYPt:y,uncovered:!!(pa&&pb&&(Math.abs(pa.width-pb.width)>.001||Math.abs(pa.height-pb.height)>.001||Math.abs(dx)>.001||Math.abs(dy)>.001)),
    a:pa?{x:-x/widthPt,y:-y/heightPt,width:pa.width/widthPt,height:pa.height/heightPt}:undefined,
    b:pb?{x:(dx-x)/widthPt,y:(dy-y)/heightPt,width:pb.width/widthPt,height:pb.height/heightPt}:undefined};
}
export function sheetGeometry(frame:Frame|null,side:'a'|'b'|'mix',unified:boolean,width:number,height:number,zoom:number){
  const rect=unified&&side!=='mix'&&frame?.[side]?frame[side]!:{x:0,y:0,width:1,height:1};
  const aspect=frame?frame.heightPt*rect.height/(frame.widthPt*rect.width):1.414;
  const fitted=Math.max(80,Math.min(Math.max(80,width-40),Math.max(80,height-40)/aspect));
  return{rect,width:fitted*zoom,height:fitted*zoom*aspect};
}
export function pointInFrame(rect:Rect,x:number,y:number){return{x:rect.x+x*rect.width,y:rect.y+y*rect.height}}
export function cachePreview<T>(cache:Map<string,T>,key:string,value:T,size:(v:T)=>number,entries=4){
  cache.delete(key);cache.set(key,value);let bytes=Array.from(cache.values()).reduce((n,v)=>n+size(v),0);
  while(cache.size>entries||bytes>32*1024*1024){const k=cache.keys().next().value!;bytes-=size(cache.get(k)!);cache.delete(k)}
}
export const pairOptions=(o:Options,a:number,b:number):Options=>({...o,pageA:a,pageB:b,ignored:[]});
