// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
let paints=[],surfaces=[];
const document={createElement(){const context={font:'',measureText(text){const size=Number(this.font.match(/([\d.]+)px/)?.[1]??24);const trimmed=text.trim();const indent=(text.length-text.trimStart().length)*size*.4;const width=[...text].length*size*.6;return{width,actualBoundingBoxLeft:trimmed?size*.1-indent:0,actualBoundingBoxRight:trimmed?width+size*.08:0,actualBoundingBoxAscent:size*.78,actualBoundingBoxDescent:/[gjpq]/.test(text)?size*.24:0};},fillText(text,x,y){paints.push({text,x,y,metric:this.measureText(text)});},beginPath(){},moveTo(){},lineTo(){},stroke(){}};const canvas={width:1,height:1,getContext:()=>context,toDataURL:()=> 'data:image/png;base64,fixture'};surfaces.push(canvas);return canvas;}};
function load(path,require=()=>{}){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require,document,Intl});return exports;}
const canvas=load('../src/components/overlayCanvas.ts'),geometry=load('../src/overlayGeometry.ts');
const frame=load('../src/textFrame.ts',name=>name==='./overlayGeometry'?geometry:canvas);
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} / ${b}`);
const legacy=canvas.createTextPng('123','#123456',24,false,'Arial',{});paints=[];
const compact=canvas.createTextPng('123','#123456',24,false,'Arial',{padding:0});
assert.ok(compact.height<legacy.height*.6,'Tight glyph metrics remove the old padding/line-box slack');
const glyph=paints[0];near(glyph.x-glyph.metric.actualBoundingBoxLeft,0);near(glyph.y-glyph.metric.actualBoundingBoxAscent,0);
assert.ok(glyph.x+glyph.metric.actualBoundingBoxRight<=compact.width);assert.ok(glyph.y+glyph.metric.actualBoundingBoxDescent<=compact.height);
const inset=canvas.createTextPng('123','#123456',24,false,'Arial',{padding:2});near(inset.layoutLines[0].x-compact.layoutLines[0].x,2);near(inset.layoutLines[0].y-compact.layoutLines[0].y,2);
const style=canvas.createTextPng('jÁ国\ngpq','#123456',24,true,'Arial',{padding:0,italic:true,underline:true,strikeout:true,charSpacing:1,lineHeight:1.1});assert.equal(style.lineCount,2);assert.ok(style.requiredHeight>compact.requiredHeight);
const source={content:'123',fontSize:24,color:'#123456',bold:false,fontFamily:'Arial',frame:{width:180,height:60,autoHeight:true}};
const old={id:'text',assetId:'asset',x:.2,y:.2,width:.3,height:.075,opacity:1,textSource:source};const before=JSON.stringify(old);
for(const rotation of [0,90,180,270]){const item={...old,rotation,...(rotation%180?{width:.1,height:.225}:{})};const first=frame.measureTextFrame(item,600,800),fit=frame.fitTextFrame(item,600,800),after=frame.measureTextFrame(fit,600,800);assert.equal(fit.textSource.padding,0);assert.equal(fit.textSource.fontSize,24);assert.ok(fit.textSource.frame.width<180);const anchor=(layout)=>{const o=layout.overlay,line=layout.layoutLines[0],q=rotation%180,w=q?o.height*800:o.width*600,h=q?o.width*600:o.height*800,a=rotation*Math.PI/180;return[(o.x+o.width/2)*600+(line.x-w/2)*Math.cos(a)-(line.y-h/2)*Math.sin(a),(o.y+o.height/2)*800+(line.x-w/2)*Math.sin(a)+(line.y-h/2)*Math.cos(a)];};anchor(first).forEach((n,i)=>near(n,anchor(after)[i]));}
assert.equal(JSON.stringify(old),before,'Fitting must preserve undo/source snapshots');
const edge=frame.measureTextFrame({...old,x:0,y:0,textSource:{...source,padding:0}},600,800);assert.equal(edge.overflow,false);assert.equal(edge.overlay.x,0);assert.equal(edge.overlay.y,0);
const tiny=canvas.createTextPng('1','#123456',6,false,'Arial',{padding:0,frame:{width:8,height:6,autoHeight:true}});assert.ok(tiny.requiredHeight<12,'A small glyph no longer has a mandatory 12pt frame');
for(const padding of [-1,25,NaN])assert.throws(()=>canvas.createTextPng('123','#123456',24,false,'Arial',{padding}),/TEXT_LAYOUT_LIMIT/);
console.log('PASS: zero/custom padding, actual glyph bounds and decorations, compact frames, all-rotation fit preserving text baseline, page-edge positioning and immutable legacy sources');
