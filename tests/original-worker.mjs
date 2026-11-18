// SPDX-License-Identifier: MIT OR Apache-2.0
// Full worker protocol, native PDFium, and real installed Windows fonts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = resolve(process.argv[2] ?? join(root, 'src-tauri/target/release/jerrivell-pdf.exe'));
const library = resolve(process.argv[3] ?? join(root, 'src-tauri/resources/pdfium/bin/pdfium.dll'));
const projectVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const output = resolve(process.argv[4] ?? join(root, `test-results/${projectVersion}/original-worker`));
await mkdir(output, { recursive: true });
const source = join(output, '原创 原文样本.pdf');
await copyFile(join(root, 'fixtures/sample.pdf'), source);
const hash = value => createHash('sha256').update(value).digest('hex');
const originalHash = hash(await readFile(source));
const child = spawn(executable, ['--pdf-worker', '--pdfium-path', library], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let sequence = 0;
const pending = new Map(), stderr = [], passed = [];
child.stderr.on('data', chunk => stderr.push(chunk.toString()));
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let response;
  try { response = JSON.parse(line); } catch { return; }
  const item = pending.get(response.id);
  if (item) { pending.delete(response.id); clearTimeout(item.timer); response.error ? item.reject(new Error(response.error)) : item.resolve(response.result); }
});
function failed(error) { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); }
child.on('error', failed);
child.on('exit', code => failed(new Error(`Worker exited: ${code} ${stderr.join('')}`)));
function call(command, args = {}) {
  return new Promise((resolveResponse, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${command}`)); }, 120_000);
    pending.set(id, { resolve: resolveResponse, reject, timer });
    child.stdin.write(JSON.stringify({ id, command, args }) + '\n');
  });
}
const ref = (document, pageIndex = 0) => ({ documentId: document.id, pageIndex, rotation: 0 });
const patch = (object, fields) => ({ objectIndex: object.objectIndex, fingerprint: object.fingerprint, ...fields });
const pngBytes = rendered => Buffer.from(rendered.dataUrl.split(',')[1], 'base64');
function solidPng(red, green, blue) {
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const typeBytes = Buffer.from(type); const size = Buffer.alloc(4), check = Buffer.alloc(4); size.writeUInt32BE(data.length); check.writeUInt32BE(crc(Buffer.concat([typeBytes, data]))); return Buffer.concat([size, typeBytes, data, check]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(24, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((32 * 3 + 1) * 24);
  for (let row = 0; row < 24; row++) for (let x = 0; x < 32; x++) { const i = row * 97 + 1 + x * 3; pixels[i] = red; pixels[i + 1] = green; pixels[i + 2] = blue; }
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
async function roundTrip(name, plans) {
  const path = join(output, name + '.pdf');
  const previews = [];
  for (const page of plans) previews.push(await call('render_page', { page, targetWidth: 800 }));
  await call('save_document', { outputPath: path, pages: plans });
  const document = await call('open_document', { path });
  assert.equal(document.pageCount, plans.length);
  for (let i = 0; i < plans.length; i++) {
    const rendered = await call('render_page', { page: ref(document, i), targetWidth: 800 });
    assert.equal(hash(pngBytes(rendered)), hash(pngBytes(previews[i])), `${name} saved pixels page ${i + 1}`);
    await writeFile(join(output, `${name}-${i + 1}.png`), pngBytes(rendered));
  }
  return document;
}
try {
  assert.equal((await call('get_backend_status')).engineReady, true);
  const document = await call('open_document', { path: source });
  const page = ref(document);
  const inspection = await call('inspect_page_content', { page });
  const title = inspection.objects.find(object => object.text === 'Make room for clarity.');
  assert.equal(title?.editable, true, JSON.stringify(title));
  assert.ok(inspection.objects.some(object => object.kind === 'unsupported'));
  passed.push('real top-level text and vector inspection');

  const english = { ...page, contentEdits: [patch(title, { text: 'Original text revised.', fontSize: 24, fillColor: '#156D72' })] };
  const changed = await call('inspect_page_content', { page: english });
  const changedTitle = changed.objects.find(object => object.objectIndex === title.objectIndex);
  assert.equal(changedTitle.text, 'Original text revised.');
  assert.equal(changedTitle.originalText, title.text);
  assert.equal(changedTitle.fingerprint, title.fingerprint);
  assert.notEqual(changedTitle.bounds.width, title.bounds.width, 'Text changes retain natural width');
  assert.deepEqual((await call('search_pages', { pages: [english, page], query: 'Original text revised.' })).map(hit => hit.pageIndex), [0]);
  assert.deepEqual((await call('search_pages', { pages: [english, page], query: title.text })).map(hit => hit.pageIndex), [1]);
  const englishOutput = await roundTrip('原文英文替换', [english, page]);
  assert.deepEqual((await call('search_document', { documentId: englishOutput.id, query: 'Original text revised.' })).map(hit => hit.pageIndex), [0]);
  passed.push('real text replacement, natural dimensions, per-copy workspace search, exact preview/save/reopen pixels');

  const chinese = { ...page, contentEdits: [patch(title, { text: '原文修改 DEMO', fontFamily: '楷体', fontSize: 24 })] };
  const cjk = await roundTrip('中文字体原文替换', [chinese, chinese]);
  assert.equal((await call('search_document', { documentId: cjk.id, query: '原文修改' })).length, 2);
  assert.equal((await call('search_document', { documentId: cjk.id, query: title.text })).length, 0);
  passed.push('installed CJK font embedding, repeated page reuse, searchable Unicode, source text removed');

  for (const [index, [bold, italic]] of [[false, false], [true, false], [false, true], [true, true]].entries()) {
    const styled = { ...page, contentEdits: [patch(title, { text: 'Native styled text', fontFamily: 'Arial', fontSize: 22, bold, italic, opacity: .65 })] };
    const current = (await call('inspect_page_content', { page: styled })).objects.find(object => object.objectIndex === title.objectIndex);
    assert.equal(current.bold, bold); assert.equal(current.italic, italic);
    assert.ok(Math.abs(current.opacity - .65) < .005);
    const reopened = await roundTrip(`native-style-${index}`, [styled]);
    assert.equal((await call('search_document', { documentId: reopened.id, query: 'Native styled text' })).length, 1);
    assert.equal((await call('search_document', { documentId: reopened.id, query: title.text })).length, 0);
    const savedText = (await call('inspect_page_content', { page: ref(reopened) })).objects.find(object => object.text === 'Native styled text');
    assert.equal(savedText.bold, bold); assert.equal(savedText.italic, italic);
    assert.ok(Math.abs(savedText.opacity - .65) < .005);
  }
  passed.push('four actual installed Arial faces, per-style font caching, native opacity, searchable saved Unicode and exact saved pixels');

  const lineRequest = { page, objects: [{ objectIndex: title.objectIndex, fingerprint: title.fingerprint }], bounds: title.bounds,
    targetBounds: { x: .12, y: .20, width: .7, height: .15 }, text: 'Styled line preview', fontFamily: 'Arial', fontSize: 22, color: '#185A7A',
    charSpacing: 1.2, alignment: 'right', constrainWidth: true, bold: true, italic: true, opacity: .6, underline: true, strikeout: true };
  const linePreview = await call('preview_line_edit', { request: lineRequest });
  assert.equal(Object.hasOwn(linePreview, 'before'), false, 'no original-page raster should be returned');
  assert.equal(linePreview.canApply, true);
  const lineDoc = await call('commit_line_preview', { token: linePreview.token });
  const lineObjects = (await call('inspect_page_content', { page: ref(lineDoc) })).objects;
  const nativeLine = lineObjects.find(object => object.text === lineRequest.text);
  assert.ok(nativeLine); assert.equal(nativeLine.bold, true); assert.equal(nativeLine.italic, true);
  assert.ok(Math.abs(nativeLine.opacity - .6) < .005);
  assert.ok(Math.abs(nativeLine.bounds.x + nativeLine.bounds.width - .82) < .001);
  const savedLine = await roundTrip('native-line-style', [ref(lineDoc)]);
  assert.equal((await call('search_document', { documentId: savedLine.id, query: lineRequest.text })).length, 1);
  assert.equal(hash(pngBytes(linePreview.after)), hash(pngBytes(await call('render_page', { page: ref(savedLine), targetWidth: linePreview.after.width }))));
  passed.push('after-only cached line preview, native real styles, opacity, vector underline and strikeout, exact right alignment and saved searchable text');

  const spacedPreview = await call('preview_line_edit', { request: { ...lineRequest, text: 'HELLO', fontSize: 20, charSpacing: 3 } });
  assert.equal(spacedPreview.canApply, true);
  const spacedDoc = await call('commit_line_preview', { token: spacedPreview.token });
  const savedSpaced = await roundTrip('native-line-spacing', [ref(spacedDoc)]);
  assert.equal((await call('search_document', { documentId: savedSpaced.id, query: 'HELLO' })).length, 1);
  assert.equal((await call('search_pages', { pages: [ref(savedSpaced)], query: 'HELLO' })).length, 1);
  passed.push('inferred letter spacing remains searchable after native line commit, export and reopening');

  const placed = { ...english, contentEdits: [patch(title, { text: 'Exact bounds', bounds: { x: .9, y: .12, width: .03, height: .35 } })], rotation: 90 };
  const placedTitle = (await call('inspect_page_content', { page: placed })).objects.find(object => object.objectIndex === title.objectIndex);
  for (const [key, value] of Object.entries(placed.contentEdits[0].bounds)) assert.ok(Math.abs(placedTitle.bounds[key] - value) < .0001, key);
  await roundTrip('旋转原文定位', [placed]);
  passed.push('source identity across rotation and exact normalized geometry');

  const deleted = { ...page, contentEdits: [patch(title, { deleted: true })] };
  assert.equal((await call('inspect_page_content', { page: deleted })).objects.find(object => object.objectIndex === title.objectIndex).deleted, true);
  const removed = await roundTrip('移除原文对象', [deleted]);
  assert.equal((await call('search_document', { documentId: removed.id, query: title.text })).length, 0);
  assert.equal((await call('inspect_page_content', { page: ref(removed) })).totalObjects, inspection.totalObjects - 1);
  assert.equal((await call('inspect_page_content', { page })).objects.find(object => object.objectIndex === title.objectIndex).text, title.text);
  passed.push('native removal, restoration from immutable source, no painted text cover');

  const red = await call('register_image', { dataUrl: solidPng(255, 0, 0) });
  const green = await call('register_image', { dataUrl: solidPng(0, 255, 0) });
  const withImages = { ...page, overlays: [.15, .55].map((x, index) => ({ id: `original-image-${index}`, assetId: red.id, x, y: .78, width: .2, height: .05, opacity: 1 })) };
  const imageSourcePath = join(output, '双图片来源.pdf');
  await call('save_document', { outputPath: imageSourcePath, pages: [withImages] });
  const imageSource = await call('open_document', { path: imageSourcePath });
  const imagePage = ref(imageSource);
  const images = (await call('inspect_page_content', { page: imagePage })).objects.filter(object => object.kind === 'image');
  assert.equal(images.length, 2);
  const imageEdited = { ...imagePage, contentEdits: [patch(images[0], { replacementAssetId: green.id })] };
  await roundTrip('替换单个原有图片', [imageEdited]);
  passed.push('replace one original image while retaining the other instance and native image objects');

  for (const fields of [{ text: '' }, { text: 'two\nlines' }, { text: '新增文字' }, { text: '😀' }, { fontFamily: 'unknown-rivuleaf-font-040' }, { fontSize: 0 }, { bounds: { x: .9, y: 0, width: .2, height: .1 } }, { fingerprint: 'stale', text: 'Stale' }]) {
    await assert.rejects(call('inspect_page_content', { page: { ...page, contentEdits: [patch(title, fields)] } }));
  }
  const invalidOutput = join(output, '无效修改不得生成.pdf');
  await assert.rejects(call('save_document', { outputPath: invalidOutput, pages: [{ ...page, contentEdits: [patch(title, { text: '新增文字' })] }] }));
  await assert.rejects(stat(invalidOutput));
  await assert.rejects(call('save_document', { outputPath: source, pages: [english] }));
  assert.equal(hash(await readFile(source)), originalHash);
  assert.equal((await call('get_backend_status')).engineReady, true);
  passed.push('invalid/stale edits and unsafe original-font glyphs rejected, output rollback, source protection, worker survives');
  const result = { status: 'PASS', executable, library, outputDirectory: output, originalHash, passed, originalTitle: title, modifiedTitle: changedTitle };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { child.stdin.end(); child.kill(); lines.close(); }
