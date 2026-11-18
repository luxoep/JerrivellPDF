// SPDX-License-Identifier: MIT OR Apache-2.0
import type { TextLayoutLine } from './components/overlayCanvas';
export interface InlineRow extends TextLayoutLine { start: number; end: number; stops: number[] }
/** Index the exact renderer rows. Soft wraps never become document characters. */
export function inlineRows(content: string, lines: TextLayoutLine[]): InlineRow[] {
  let cursor=0;
  return lines.map(line=>{
    const start=cursor;cursor+=line.text.length;
    const stops=[0];let offset=0;
    for(const value of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(line.text)){offset+=value.segment.length;stops.push(offset);}
    const row={...line,start,end:cursor,stops};if(content[cursor]==='\n')cursor++;
    return row;
  });
}
export function rowForOffset(rows: InlineRow[], offset: number): number {
  let result=0;rows.forEach((row,index)=>{if(offset>=row.start)result=index;});return result;
}
export function inlineAdvance(row: InlineRow, offset: number, measure: (text:string)=>number, spacing:number):number {
  const end=Math.max(0,Math.min(row.text.length,offset-row.start));
  const count=row.stops.filter(stop=>stop>0&&stop<=end).length;
  return measure(row.text.slice(0,end))+Math.max(0,count-(end===row.text.length?1:0))*spacing;
}
export function nearestInlineOffset(row: InlineRow, x: number, measure:(text:string)=>number,spacing:number):number {
  let best=row.start,distance=Infinity;
  for(const stop of row.stops){const candidate=row.start+stop,next=Math.abs(row.x+inlineAdvance(row,candidate,measure,spacing)-x);if(next<distance){distance=next;best=candidate;}}
  return best;
}
