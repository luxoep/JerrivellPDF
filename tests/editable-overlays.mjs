// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const plain = value => JSON.parse(JSON.stringify(value));
const near = (a, b, message = '') => assert.ok(Math.abs(a - b) < 1e-8, `${message}: ${a} != ${b}`);
let encodes = 0, paints = 0, frameRenders = 0;
const document = { createElement() {
  const context = new Proxy({ font: '', measureText(text) { return { width: [...text].length * Number(this.font.match(/([\d.]+)px/)?.[1] ?? 24) * .6 }; }, fillText() { paints++; } }, { get: (target, key) => target[key] ?? (() => {}) });
  return { width: 1, height: 1, getContext: () => context, toDataURL() { return `data:image/png;base64,${++encodes}`; } };
} };
function load(path, require = () => {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require, document, Intl, crypto: { randomUUID: () => 'unexpected-generated-id' } });
  return exports;
}
const geometry = load('../src/overlayGeometry.ts'), canvas = load('../src/components/overlayCanvas.ts'), marks = load('../src/markGeometry.ts');
const frame = load('../src/textFrame.ts', name => name === './overlayGeometry' ? geometry : name === './components/overlayCanvas' ? canvas : assert.fail(name));
const trackedFrame = { ...frame, renderTextFrame(...args) { frameRenders++; return frame.renderTextFrame(...args); } };
const editable = load('../src/editableOverlays.ts', name => name === './markGeometry' ? marks : name === './textFrame' ? trackedFrame : assert.fail(name));
const placement = load('../src/placementGeometry.ts');
const pw = 600, ph = 800;
const sourceText = { content: 'Editable text frame 中文 content across several words', color: '#3a5678', fontSize: 12, bold: false, fontFamily: 'Arial',
  charSpacing: .5, lineHeight: 1.4, frame: { width: 180, height: 60, autoHeight: true } };
const text = frame.renderTextFrame({ id: 'text', assetId: 'text-raster', x: .55, y: .15, width: .3, height: .075, rotation: 0, opacity: .8, textSource: sourceText }, pw, ph).overlay;
const lineGeometry = marks.createMarkGeometry([{ x: .1, y: .7 }, { x: .48, y: text.y + text.height / 2 }, { x: text.x, y: text.y + text.height / 2 }],
  { tool: 'callout', color: '#436b84', opacity: .9, lineWidth: 2, lineStyle: 'dashDot', arrowHeads: 'start' }, pw, ph);
const leader = { id: 'leader', assetId: 'leader-raster', ...lineGeometry.bounds, rotation: 0, opacity: .9, leaderFor: text.id, markSource: { geometry: lineGeometry, color: '#436b84' } };
const initial = JSON.stringify([text, leader]);
const imageId = result => Array.from(result.images, image => image.id);
const failed = [];
function check(name, run) { try { run(); console.log(`PASS: ${name}`); } catch (error) { failed.push(name); console.error(`FAIL: ${name}\n${error.stack}`); } }
const reset = () => { encodes = 0; paints = 0; frameRenders = 0; };
const allPoints = item => item.markSource.geometry.points;
const requestedMove = (dx = .03, dy = .02) => ({ ...text, x: text.x + dx, y: text.y + dy });

check('Text translation preserves source, point size and raster; no canvas paint/PNG registration', () => {
  reset(); const moved = requestedMove();
  const result = editable.prepareEditableOverlays([text], [moved], pw, ph);
  const next = result.overlays[0]; near(next.x, moved.x); near(next.y, moved.y);
  assert.deepEqual(plain(next.textSource), plain(text.textSource)); assert.equal(next.textSource.fontSize, 12); assert.equal(next.assetId, text.assetId);
  assert.equal(result.images.length, 0); assert.equal(frameRenders, 0); assert.equal(encodes, 0); assert.equal(paints, 0);
});
check('Legacy added text also moves without reflow or replacing its image', () => {
  const oldSource = { ...sourceText, frame: undefined, wrapWidth: 120 };
  const oldPng = canvas.createTextPng(oldSource.content, oldSource.color, 12, false, oldSource.fontFamily, oldSource);
  const legacy = { ...text, id: 'legacy', width: oldPng.width / 2 / pw, height: oldPng.height / 2 / ph, textSource: oldSource };
  reset(); const result = editable.prepareEditableOverlays([legacy], [{ ...legacy, x: legacy.x + .02 }], pw, ph);
  assert.equal(result.images.length, 0); assert.equal(frameRenders, 0); assert.equal(encodes, 0);
  assert.deepEqual(plain(result.overlays[0].textSource), plain(legacy.textSource));
});
check('Eight handles preserve the opposite edge and fixed font size', () => {
  for (const handle of ['n','ne','e','se','s','sw','w','nw']) {
    const next = placement.resizedPlacement(text, handle, .02, .015, pw, ph);
    assert.equal(next.textSource.fontSize, text.textSource.fontSize);
    if (!handle.includes('w')) near(next.x, text.x, `${handle} left edge`);
    if (!handle.includes('e')) near(next.x + next.width, text.x + text.width, `${handle} right edge`);
    if (!handle.includes('n')) near(next.y, text.y, `${handle} top edge`);
    if (!handle.includes('s')) near(next.y + next.height, text.y + text.height, `${handle} bottom edge`);
  }
  for (const handle of ['n','ne','e','se','s','sw','w','nw']) {
    const next = placement.resizedPlacement(text, handle, 10, 10, pw, ph);
    assert.ok(next.x >= 0 && next.y >= 0 && next.width > 0 && next.height > 0 && next.x + next.width <= 1 + 1e-8 && next.y + next.height <= 1 + 1e-8);
  }
});
check('Text frame resize reflows once and retains content/styles/point size', () => {
  reset(); const narrower = placement.resizedPlacement(text, 'e', -.08, 0, pw, ph);
  const result = editable.prepareEditableOverlays([text], [narrower], pw, ph), next = result.overlays[0];
  assert.equal(next.textSource.fontSize, 12); assert.equal(next.textSource.content, text.textSource.content); assert.equal(next.textSource.charSpacing, .5);
  assert.ok(Math.abs(next.width - narrower.width) * pw <= .5 + 1e-8, 'Raster rounding stays within half a PDF point'); assert.ok(next.height >= text.height); assert.deepEqual(imageId(result), [text.id]); assert.equal(frameRenders, 1); assert.equal(encodes, 1);
});
check('Pure raster movement avoids all text/mark encoding', () => {
  const image = { id:'image',assetId:'existing-image',x:.1,y:.1,width:.2,height:.3,opacity:1 };
  reset(); const result = editable.prepareEditableOverlays([image],[{...image,x:.15,y:.2}],pw,ph);
  assert.equal(result.images.length,0); assert.equal(encodes,0); assert.equal(frameRenders,0);
});
check('Path move/scale transforms every node, preserves styles and encodes once', () => {
  const path = { ...leader, leaderFor: undefined };
  for (const target of [{...path,x:path.x+.02,y:path.y+.03}, {...path,width:path.width*.7,height:path.height*.6}]) {
    reset(); const result = editable.prepareEditableOverlays([path], [target], pw, ph), next = result.overlays[0];
    const expected = marks.transformMarkSource(path.markSource,path,target);
    assert.deepEqual(plain(next.markSource),plain(expected)); assert.deepEqual(imageId(result),[path.id]); assert.equal(encodes,1); assert.equal(frameRenders,0);
    assert.deepEqual(Object.keys(next.markSource.geometry.bounds).sort(), ['height','width','x','y'], 'Bounds never capture PageOverlay metadata/source recursively');
    // The content scales with the requested box; fixed-point strokes keep their
    // padding, so the final raster bounds can be larger than that requested box.
    near(next.x,expected.geometry.bounds.x); near(next.y,expected.geometry.bounds.y); near(next.width,expected.geometry.bounds.width); near(next.height,expected.geometry.bounds.height);
    allPoints(next).forEach((point,i)=>{near(point.x,target.x+(allPoints(path)[i].x-path.x)*target.width/path.width);near(point.y,target.y+(allPoints(path)[i].y-path.y)*target.height/path.height);});
  }
});
check('A node edit is not incorrectly transformed a second time', () => {
  const path = { ...leader, leaderFor: undefined };
  const nodes = allPoints(path).map((point,i)=>i===1?{...point,x:point.x+.05,y:point.y+.08}:point);
  const geometry = marks.createMarkGeometry(nodes,{...path.markSource.geometry,color:path.markSource.color,opacity:path.opacity},pw,ph);
  const edited = {...path,...geometry.bounds,markSource:{...path.markSource,geometry}};
  const result = editable.prepareEditableOverlays([path],[edited],pw,ph);
  assert.deepEqual(plain(allPoints(result.overlays[0])),plain(nodes));
});
check('Path preview follows movement/resize without painting or mutating stored source', () => {
  const path = { ...leader, leaderFor: undefined };
  for(const requested of [{...path,x:path.x+.04,y:path.y+.03},{...path,width:path.width*.8,height:path.height*.7}]) {
    reset(); const result = editable.previewEditableOverlays([path],requested), next=result[0];
    assert.deepEqual(plain(next.markSource),plain(marks.transformMarkSource(path.markSource,path,requested)));
    assert.equal(encodes,0); assert.equal(paints,0); assert.equal(frameRenders,0);
  }
});
check('Moving text leaves its arrow target fixed and landing segment horizontal', () => {
  reset(); const moved=requestedMove(), result=editable.prepareEditableOverlays([text,leader],[moved,leader],pw,ph);
  const nextText=result.overlays.find(item=>item.id===text.id), nextLeader=result.overlays.find(item=>item.id===leader.id), points=allPoints(nextLeader);
  assert.deepEqual(plain(points[0]),plain(allPoints(leader)[0])); near(points.at(-1).y,nextText.y+nextText.height/2); near(points.at(-2).y,points.at(-1).y);
  assert.ok(Math.abs(points.at(-1).x-nextText.x)<1e-8 || Math.abs(points.at(-1).x-nextText.x-nextText.width)<1e-8);
  assert.deepEqual(imageId(result),[leader.id]); assert.equal(frameRenders,0);
  const preview=editable.previewEditableOverlays([text,leader],moved), previewLeader=preview.find(item=>item.id===leader.id);
  assert.deepEqual(plain(allPoints(previewLeader)[0]),plain(allPoints(leader)[0])); near(allPoints(previewLeader).at(-1).y,moved.y+moved.height/2);
});
check('Alt moves text and leader together, retaining the offset target and horizontal landing', () => {
  const moved=requestedMove(), dx=moved.x-text.x,dy=moved.y-text.y;
  const result=editable.prepareEditableOverlays([text,leader],[moved,leader],pw,ph,{moveLinked:true});
  const next=result.overlays.find(item=>item.id===leader.id), nodes=allPoints(next);
  for(let i=0;i<nodes.length;i++){near(nodes[i].x,allPoints(leader)[i].x+dx);near(nodes[i].y,allPoints(leader)[i].y+dy);}
  near(nodes.at(-1).y,nodes.at(-2).y);
  reset(); const preview=editable.previewEditableOverlays([text,leader],{...moved,previewMoveLinked:true});
  const previewNodes=allPoints(preview.find(item=>item.id===leader.id));
  for(let i=0;i<nodes.length;i++){near(previewNodes[i].x,nodes[i].x);near(previewNodes[i].y,nodes[i].y);}
  assert.equal(encodes,0);assert.equal(paints,0);
});
check('Deleting text cascades to its leader; deleting only a leader keeps text and its image', () => {
  reset(); const deleted=editable.prepareEditableOverlays([text,leader],[leader],pw,ph);
  assert.equal(deleted.overlays.length,0); assert.equal(deleted.images.length,0);
  const textOnly=editable.prepareEditableOverlays([text,leader],[text],pw,ph);
  assert.deepEqual(Array.from(textOnly.overlays,item=>item.id),[text.id]); assert.equal(textOnly.images.length,0);
});
check('Duplicating text duplicates linked leaders with unique IDs and matching parent association', () => {
  const copy=geometry.duplicatedOverlay(text,'text-copy',pw,ph), ids=[]; reset();
  const result=editable.prepareEditableOverlays([text,leader],[text,leader,copy],pw,ph,{},()=>{const id=`leader-copy-${ids.length+1}`;ids.push(id);return id;});
  const duplicates=result.overlays.filter(item=>item.leaderFor==='text-copy'); assert.equal(duplicates.length,1);
  assert.equal(duplicates[0].id,'leader-copy-1'); assert.equal(duplicates[0].locked,false);
  assert.equal(new Set(result.overlays.map(item=>item.id)).size,result.overlays.length);
  const node=allPoints(duplicates[0])[0];near(node.x,allPoints(leader)[0].x+copy.x-text.x);near(node.y,allPoints(leader)[0].y+copy.y-text.y);
  const originalText=result.overlays.find(item=>item.id===text.id), originalLeader=result.overlays.find(item=>item.id===leader.id);
  assert.deepEqual(plain(originalText),plain(text));assert.deepEqual(plain(originalLeader),plain(leader));
});
check('Exceeding the per-page limit while duplicating a linked object fails atomically', () => {
  const fillers=Array.from({length:28},(_,i)=>({id:`image-${i}`,assetId:`raster-${i}`,x:.1,y:.1,width:.05,height:.05,opacity:1}));
  const before=[text,leader,...fillers],copy={...text,id:'over-limit',x:text.x+.01};
  assert.throws(()=>editable.prepareEditableOverlays(before,[...before,copy],pw,ph),/OVERLAY_LIMIT/);
});
check('Duplicating a standalone path translates its source nodes instead of snapping back', () => {
  const original={...leader,leaderFor:undefined},copy=geometry.duplicatedOverlay(original,'path-copy',pw,ph);
  const result=editable.prepareEditableOverlays([original],[original,copy],pw,ph);
  const changed=result.overlays.find(item=>item.id===copy.id);
  near(allPoints(changed)[0].x,allPoints(original)[0].x+copy.x-original.x);
  near(allPoints(changed)[0].y,allPoints(original)[0].y+copy.y-original.y);
  assert.deepEqual(imageId(result),[copy.id]);
});
check('Rotating a path changes its physical nodes and resets raster rotation after encoding', () => {
  const original={...leader,leaderFor:undefined},rotated=geometry.rotatedOverlay90(original,pw,ph);
  const result=editable.prepareEditableOverlays([original],[rotated],pw,ph),next=result.overlays[0];
  const cx=(original.x+original.width/2)*pw,cy=(original.y+original.height/2)*ph;
  const nx=(rotated.x+rotated.width/2)*pw,ny=(rotated.y+rotated.height/2)*ph;
  allPoints(next).forEach((point,i)=>{near(point.x*pw,nx-(allPoints(original)[i].y*ph-cy));near(point.y*ph,ny+(allPoints(original)[i].x*pw-cx));});
  assert.equal(next.rotation,0,'The new raster already contains rotated geometry');assert.deepEqual(imageId(result),[original.id]);
});
check('Moving an already rotated page path regenerates an upright raster exactly once', () => {
  const original={...leader,leaderFor:undefined,rotation:90},moved={...original,x:original.x+.01};
  const result=editable.prepareEditableOverlays([original],[moved],pw,ph);
  assert.equal(result.overlays[0].rotation,0);near(allPoints(result.overlays[0])[0].x,allPoints(original)[0].x+.01);
});
check('All edit/preview operations leave original history snapshots unchanged', () => { assert.equal(JSON.stringify([text,leader]),initial); });
if(failed.length) { console.error(`${failed.length} editable-overlay checks failed: ${failed.join('; ')}`); process.exitCode=1; }
else console.log('PASS: editable overlay integration, raster reuse, semantic geometry, leader association and transactional page limits');
