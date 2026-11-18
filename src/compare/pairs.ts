// SPDX-License-Identifier: MIT OR Apache-2.0
import {parsePageRange} from '../pageRanges';
export interface PagePair {a:number;b:number}
export function rangePairs(rangeA:string,rangeB:string,countA:number,countB:number){
  const a=parsePageRange(rangeA,countA,true),b=parsePageRange(rangeB,countB,true),n=Math.min(a.length,b.length);
  if(n<1||n>100)throw Error('PAIR_LIMIT');return {pairs:a.slice(0,n).map((v,i)=>({a:v,b:b[i]})),unmatchedA:a.slice(n),unmatchedB:b.slice(n)};
}
export function validatePairs(pairs:PagePair[],countA:number,countB:number):boolean{
  const seen=new Set<string>();return pairs.length>0&&pairs.length<=100&&pairs.every(p=>{const key=`${p.a}:${p.b}`;if(![p.a,p.b].every(Number.isInteger)||p.a<0||p.b<0||p.a>=countA||p.b>=countB||seen.has(key))return false;seen.add(key);return true});
}
