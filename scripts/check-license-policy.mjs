// SPDX-License-Identifier: MIT OR Apache-2.0
// Windows shipping license policy. Metadata/provenance checks, not legal advice.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFileSync(resolve(root,path));
const json=path=>JSON.parse(read(path).toString('utf8').replace(/^\uFEFF/,''));
const hash=data=>createHash('sha256').update(data).digest('hex');
const permissive=new Set(['0BSD','MIT','MIT-0','Apache-2.0','BSD-2-Clause','BSD-3-Clause','BSD-4-Clause','ISC','Unlicense','CC0-1.0','Unicode-3.0','Unicode-DFS-2016','Zlib','BSL-1.0','FTL','Libpng','IJG','NCSA']);
const reviewedMpl=new Set(['cargo/cssparser@0.37.0','cargo/cssparser-macros@0.7.1','cargo/dtoa-short@0.3.5','cargo/option-ext@0.2.0','cargo/selectors@0.38.0']);

export function evaluateLicense(input,component='') {
  try {
    if(typeof input!=='string'||!input.trim())throw new Error('Missing license metadata');
    // Old registry metadata used slash for an OR choice; only known legacy
    // forms are accepted, never arbitrary punctuation or free-text licensing.
    let source=input.trim();
    if(/^(MIT|Apache-2\.0|BSD-3-Clause|Unlicense)(\s*\/\s*(MIT|Apache-2\.0|BSD-3-Clause|Unlicense))+$/.test(source))source=source.replace(/\s*\/\s*/g,' OR ');
    const tokens=[];let offset=0;
    while(offset<source.length){if(/\s/.test(source[offset])){offset++;continue;}const token=/^(?:[()]|[A-Za-z0-9][A-Za-z0-9.+-]*)/.exec(source.slice(offset));if(!token)throw new Error('Unsupported license expression syntax');tokens.push(token[0]);offset+=token[0].length;}
    let cursor=0;
    const identifier=id=>{
      if(permissive.has(id))return{allowed:true,selected:id};
      if(id==='MPL-2.0'&&reviewedMpl.has(component))return{allowed:true,selected:id,componentObligations:true};
      return{allowed:false,selected:id,reason:'Unreviewed, strong-copyleft or restricted license branch'};
    };
    function atom(){
      if(tokens[cursor]==='('){cursor++;const result=or();if(tokens[cursor++]!==')')throw new Error('Unclosed license parentheses');return result;}
      const id=tokens[cursor++];if(!id||['AND','OR','WITH',')'].includes(id))throw new Error('Expected license identifier');
      if(tokens[cursor]==='WITH'){cursor++;const exception=tokens[cursor++];if(!exception||['AND','OR','WITH','(',')'].includes(exception))throw new Error('Expected license exception');const combined=id+' WITH '+exception;return combined==='Apache-2.0 WITH LLVM-exception'?{allowed:true,selected:combined}:{allowed:false,selected:combined,reason:'Unreviewed exception; does not override a denied base license'};}
      return identifier(id);
    }
    function and(){let result=atom();while(tokens[cursor]==='AND'){cursor++;const right=atom();result={allowed:result.allowed&&right.allowed,selected:`(${result.selected} AND ${right.selected})`,componentObligations:result.componentObligations||right.componentObligations,reason:!result.allowed?result.reason:!right.allowed?right.reason:undefined};}return result;}
    function or(){let result=and();while(tokens[cursor]==='OR'){cursor++;const right=and();if(right.allowed&&(!result.allowed||(result.componentObligations&&!right.componentObligations)||(component==='cargo/pdfium-render@0.9.4'&&right.selected==='Apache-2.0')))result=right;else if(!result.allowed&&!right.allowed)result={allowed:false,selected:`(${result.selected} OR ${right.selected})`,reason:'No approved license choice'};}return result;}
    const result=or();if(cursor!==tokens.length)throw new Error('Trailing license expression tokens');return result;
  }catch(error){return{allowed:false,selected:String(input),reason:error.message};}
}

export function selfTest(){
  for(const expression of ['MIT','Apache-2.0','GPL-3.0-only OR MIT','GPL-2.0-only OR (MIT AND Apache-2.0)','MIT/Apache-2.0','(Apache-2.0 OR MIT) AND Unicode-3.0','Apache-2.0 WITH LLVM-exception'])assert.equal(evaluateLicense(expression).allowed,true,expression);
  for(const expression of [null,'','GPL-3.0-only','AGPL-3.0-only','LGPL-2.1-only','SSPL-1.0','CC-BY-NC-4.0','BSL-1.1','MIT AND GPL-3.0-only','MIT AND Unknown-1.0','MIT WITH Unknown-exception','GPL-2.0-only WITH Classpath-exception-2.0','(MIT OR Apache-2.0','MIT; GPL-3.0-only','MPL-2.0'])assert.equal(evaluateLicense(expression).allowed,false,String(expression));
  assert.equal(evaluateLicense('MPL-2.0','cargo/cssparser@0.37.0').allowed,true);
  assert.equal(evaluateLicense('MPL-2.0','cargo/new-package@1.0.0').allowed,false);
  assert.equal(evaluateLicense('GPL-3.0-only OR MIT').selected,'MIT');
  assert.equal(evaluateLicense('MIT OR Apache-2.0','cargo/pdfium-render@0.9.4').selected,'Apache-2.0');
  assert.equal(evaluateLicense('MIT OR Apache-2.0 AND GPL-3.0-only').allowed,true);
  assert.equal(evaluateLicense('(MIT OR Apache-2.0) AND GPL-3.0-only').allowed,false);
}

export function checkLicensePolicy(){
  selfTest();
  const inventory=json('licenses/inventory.json'),lock=json('package-lock.json'),pkg=json('package.json');
  assert.equal(hash(read('src-tauri/Cargo.lock')),inventory.cargoLockSha256,'Stale Cargo license inventory');
  assert.equal(hash(read('package-lock.json')),inventory.npmLockSha256,'Stale npm license inventory');
  assert.equal(pkg.license,'MIT OR Apache-2.0','Unexpected own-code license');
  assert.ok(/^license\s*=\s*"MIT OR Apache-2.0"/m.test(read('src-tauri/Cargo.toml').toString('utf8')),'Unexpected native own-code license');
  const crates=new Map(inventory.cargo.map(p=>[`${p.name}@${p.version}`,p]));
  const tree=spawnSync('cargo',['tree','--locked','--offline','--manifest-path','src-tauri/Cargo.toml','--target','x86_64-pc-windows-msvc','-e','normal,build','--prefix','none','-f','{p}'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8*1024*1024});
  if(tree.error||tree.status!==0)throw new Error('Cannot establish current Windows dependency graph: '+(tree.error?.message??tree.stderr));
  const used=new Set();for(const line of tree.stdout.split(/\r?\n/)){const match=/^([A-Za-z0-9_-]+) v([^\s]+)/.exec(line);if(match&&match[1]!==pkg.name)used.add(`${match[1]}@${match[2]}`);}
  assert.ok(used.size>0,'Empty Windows dependency graph');
  const checked=[];const problems=[];
  for(const key of [...used].sort()){
    const entry=crates.get(key),component='cargo/'+key,decision=evaluateLicense(entry?.license,component);
    if(!entry?.files?.length&&!entry?.supplementalFiles?.length)problems.push(component+': missing local notices');
    for(const notice of entry?.files??[])assert.equal(hash(read(notice.path)),notice.sha256,'Notice changed: '+component);
    if(!decision.allowed)problems.push(component+': '+decision.reason+' ['+entry?.license+']');
    checked.push({component,license:entry?.license,...decision});
  }
  // Traverse Node's resolved production dependency/peer closure. Build-only
  // Vite/LightningCSS binaries are not mistaken for shipped app JavaScript.
  const shipping=new Set(),queue=Object.keys(pkg.dependencies).map(name=>['',name]);
  function locate(from,name){let base=from;while(true){const candidate=(base?base+'/':'')+'node_modules/'+name;if(lock.packages[candidate])return candidate;if(!base)break;const cut=base.lastIndexOf('/');base=cut<0?'':base.slice(0,cut);}return null;}
  const matches=(list,value)=>!list||(!list.includes('!'+value)&&(list.filter(x=>!x.startsWith('!')).length===0||list.includes(value)));
  while(queue.length){const [from,name]=queue.shift();const path=locate(from,name);assert.ok(path,'Unresolved shipped npm dependency: '+name);if(shipping.has(path))continue;shipping.add(path);const entry=lock.packages[path];for(const dependency of Object.keys(entry.dependencies??{}))queue.push([path,dependency]);for(const dependency of Object.keys(entry.optionalDependencies??{})){const resolved=locate(path,dependency),optional=resolved&&lock.packages[resolved];if(optional&&matches(optional.os,'win32')&&matches(optional.cpu,'x64'))queue.push([path,dependency]);}for(const dependency of Object.keys(entry.peerDependencies??{}))if(!entry.peerDependenciesMeta?.[dependency]?.optional)queue.push([path,dependency]);}
  for(const path of [...shipping].sort()){
    const locked=lock.packages[path],entry=inventory.npm.find(p=>p.version===locked.version&&path.endsWith('node_modules/'+p.name));
    const component='npm/'+(entry?.name??path)+'@'+locked.version,decision=evaluateLicense(entry?.license,component);
    if(!entry||entry.license!==locked.license)problems.push(component+': installed/locked metadata mismatch');
    if(!entry?.files?.length&&!entry?.supplementalFiles?.length)problems.push(component+': missing local notices');
    for(const notice of entry?.files??[])assert.equal(hash(read(notice.path)),notice.sha256,'Notice changed: '+component);
    if(!decision.allowed)problems.push(component+': '+decision.reason);
    checked.push({component,license:entry?.license,...decision});
  }
  const supplements=json('licenses/upstream-manifest.json');
  for(const [key,entries] of Object.entries(supplements))for(const entry of entries)assert.equal(hash(read(entry.path)),entry.sha256,'Notice supplement changed: '+key);
  assert.ok(supplements['rust/pdfium-render@0.9.4']?.some(p=>p.selectedLicense==='Apache-2.0'),'Missing wrapper standard license supplement');
  const nsis=supplements['tools/nsis@3.13'];assert.ok(nsis?.length,'Unreviewed installer version');
  assert.ok(read(nsis[0].path).toString('utf8').includes('without subjecting your linked code to the terms of the Common Public license version 1.0'),'Installer CPL link exception missing');
  assert.ok(read('src-tauri/resources/pdfium/licenses/agg23.txt').toString('utf8').includes('Anti-Grain Geometry - Version 2.3'),'Unreviewed AGG version');
  assert.ok(read('src-tauri/resources/pdfium/licenses/freetype.txt').toString('utf8').includes('The FreeType Project LICENSE'),'FTL license missing');
  const runtime=json('src-tauri/resources/pdfium/aurapdf-runtime.json');assert.equal(hash(read('src-tauri/resources/pdfium/bin/pdfium.dll')),runtime.dllSha256,'PDFium provenance mismatch');
  if(problems.length)throw new Error('License policy rejected:\n'+problems.join('\n'));
  return{status:'PASS',scope:'Windows x64 normal/build Rust graph and shipped npm closure; source/notices required; not legal clearance',windowsRustPackages:used.size,shippedNpmPackages:shipping.size,ownLicense:pkg.license,deniedByDefault:'Unknown, GPL/AGPL/LGPL-only, SSPL/noncommercial/restricted license choices; reviewed OR alternatives accepted',reviewedFileCopyleft:checked.filter(p=>p.componentObligations).map(p=>p.component),installer:'NSIS 3.13 CPL-1.0 LZMA with explicit linking exception; original module/source obligations retained',externalPlatform:'Windows/WebView2 and user fonts retain separate licenses',lockfileCoverage:{cargoRegistryEntries:inventory.cargo.length,localCargoMetadata:inventory.cargo.filter(p=>p.license).length,otherLockedEntriesNotProvenShipped:inventory.cargo.length-used.size},cargoLockSha256:inventory.cargoLockSha256,npmLockSha256:inventory.npmLockSha256,graphSha256:hash(tree.stdout),checked};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.includes('--self-test')){selfTest();console.log('PASS: license expression alternatives, conjunctions, exceptions, unknown and restricted branches');}else console.log(JSON.stringify(checkLicensePolicy(),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
