// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
let cursor=0;const slots=[],effects=[];let pending=[];
const react={useState(initial){const n=cursor++;if(!(n in slots))slots[n]=typeof initial==='function'?initial():initial;return[slots[n],v=>slots[n]=typeof v==='function'?v(slots[n]):v];},useRef(initial){const n=cursor++;return slots[n]??={current:initial};},useEffect(run,deps){const n=cursor++;if(!effects[n]||deps.some((d,i)=>!Object.is(d,effects[n][i])))pending.push(()=>{effects[n]=deps;run();});}};
const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/useNumberDraft.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:()=>react});
let value=24,options={min:6,max:144,step:1,resetKey:'one'},calls=[],field;
function render(){cursor=0;pending=[];field=exports.useNumberDraft(value,n=>{calls.push(n);value=n;},options);for(const f of pending)f();cursor=0;pending=[];field=exports.useNumberDraft(value,n=>{calls.push(n);value=n;},options);return field;}
const change=text=>{field.onChange({target:{value:text}});render();};
const blur=()=>{field.onBlur({currentTarget:{value:field.value}});render();};
const key=(key,shiftKey=false)=>{let prevented=false,stopped=false;field.onKeyDown({key,shiftKey,currentTarget:{value:field.value,blur(){}},preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});render();return{prevented,stopped};};
render();field.onFocus({});change('');assert.equal(field.value,'');assert.equal(value,24);assert.equal(calls.length,0,'Clearing never publishes zero or a fallback');
change('1');assert.equal(field.value,'1');assert.equal(value,24,'A partial first digit must not be clamped to the minimum');
change('12');assert.equal(value,12);assert.equal(field.value,'12');change('12.');assert.equal(field.value,'12.');assert.equal(value,12);
change('12.5');assert.equal(value,12.5);change('');blur();assert.equal(field.value,'12.5');assert.equal(value,12.5);
change('999');assert.equal(value,12.5);assert.equal(field.value,'999');assert.equal(field['aria-invalid'],true);blur();assert.equal(value,144);assert.equal(field.value,'144');
options={min:-2,max:20,step:.1,resetKey:'spacing'};value=0;render();render();change('-');assert.equal(field.value,'-');assert.equal(value,0);change('-0.');assert.equal(field.value,'-0.');change('-0.5');assert.equal(value,-.5);
change('1,25');assert.equal(value,1.25);assert.equal(field.value,'1,25');blur();assert.equal(field.value,'1.25');
assert.deepEqual(key('ArrowUp'),{prevented:true,stopped:true});assert.equal(value,1.35);key('ArrowDown',true);assert.equal(value,.35);
change('not a number');assert.equal(value,.35);assert.equal(field['aria-invalid'],true);key('Escape');assert.equal(field.value,'0.35');
change('1.');key('Enter');assert.equal(field.value,'1');assert.equal(value,1);
change('');options={...options,resetKey:'another-selection'};value=7;render();render();assert.equal(field.value,'7','Switching selected content clears a stale unfinished number');
assert.equal(exports.parseNumberDraft(''),null);assert.equal(exports.parseNumberDraft('-'),null);assert.equal(exports.parseNumberDraft('Infinity'),null);assert.equal(exports.parseNumberDraft('0'),0);
console.log('PASS: empty/partial/negative/decimal/comma drafts, live valid values, final range checks, blur/Enter/Escape, keyboard stepping and external selection reset');
