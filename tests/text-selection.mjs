// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/textSelection.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports});
const text='A😀 B\r\n中文',glyphs=[];let index=0;
for(const ch of text){const start=index;index+=ch.length;if(!/[\r\n]/.test(ch))glyphs.push({start,end:index,bounds:{x:glyphs.length*.1,y:0,width:.08,height:.03}});}
const page={status:'ready',text,glyphs};
assert.equal(exports.selectedText(page,0,2),'A😀 ');
assert.equal(exports.selectedText(page,5,3),'B\n中文');
assert.equal(exports.nearestGlyph(glyphs,.12,.01),1);
assert.equal(exports.nearestGlyph([],0,0),-1);
assert.equal(exports.selectedText({...page,glyphs:[]},0,0),'');
assert.deepEqual(Array.from(exports.wordGlyphRange(page,5)),[4,5]);
console.log('PASS: Unicode/emoji UTF-16 selection, reverse drags, line breaks, word boundaries and scaled hit testing');

const geometry={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/inlineTextGeometry.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:geometry,Intl});
const rows=geometry.inlineRows('AB 中文\nA😀',[{text:'AB ',x:0,y:10,width:3},{text:'中文',x:0,y:20,width:2},{text:'A😀',x:0,y:30,width:3}]);
assert.deepEqual(Array.from(rows,r=>[r.start,r.end]),[[0,3],[3,5],[6,9]]);
assert.equal(geometry.rowForOffset(rows,3),1,'A soft wrap starts the visible next line');
assert.equal(geometry.rowForOffset(rows,5),1,'A hard newline is a document character');
assert.equal(geometry.nearestInlineOffset(rows[2],2.9,s=>s.length,0),9,'Hit testing never splits an emoji surrogate pair');
console.log('PASS: canonical visible row/caret mapping, soft vs hard line breaks and grapheme-safe pointer indices');
