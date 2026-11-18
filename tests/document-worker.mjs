// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end worker protocol tests: real executable, PDFium and Windows fonts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = resolve(process.argv[2] ?? join(root, 'src-tauri/target/release/jerrivell-pdf.exe'));
const library = resolve(process.argv[3] ?? join(root, 'src-tauri/resources/pdfium/bin/pdfium.dll'));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const output = resolve(process.argv[4] ?? join(root, `test-results/${version}/document-worker`));
await mkdir(output, { recursive: true });
const digest = value => createHash('sha256').update(value).digest('hex');
const source = join(output, 'original.pdf'); await copyFile(join(root, 'fixtures/sample.pdf'), source);
const originalHash = digest(await readFile(source));
const child = spawn(executable, ['--pdf-worker', '--pdfium-path', library], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let sequence = 0; const pending = new Map(), stderr = [], passed = [];
child.stderr.on('data', value => stderr.push(value.toString()));
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let value; try { value = JSON.parse(line); } catch { return; }
  const item = pending.get(value.id);
  if (item) { pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(new Error(value.error)) : item.resolve(value.result); }
});
function fail(error) { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); }
child.on('error', fail); child.on('exit', code => fail(new Error(`Worker exited ${code}: ${stderr.join('')}`)));
function call(command, args = {}) { return new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${command}`)); }, 120_000);
  pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, command, args }) + '\n');
}); }
const ref = (doc, index = 0, rotation = 0) => ({ documentId: doc.id, pageIndex: index, rotation });
const png = image => Buffer.from(image.dataUrl.split(',')[1], 'base64');
async function saveReviewed(name, pages) {
  const report = await call('prepare_export', { parts: [{ name, pages }] });
  const path = join(output, name);
  const saved = await call('save_prepared_export', { token: report.token, paths: [path] });
  assert.equal(saved.failed, 0); assert.equal((await stat(path)).size, report.totalBytes);
  await writeFile(path + '.review.json', JSON.stringify(report, null, 2));
  const doc = await call('open_document', { path }); assert.equal(doc.pageCount, pages.length);
  return { doc, path, report };
}
try {
  assert.equal((await call('get_backend_status')).engineReady, true);
  const doc = await call('open_document', { path: source });
  const blank = await call('generate_pages', { request: { kind: 'blank', width: 595.2756, height: 841.8898, count: 2 } });
  assert.equal(blank.pageCount, 2); assert.ok(blank.path.startsWith('memory://'));
  const reordered = [ref(doc, 2), ref(blank, 0), ref(doc, 0), ref(doc, 0, 90), ref(blank, 1)];
  const reviewed = await saveReviewed('ordered.pdf', reordered);
  assert.ok(reviewed.report.structures.bookmarks > 0); assert.ok(reviewed.report.structures.annotationsAndLinks > 0);
  for (let i = 0; i < reordered.length; i++) {
    const before = await call('render_page', { page: reordered[i], targetWidth: 600 });
    const after = await call('render_page', { page: ref(reviewed.doc, i), targetWidth: 600 });
    assert.equal(digest(png(before)), digest(png(after)), `page ${i + 1} order/blank/rotation/copy`);
  }
  await assert.rejects(call('save_prepared_export', { token: reviewed.report.token, paths: [join(output, 'stale.pdf')] }));
  passed.push('blank pages, duplicate/page order/rotation, exact reviewed byte count, reopened preview pixels, stale export token');

  const rendered = await call('render_page', { page: ref(doc), targetWidth: 320 });
  const imagePath = join(output, 'source-image.png'); await writeFile(imagePath, png(rendered));
  const imageHash = digest(await readFile(imagePath));
  const images = await call('generate_pages', { request: { kind: 'images', paths: [imagePath, imagePath], paper: 'a4', margin: 20 } });
  const imagePdf = await saveReviewed('images.pdf', [ref(images, 1), ref(images, 0)]);
  assert.equal(imagePdf.doc.pageCount, 2); assert.equal(digest(await readFile(imagePath)), imageHash);
  passed.push('two-image native PDF conversion, source image protection and reviewed export');

  const cropBounds = { x: .1, y: .15, width: .7, height: .6 }, cropped = [];
  for (const turn of [0, 90, 180, 270]) {
    const crop = await call('generate_pages', { request: { kind: 'crop', pages: [ref(doc, 0, turn)], bounds: cropBounds } });
    const dimensions = doc.pages[0], [width, height] = turn % 180 ? [dimensions.height, dimensions.width] : [dimensions.width, dimensions.height];
    assert.ok(Math.abs(crop.pages[0].width - width * .7) < .1); assert.ok(Math.abs(crop.pages[0].height - height * .6) < .1);
    cropped.push(ref(crop));
  }
  await saveReviewed('crop-rotations.pdf', cropped);
  passed.push('native CropBox after all four workspace rotations, visible dimensions and export');

  const decorate = (kind, text, fields = {}) => ({ id: kind, kind, text, fontSize: kind === 'number' ? 12 : 35, color: '#555577', opacity: kind === 'number' ? 1 : .25, angle: 0, x: .5, y: kind === 'number' ? .95 : .5, alignment: 'center', ...fields });
  const decorated = { ...ref(doc), decorations: [decorate('number', '1 / 3'), decorate('watermark', '内部资料', { fontFamily: '楷体', angle: -30 })] };
  const decoratedImage = await call('render_page', { page: decorated, targetWidth: 600 });
  const decoratedDoc = await saveReviewed('decorated.pdf', [decorated]);
  assert.equal((await call('search_document', { documentId: decoratedDoc.doc.id, query: '内部资料' })).length, 1);
  assert.equal((await call('search_document', { documentId: decoratedDoc.doc.id, query: '1 / 3' })).length, 1);
  assert.equal(digest(png(decoratedImage)), digest(png(await call('render_page', { page: ref(decoratedDoc.doc), targetWidth: 600 }))));
  passed.push('searchable native page number and Chinese watermark, embedded installed font, opacity/rotation, preview-save equality');

  const inspection = await call('inspect_page_content', { page: ref(doc) });
  const title = inspection.objects.find(item => item.text === 'Make room for clarity.'); assert.ok(title?.editable);
  const request = { page: ref(doc), objects: [{ objectIndex: title.objectIndex, fingerprint: title.fingerprint }], bounds: title.bounds, text: 'Text line revised.', fontSize: 24, color: '#226688', charSpacing: 1.5, alignment: 'center', constrainWidth: false };
  const preview = await call('preview_line_edit', { request }); assert.equal(preview.canApply, true);
  const edited = await call('commit_line_preview', { token: preview.token });
  const line = (await call('inspect_page_content', { page: ref(edited) })).objects.find(item => item.text === request.text);
  assert.ok(line); assert.ok(Math.abs(line.bounds.x + line.bounds.width / 2 - title.bounds.x - title.bounds.width / 2) < .001);
  const lineDoc = await saveReviewed('line-edited.pdf', [ref(edited)]);
  assert.equal(digest(png(preview.after)), digest(png(await call('render_page', { page: ref(lineDoc.doc), targetWidth: preview.after.width }))));
  const overflow = await call('preview_line_edit', { request: { ...request, text: 'W'.repeat(200), constrainWidth: true } });
  assert.equal(overflow.canApply, false); assert.equal(overflow.overflowPage, true);
  await assert.rejects(call('commit_line_preview', { token: overflow.token }));
  await assert.rejects(call('commit_line_preview', { token: preview.token }));
  await assert.rejects(call('preview_line_edit', { request: { ...request, objects: [{ objectIndex: title.objectIndex, fingerprint: 'stale' }] } }));
  passed.push('native text-line replacement, character spacing, centered bounds, exact before/after pixels, overflow/stale identity safeguards');

  const chinesePreview = await call('preview_line_edit', { request: { ...request, text: '文字行修改预览', fontFamily: '楷体', fontSize: 22, charSpacing: 0 } });
  assert.equal(chinesePreview.canApply, true);
  const chineseDoc = await call('commit_line_preview', { token: chinesePreview.token });
  const chineseSaved = await saveReviewed('line-chinese.pdf', [ref(chineseDoc)]);
  assert.equal((await call('search_document', { documentId: chineseSaved.doc.id, query: '文字行修改预览' })).length, 1);
  assert.equal((await call('search_document', { documentId: chineseSaved.doc.id, query: title.text })).length, 0);
  passed.push('Chinese line replacement with editable installed TrueType font, searchable Unicode and original text removal');

  const parts = [{ name: 'split-01.pdf', pages: [ref(doc, 2)] }, { name: 'split-02.pdf', pages: [ref(doc, 0), ref(doc, 1)] }];
  const batch = await call('prepare_export', { parts });
  const batchPaths = parts.map(part => join(output, part.name));
  // Use a deliberately existing file before the successful batch; it must not write earlier destinations.
  const blocker = join(output, 'keep.pdf'); await writeFile(blocker, 'keep');
  await assert.rejects(call('save_prepared_export', { token: batch.token, paths: [join(output, 'must-not-exist.pdf'), blocker] }));
  await assert.rejects(stat(join(output, 'must-not-exist.pdf'))); assert.equal((await readFile(blocker)).toString(), 'keep');
  const batchResult = await call('save_prepared_export', { token: batch.token, paths: batchPaths }); assert.equal(batchResult.succeeded, 2);
  for (let index = 0; index < batchPaths.length; index++) assert.equal((await stat(batchPaths[index])).size, batch.outputs[index].bytes);
  passed.push('batch split output, all-path collision precheck, no-clobber and exact per-file byte counts');

  assert.equal(digest(await readFile(source)), originalHash);
  await call('close_all_documents'); await assert.rejects(call('render_page', { page: ref(doc), targetWidth: 200 }));
  passed.push('original PDF unchanged and session cleanup');
  const summary = { status: 'PASS', executable, output, cases: passed.length, passed, originalSha256: originalHash };
  await writeFile(join(output, 'results.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
} finally { child.stdin.end(); child.kill(); lines.close(); }
