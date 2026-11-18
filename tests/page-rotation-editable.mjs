// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports });
  return exports;
}
const operations = load('../src/pageOperations.ts'), marks = load('../src/markGeometry.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const font = { content: '标注尺寸 / label', fontFamily: 'Arial', fontSize: 12, color: '#324f69', bold: false,
  charSpacing: .5, lineHeight: 1.4, frame: { width: 180, height: 60, autoHeight: false } };
for (const startingRotation of [0,90,180,270]) {
  const pageWidth = startingRotation % 180 === 90 ? 800 : 600, pageHeight = startingRotation % 180 === 90 ? 600 : 800;
  const geometry = marks.createMarkGeometry([{x:.1,y:.7},{x:.45,y:.22},{x:.55,y:.22}], {tool:'callout',color:'#324f69',opacity:.8,lineWidth:3,lineStyle:'dashDotDot',arrowHeads:'start'},pageWidth,pageHeight);
  const text = {id:'text',assetId:'text-image',x:.55,y:.18,width:180/pageWidth,height:60/pageHeight,rotation:0,opacity:.8,textSource:font};
  const leader = {id:'leader',assetId:'leader-image',...geometry.bounds,rotation:0,opacity:.8,leaderFor:'text',markSource:{color:'#324f69',geometry}};
  const shapeGeometry = marks.createMarkGeometry([{x:.05,y:.15},{x:.22,y:.32}], {tool:'rectangle',color:'#456789',opacity:1,lineWidth:2},pageWidth,pageHeight);
  const shape = {id:'box',assetId:'box-image',...shapeGeometry.bounds,rotation:90,opacity:.6,locked:true,markSource:{color:'#456789',geometry:shapeGeometry}};
  const page = {id:'page',documentId:'fixture',pageIndex:0,width:600,height:800,rotation:startingRotation,sourceName:'fixture.pdf',overlays:[text,leader,shape]};
  const saved = JSON.stringify(page), rotated = operations.rotatePageClockwise(page);
  assert.equal(rotated.rotation,(startingRotation+90)%360); assert.equal(rotated.width,600);assert.equal(rotated.height,800);
  const newText = rotated.overlays[0], newLeader = rotated.overlays[1];
  near(newText.x,1-text.y-text.height);near(newText.y,text.x);near(newText.width,text.height);near(newText.height,text.width);
  assert.equal(newText.rotation,90);assert.equal(newText.assetId,text.assetId);assert.deepEqual(plain(newText.textSource),plain(font));
  assert.equal(newLeader.leaderFor,text.id);assert.equal(newLeader.assetId,leader.assetId);assert.equal(newLeader.rotation,90);
  assert.equal(newLeader.markSource.geometry.pageWidth,pageHeight);assert.equal(newLeader.markSource.geometry.pageHeight,pageWidth);
  assert.equal(newLeader.markSource.geometry.lineWidth,3);assert.equal(newLeader.markSource.geometry.lineStyle,'dashDotDot');
  assert.equal(newLeader.markSource.geometry.arrowHeads,'start');
  for(let i=0;i<geometry.points.length;i++) {
    const old=geometry.points[i],next=newLeader.markSource.geometry.points[i];
    near(next.x,1-old.y);near(next.y,old.x);
    near(next.x*pageHeight,pageHeight-old.y*pageHeight);near(next.y*pageWidth,old.x*pageWidth);
    // Rotating the old raster's local point clockwise has exactly the same
    // normalized visible placement as the editable path source.
    const oldU=(old.x-leader.x)/leader.width,oldV=(old.y-leader.y)/leader.height;
    near(next.x,newLeader.x+(1-oldV)*newLeader.width);near(next.y,newLeader.y+oldU*newLeader.height);
  }
  assert.deepEqual(plain(newLeader.markSource.geometry.bounds),plain({x:newLeader.x,y:newLeader.y,width:newLeader.width,height:newLeader.height}));
  assert.equal(rotated.overlays[2].locked,true);assert.equal(rotated.overlays[2].rotation,180);
  let full=page;for(let turn=0;turn<4;turn++)full=operations.rotatePageClockwise(full);
  assert.equal(full.rotation,page.rotation);
  for(let i=0;i<page.overlays.length;i++) {
    const before=page.overlays[i],after=full.overlays[i];
    for(const key of ['x','y','width','height'])near(after[key],before[key]);
    assert.equal(after.rotation,before.rotation);assert.equal(after.assetId,before.assetId);assert.equal(after.leaderFor,before.leaderFor);
    if(before.markSource) {
      assert.equal(after.markSource.geometry.pageWidth,pageWidth);assert.equal(after.markSource.geometry.pageHeight,pageHeight);
      for(let point=0;point<before.markSource.geometry.points.length;point++) {near(after.markSource.geometry.points[point].x,before.markSource.geometry.points[point].x);near(after.markSource.geometry.points[point].y,before.markSource.geometry.points[point].y);}
    }
    if(before.textSource)assert.deepEqual(plain(after.textSource),plain(before.textSource));
  }
  assert.equal(JSON.stringify(page),saved,'Rotating a page must leave undo snapshots unchanged');
}
console.log('PASS: all starting page rotations, normalized/physical path nodes, rotated raster/source agreement, bounds and dimensions, fixed text font/frame sizes, leader associations, asset reuse and immutable four-turn round trips');
