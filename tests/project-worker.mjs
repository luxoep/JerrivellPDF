// SPDX-License-Identifier: MIT OR Apache-2.0
// The real frontend staging/queue connects to the real native project protocol.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, copyFile, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = resolve(process.argv[2] ?? join(root, 'src-tauri/target/release/jerrivell-pdf.exe'));
const library = resolve(process.argv[3] ?? join(root, 'src-tauri/resources/pdfium/bin/pdfium.dll'));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const output = resolve(process.argv[4] ?? join(root, `test-results/${version}/project-worker`));
await mkdir(output, { recursive: true });
const source = join(output, 'original-source.pdf'); await copyFile(join(root, 'fixtures/sample.pdf'), source);
const digest = data => createHash('sha256').update(data).digest('hex');
const sourceDigest = digest(await readFile(source));
const child = spawn(executable, ['--pdf-worker', '--pdfium-path', library], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map(), calls = []; let sequence = 0, stderr = '';
child.stderr.on('data', data => stderr += data);
const reader = createInterface({ input: child.stdout });
reader.on('line', line => {
  let response; try { response = JSON.parse(line); } catch { return; }
  const entry = pending.get(response.id);
  if (entry) { pending.delete(response.id); clearTimeout(entry.timer); response.error ? entry.reject(new Error(response.error)) : entry.resolve(response.result); }
});
const fail = error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
child.on('error', fail); child.on('exit', code => fail(new Error(`Project worker exited ${code}: ${stderr}`)));
function invoke(command, args = {}) { calls.push({ command, args }); return new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${command}`)); }, 120_000);
  pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, command, args }) + '\n');
}); }
const edge = new EventTarget(); edge.__TAURI_INTERNALS__ = {}; edge.setTimeout = setTimeout; edge.clearTimeout = clearTimeout;
async function load(path, require) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(await readFile(join(root, path), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, require, window: edge, CustomEvent, console, Error, Image: class { async decode() {} } }, { filename: path });
  return exports;
}
const api = await load('src/backend.ts', name => { assert.equal(name, '@tauri-apps/api/core'); return { invoke }; });
const projectApi = await load('src/editableProject.ts', () => { throw new Error('Project validation must be independent of native APIs'); });
try {
  const document = await api.backend('open_document', { path: source });
  const generated = await api.backend('generate_pages', { request: { kind: 'blank', width: 400, height: 240, count: 1 } });
  const image = await api.backend('import_pdf_stamp', { path: join(root, 'fixtures/second.pdf'), pageIndex: 0,
    removeWhiteBackground: false, trimTransparentMargins: false });
  const staged = api.stageImageAsset(image.dataUrl);
  const first = { id: 'native-page', documentId: document.id, pageIndex: 0, rotation: 0, width: document.pages[0].width, height: document.pages[0].height,
    sourceName: document.fileName, overlays: [
      { id: 'text', assetId: staged.id, x: .2, y: .2, width: .35, height: .12, opacity: 1,
        textSource: { content: 'Jerry 可重排文字', fontFamily: 'Arial', fontSize: 12, color: '#243746', bold: false, frame: { width: 120, height: 40, autoHeight: false } } },
      { id: 'leader', assetId: staged.id, x: .1, y: .1, width: .15, height: .18, opacity: .8, leaderFor: 'text',
        markSource: { color: '#243746', geometry: { tool: 'callout', points: [{ x: .12, y: .12 }, { x: .21, y: .25 }, { x: .24, y: .25 }],
          bounds: { x: .1, y: .1, width: .15, height: .18 }, pageWidth: document.pages[0].width, pageHeight: document.pages[0].height,
          lineWidth: 2, lineStyle: 'dashDot', arrowHeads: 'start' } } },
    ], contentEdits: [], decorations: [] };
  const second = { id: 'generated-page', documentId: generated.id, pageIndex: 0, rotation: 90, width: 400, height: 240, sourceName: generated.fileName, overlays: [], contentEdits: [], decorations: [] };
  const workspace = projectApi.validateEditableWorkspace([second, first]);
  const path = join(output, 'portable.jvp');
  // Deliberately save before staged registration finishes: the queue must resolve
  // the pending image ID while retaining textSource/markSource/leaderFor.
  await api.backend('save_editable_project', { path, pages: workspace, title: 'Jerry portable project' }, 3);
  await staged.registered;
  const before = await api.renderPage(first, 600);
  const saved = await readFile(path, 'utf8'), disk = JSON.parse(saved);
  assert.ok(!saved.includes('jerrivell-preview-'), 'Project files must not retain unresolved preview IDs');
  assert.ok(!saved.includes(source.replaceAll('\\', '\\\\')), 'Project must not require or publish source absolute paths');
  assert.equal(digest(await readFile(source)), sourceDigest, 'Saving a project leaves the original PDF unchanged');
  await unlink(source);
  const bad = join(output, 'broken.jvp'); disk.assets[0].pngBase64 = '%%%'; await writeFile(bad, JSON.stringify(disk));
  await assert.rejects(api.backend('load_editable_project', { path: bad }, 3), /PROJECT_INVALID/);
  assert.equal(digest((await api.renderPage(first, 600)).dataUrl), digest(before.dataUrl), 'Failed restore must preserve old native session');
  const result = projectApi.validateLoadedProject(await api.backend('load_editable_project', { path }, 3));
  assert.equal(result.workspace[0].id, second.id); assert.equal(result.workspace[0].rotation, 90);
  assert.deepEqual(JSON.parse(JSON.stringify(result.workspace[1].overlays[0].textSource)), first.overlays[0].textSource);
  assert.deepEqual(JSON.parse(JSON.stringify(result.workspace[1].overlays[1].markSource)), first.overlays[1].markSource);
  assert.equal(result.workspace[1].overlays[1].leaderFor, 'text');
  assert.notEqual(result.workspace[1].documentId, first.documentId);
  assert.notEqual(result.workspace[1].overlays[0].assetId, image.id);
  assert.equal(result.assets.length, 1, 'Shared image references are stored once');
  api.resetBackendQueue();
  if (api.hydrateImageAssets) api.hydrateImageAssets(result.assets);
  else for (const image of result.assets) await api.backend('get_image_asset', { assetId: image.id });
  for (const image of result.assets) assert.equal(api.previewImageAsset(image.id).dataUrl, image.dataUrl, 'Restored images must be available to live overlays');
  const after = await api.renderPage(result.workspace[1], 600);
  assert.equal(digest(after.dataUrl), digest(before.dataUrl), 'Portable source/image restoration must preserve rendered appearance');
  const pdf = join(output, 'ordinary-export.pdf');
  await api.backend('save_document', { outputPath: pdf, pages: result.workspace.map(api.pageReference) }, 3);
  const reopened = await api.backend('open_document', { path: pdf }); assert.equal(reopened.pageCount, 2);
  const inspection = await api.backend('inspect_page_content', { page: { documentId: reopened.id, pageIndex: 1, rotation: 0 } });
  assert.equal(inspection.objects.filter(object => object.kind === 'image').length, 2, 'Ordinary PDF exports contain the rendered overlays; editable semantics belong to .jvp');
  assert.ok(!JSON.stringify(calls.filter(call => call.command !== 'save_editable_project')).includes('jerrivell-preview-'), 'Native consumers must receive resolved resource IDs');
  const summary = { status: 'PASS', executable, portableSources: true, generatedPages: true, pageOrderAndRotation: true,
    textAndLeaderSemantics: true, stagedAssetSave: true, restoredLiveImageCache: true, failedLoadPreservesSession: true,
    sourceIndependentRestore: true, ordinaryPdfExport: true, sourceUnchangedBeforeRemovingTestCopy: true };
  await writeFile(join(output, 'results.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
} finally { child.stdin.end(); child.kill(); reader.close(); }
