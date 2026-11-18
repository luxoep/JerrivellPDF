// Real executable / native PDFium integration checks. No browser or mocked IPC.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, copyFile, readFile, writeFile, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = resolve(process.argv[2] ?? join(root, 'src-tauri/target/release/jerrivell-pdf.exe'));
const library = resolve(process.argv[3] ?? join(root, 'src-tauri/resources/pdfium/bin/pdfium.dll'));
const output = await mkdtemp(join(tmpdir(), 'rivuleaf-smoke-'));
const source = join(output, '中文 合同 sample.pdf');
await copyFile(join(root, 'fixtures/sample.pdf'), source);
const originalHash = createHash('sha256').update(await readFile(source)).digest('hex');
const child = spawn(executable, ['--pdf-worker', '--pdfium-path', library], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let sequence = 0;
const pending = new Map();
const stderr = [];
child.stderr.on('data', chunk => stderr.push(chunk.toString()));
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const entry = pending.get(message.id);
  if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result); }
});
child.on('error', error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); });
child.on('exit', code => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Worker exited: ' + code + ' ' + stderr.join(''))); } pending.clear(); });
function call(command, args = {}) {
  return new Promise((resolveResponse, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timed out: ' + command)); }, 45_000);
    pending.set(id, { resolve: resolveResponse, reject, timer });
    child.stdin.write(JSON.stringify({ id, command, args }) + '\n');
  });
}
function pngDimensions(data) {
  assert.equal(data.subarray(1, 4).toString(), 'PNG');
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}
const passed = [];
try {
  const status = await call('get_backend_status');
  assert.equal(status.engineReady, true);
  passed.push('native engine startup');
  const document = await call('open_document', { path: source });
  assert.equal(document.pageCount, 3);
  assert.equal(document.pages.length, 3);
  passed.push('Unicode + space path / 3-page fixture');
  const page = { documentId: document.id, pageIndex: 0, rotation: 0 };
  const rendered = await call('render_page', { page, targetWidth: 800 });
  assert.ok(rendered.dataUrl.startsWith('data:image/png;base64,'));
  assert.deepEqual(pngDimensions(Buffer.from(rendered.dataUrl.split(',')[1], 'base64')), [rendered.width, rendered.height]);
  assert.equal(rendered.width, 800);
  passed.push('actual PNG rendering');
  const matches = await call('search_document', { documentId: document.id, query: 'Rivuleaf PDF' });
  assert.ok(matches.length > 0);
  const aurora = await call('search_document', { documentId: document.id, query: 'aurora' });
  assert.equal(aurora.reduce((sum, hit) => sum + hit.matchCount, 0), 3);
  passed.push('text search');
  const second = await call('open_document', { path: join(root, 'fixtures/second.pdf') });
  const combinedPath = join(output, '完整合并5页.pdf');
  const combinedPlan = [document, second].flatMap(doc => doc.pages.map(item => ({ documentId: doc.id, pageIndex: item.index, rotation: 0 })));
  await call('save_document', { outputPath: combinedPath, pages: combinedPlan });
  const combined = await call('open_document', { path: combinedPath });
  assert.equal(combined.pageCount, 5);
  for (const [query, expectedPage] of [['MERGE-ONE', 3], ['MERGE-TWO', 4]]) {
    const hits = await call('search_document', { documentId: combined.id, query });
    assert.deepEqual(hits.map(hit => hit.pageIndex), [expectedPage]);
  }
  passed.push('complete 3 + 2 page merge / searchable page order');
  const plan = [
    { documentId: document.id, pageIndex: 2, rotation: 90 },
    { documentId: second.id, pageIndex: 0, rotation: 0 },
    page,
  ];
  const savedPath = join(output, '重排 合并结果.pdf');
  const saved = await call('save_document', { outputPath: savedPath, pages: plan });
  assert.equal(saved.pageCount, plan.length);
  assert.ok((await stat(savedPath)).size > 0);
  const reopened = await call('open_document', { path: savedPath });
  assert.equal(reopened.pageCount, 3);
  const firstOfOutput = await call('render_page', { page: { documentId: reopened.id, pageIndex: 0, rotation: 0 }, targetWidth: 600 });
  const firstOfPlan = await call('render_page', { page: plan[0], targetWidth: 600 });
  assert.deepEqual([firstOfOutput.width, firstOfOutput.height], [firstOfPlan.width, firstOfPlan.height]);
  const renderedHash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(renderedHash(firstOfOutput.dataUrl), renderedHash(firstOfPlan.dataUrl), 'Saved rotation must render identically to the workspace plan');
  const outputHits = await call('search_document', { documentId: reopened.id, query: 'Rivuleaf PDF' });
  assert.ok(outputHits.length > 0);
  passed.push('merge + reorder + rotation / reopen / pixels and searchable text');
  const imagePath = join(output, '导出.png');
  await call('export_page', { page, targetWidth: 1000, outputPath: imagePath });
  assert.equal(pngDimensions(await readFile(imagePath))[0], 1000);
  passed.push('PNG export');
  // Exercise asset RPC and native PDF overlays through the actual worker process.
  const assetPath = join(output, '原创图形.png');
  await copyFile(join(root, 'src-tauri/icons/32x32.png'), assetPath);
  const assetData = 'data:image/png;base64,' + (await readFile(assetPath)).toString('base64');
  const asset = await call('register_image', { dataUrl: assetData });
  assert.equal(asset.width, 32);
  assert.equal(asset.height, 32);
  assert.equal((await call('register_image', { dataUrl: assetData })).id, asset.id);
  const importedAsset = await call('import_image', { path: assetPath });
  assert.equal(importedAsset.id, asset.id);
  const stampedPage = { ...page, overlays: [{ id: 'test-overlay', assetId: asset.id, x: 0.12, y: 0.18, width: 0.28, height: 0.18, opacity: 0.6, rotation: 90 }] };
  const overlayPreview = await call('render_page', { page: stampedPage, targetWidth: 600 });
  const plainPreview = await call('render_page', { page, targetWidth: 600 });
  assert.notEqual(renderedHash(overlayPreview.dataUrl), renderedHash(plainPreview.dataUrl));
  const overlayPath = join(output, '添加内容.pdf');
  await call('save_document', { outputPath: overlayPath, pages: [stampedPage] });
  const overlayDocument = await call('open_document', { path: overlayPath });
  const overlayReopened = await call('render_page', { page: { documentId: overlayDocument.id, pageIndex: 0, rotation: 0 }, targetWidth: 600 });
  assert.equal(renderedHash(overlayPreview.dataUrl), renderedHash(overlayReopened.dataUrl));
  assert.ok((await call('search_document', { documentId: overlayDocument.id, query: 'Rivuleaf PDF' })).length > 0);
  const exportedAsset = join(output, '图章导出.png');
  await call('export_image', { assetId: asset.id, outputPath: exportedAsset });
  assert.deepEqual(pngDimensions(await readFile(exportedAsset)), [32, 32]);
  await assert.rejects(call('export_image', { assetId: asset.id, outputPath: assetPath }));
  await assert.rejects(call('render_page', { page: { ...page, overlays: [{ ...stampedPage.overlays[0], width: 1.2 }] }, targetWidth: 600 }));
  await assert.rejects(call('register_image', { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }));
  passed.push('PNG asset import / registration deduplication / export / imported asset protection');
  passed.push('transparent rotated overlay / save and reopen identical pixels / source text retained');
  passed.push('invalid overlay geometry and unsupported asset rejected');
  // This PDF is never opened as a source document: fragment import must protect
  // its own source path independently of the ordinary document registry.
  const fragmentSource = join(output, 'PDF片段来源.pdf');
  await copyFile(join(root, 'fixtures/second.pdf'), fragmentSource);
  const fragmentSourceHash = renderedHash(await readFile(fragmentSource));
  const fragment = await call('import_pdf_stamp', { path: fragmentSource, pageIndex: 1, removeWhiteBackground: false, trimTransparentMargins: false, crop: { x: 0.04, y: 0.04, width: 0.9, height: 0.35 } });
  assert.equal(fragment.pageCount, 2);
  assert.ok(fragment.width > fragment.height && fragment.height > 50);
  assert.ok(Math.abs(fragment.width / fragment.height - (0.9 * 612) / (0.35 * 792)) < 0.02, 'Selected PDF region must keep its visual aspect ratio');
  const fragmentPage = { ...page, overlays: [{ id: 'pdf-fragment', assetId: fragment.id, x: 0.2, y: 0.45, width: 0.5, height: 0.5 * (595 / 842) * fragment.height / fragment.width, opacity: 1, blendMode: 'multiply' }] };
  const fragmentPreview = await call('render_page', { page: fragmentPage, targetWidth: 600 });
  assert.notEqual(renderedHash(fragmentPreview.dataUrl), renderedHash(plainPreview.dataUrl));
  const fragmentPath = join(output, 'PDF片段正片叠底.pdf');
  await call('save_document', { outputPath: fragmentPath, pages: [fragmentPage] });
  const fragmentDocument = await call('open_document', { path: fragmentPath });
  const fragmentReopened = await call('render_page', { page: { documentId: fragmentDocument.id, pageIndex: 0, rotation: 0 }, targetWidth: 600 });
  assert.equal(renderedHash(fragmentPreview.dataUrl), renderedHash(fragmentReopened.dataUrl));
  assert.ok((await call('search_document', { documentId: fragmentDocument.id, query: 'PAGE-ONE' })).length > 0);
  await call('export_image', { assetId: fragment.id, outputPath: join(output, 'PDF片段导出.png') });
  passed.push('PDF region import / page selection / PNG asset export');
  passed.push('Multiply PDF fragment overlay / save and reopen identical pixels / destination text retained');
  await assert.rejects(call('import_pdf_stamp', { path: fragmentSource, pageIndex: 99, removeWhiteBackground: false, trimTransparentMargins: true }));
  await assert.rejects(call('import_pdf_stamp', { path: fragmentSource, pageIndex: 0, removeWhiteBackground: false, trimTransparentMargins: true, crop: { x: 0.5, y: 0, width: 0.8, height: 1 } }));
  await assert.rejects(call('render_page', { page: { ...fragmentPage, overlays: [{ ...fragmentPage.overlays[0], blendMode: 'screen' }] }, targetWidth: 600 }));
  await assert.rejects(call('save_document', { outputPath: fragmentSource, pages: [page] }));
  await assert.rejects(call('export_image', { assetId: fragment.id, outputPath: fragmentSource }));
  const fragmentAlias = join(output, 'PDF片段来源-hardlink.pdf');
  await link(fragmentSource, fragmentAlias);
  await assert.rejects(call('save_document', { outputPath: fragmentAlias, pages: [page] }));
  const fragmentPngAlias = join(output, 'PDF片段来源-hardlink.png');
  await link(fragmentSource, fragmentPngAlias);
  await assert.rejects(call('export_image', { assetId: fragment.id, outputPath: fragmentPngAlias }), /为保护来源文件/);
  assert.equal(renderedHash(await readFile(fragmentSource)), fragmentSourceHash);
  passed.push('PDF fragment source and hard-link protection / invalid crop, page and blend mode rejected');
  await assert.rejects(call('save_document', { outputPath: source, pages: [page] }));
  const alias = join(output, 'source-hardlink.pdf');
  await link(source, alias);
  await assert.rejects(call('save_document', { outputPath: alias, pages: [page] }));
  passed.push('source and hard-link overwrite blocked');
  const invalidOutput = join(output, 'should-not-exist.pdf');
  await assert.rejects(call('save_document', { outputPath: invalidOutput, pages: [] }));
  await assert.rejects(stat(invalidOutput));
  await assert.rejects(call('render_page', { page: { ...page, pageIndex: 99 }, targetWidth: 800 }));
  await assert.rejects(call('render_page', { page: { ...page, rotation: 45 }, targetWidth: 800 }));
  const invalidInput = join(output, 'invalid.pdf');
  await writeFile(invalidInput, 'not a PDF');
  await assert.rejects(call('open_document', { path: invalidInput }), error => !error.message.includes('PASSWORD_REQUIRED'));
  assert.equal((await call('get_backend_status')).engineReady, true);
  passed.push('invalid input and operations rejected / worker remains healthy');
  assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), originalHash);
  passed.push('source bytes remain unchanged');
  await call('close_all_documents');
  await assert.rejects(call('render_page', { page, targetWidth: 800 }));
  await assert.rejects(call('export_image', { assetId: asset.id, outputPath: join(output, 'expired.png') }));
  await assert.rejects(call('export_image', { assetId: fragment.id, outputPath: join(output, 'expired-fragment.png') }));
  passed.push('closed document handles rejected');
  console.log(JSON.stringify({ executable, library, outputDirectory: output, passed, status: 'PASS' }, null, 2));
} finally {
  child.stdin.end();
  child.kill();
  lines.close();
}
