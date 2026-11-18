// SPDX-License-Identifier: MIT OR Apache-2.0
import {useEffect,useRef,useState} from 'react';
import {compareCall,message} from './client';
import {cachePreview} from './geometry';
import type {Picture,Source} from './types';
export async function decodePictures(pictures:Picture[]){await Promise.all(pictures.map(p=>{if(!p.dataUrl?.startsWith('data:image/png;base64,'))throw Error('COMPARE_PREVIEW_INVALID');const image=new Image();image.src=p.dataUrl;return image.decode()}))}
export function useSourcePreview(side:'a'|'b',source:Source|null,page:number,epoch:number,width:number,blocked:boolean){
  const[state,setState]=useState<{key:string;requested:number;picture:Picture}|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const key=source&&Number.isInteger(page)&&page>=0&&page<source.pages.length?`${epoch}:${page}`:'';
  const cache=useRef(new Map<string,Picture>()),current=useRef(state);current.current=state;
  useEffect(()=>{if(!key){setState(null);setLoading(false);cache.current.clear();return}if(blocked){setLoading(false);return}if(current.current?.key===key&&current.current.requested>=width){setLoading(false);return}
    const cached=cache.current.get(`${key}:${width}`);if(cached){setState({key,requested:width,picture:cached});setLoading(false);return}let dead=false;setLoading(true);setError('');
    const timer=window.setTimeout(()=>{void compareCall<Picture>('page_preview',{side,page,width}).then(async p=>{await decodePictures([p]);if(dead)return;cachePreview(cache.current,`${key}:${width}`,p,v=>v.dataUrl.length);setState({key,requested:width,picture:p})}).catch(e=>{if(!dead)setError(message(e))}).finally(()=>{if(!dead)setLoading(false)})},130);
    return()=>{dead=true;clearTimeout(timer)};
  },[key,width,blocked,side,page]);
  return{picture:state?.key===key?state.picture:null,loading,error};
}
