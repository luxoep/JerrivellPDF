// SPDX-License-Identifier: GPL-3.0-or-later
// Native spooler verification is opt-in and hard-codes Microsoft Print to PDF.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

const rasterOnly = process.argv.includes('--raster-only');
if (!process.argv.includes('--virtual-pdf') && !rasterOnly) {
  console.log(JSON.stringify({ status: 'SKIPPED', reason: 'Add --virtual-pdf to explicitly test Microsoft Print to PDF, or --raster-only to check its render pipeline without creating any print job.' }, null, 2));
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : path.resolve(process.argv[index + 1]);
}
const executable = argument('--exe', path.join(root, 'src-tauri/target/release/jerrivell-pdf.exe'));
const library = argument('--dll', path.join(root, 'src-tauri/resources/pdfium/bin/pdfium.dll'));
const releaseVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const releaseResults = path.join(root, 'test-results', releaseVersion);
const directory = path.join(releaseResults, `native-printing-${Date.now()}`);
await mkdir(directory, { recursive: true });
const hash = data => createHash('sha256').update(data).digest('hex');

// Original, deliberately asymmetric color targets; no external fonts/assets.
function pdf(pages) {
  const objects = ['', '<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids = [];
  for (const { width, height, rotation = 0, content } of pages) {
    const page = objects.length;
    kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${rotation} /Resources << >> /Contents ${page + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`;
  let body = '%PDF-1.7\n';
  const offsets = [0];
  for (let index = 1; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body));
    body += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
const source = path.join(directory, 'original-color-targets.pdf');
const stampSource = path.join(directory, 'original-fragment.pdf');
await writeFile(source, pdf([
  { width: 72, height: 144, content: '0.9 0.6 0.2 rg 0 0 72 144 re f\n0 0 0 rg 0 0 9 9 re f\n1 1 1 rg 7 40 58 12 re f' },
  { width: 216, height: 72, content: '0.2 0.75 0.35 rg 0 0 216 72 re f\n0 0 0 rg 0 0 9 9 re f\n1 1 1 rg 150 8 12 56 re f' },
  { width: 72, height: 144, rotation: 90, content: '0.2 0.35 0.9 rg 0 0 72 144 re f\n0 0 0 rg 0 0 9 9 re f\n1 1 1 rg 7 40 58 12 re f' },
]));
await writeFile(stampSource, pdf([{ width: 100, height: 100, content: '1 1 1 rg 0 0 100 100 re f\n0.9 0.05 0.05 rg 15 15 70 70 re f\n0 0 0 rg 10 5 80 3 re f' }]));
const sourceHash = hash(await readFile(source));

function runPrint(job) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--print-worker', '--pdfium-path', library], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let output = '', diagnostic = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native virtual-print check exceeded 90 seconds; inspect the Windows queue.')); }, 90_000);
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 65536) child.kill(); });
    child.stderr.on('data', bytes => { if (diagnostic.length < 4096) diagnostic += bytes; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      try { assert.equal(code, 0, diagnostic); resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${JSON.stringify(job)}\n`);
  });
}
async function awaitPdf(file) {
  for (let retry = 0; retry < 100; retry++) {
    try {
      const bytes = await readFile(file);
      if (bytes.length > 100 && bytes.subarray(0, 5).toString() === '%PDF-' && bytes.includes(Buffer.from('%%EOF'))) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Virtual printer did not finish output: ${file}`);
}
function worker() {
  const child = spawn(executable, ['--pdf-worker', '--pdfium-path', library], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let nextId = 1;
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line), entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id); clearTimeout(entry.timer);
    if (response.error) entry.reject(new Error(response.error)); else entry.resolve(response.result);
  });
  child.on('error', error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
  return {
    request(command, args) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`PDF worker timed out: ${command}`)); }, 60_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, command, args })}\n`);
      });
    },
    close() { child.stdin.end(); child.kill(); for (const entry of pending.values()) clearTimeout(entry.timer); },
  };
}

const native = worker();
const multiplied = path.join(directory, 'prepared-multiply.pdf');
try {
  const document = await native.request('open_document', { path: source, password: null });
  const fragment = await native.request('import_pdf_stamp', { path: stampSource, pageIndex: 0, removeWhiteBackground: false, trimTransparentMargins: false, crop: null });
  const pages = [0, 1, 2].map(pageIndex => ({ documentId: document.id, pageIndex, rotation: 0, overlays: [] }));
  pages[0].overlays.push({ id: 'multiply-verification', assetId: fragment.id, x: 0.2, y: 0.15, width: 0.5, height: 0.3, opacity: 0.75, rotation: 0, blendMode: 'multiply' });
  await native.request('save_document', { pages, outputPath: multiplied });
} finally { native.close(); }

const base = { pdfPath: source, options: { scale: 'fit', orientation: 'auto', copies: 1 }, owner: 0, jobName: '页澜 PDF 打印验收 · Original color targets' };
const checks = [];
for (const [name, options] of [['copies-zero', { copies: 0 }], ['copies-over-limit', { copies: 100 }], ['bad-scale', { scale: 'invalid' }], ['bad-orientation', { orientation: 'invalid' }]]) {
  const reply = await runPrint({ ...base, options: { ...base.options, ...options }, testOutputPath: path.join(directory, `${name}.pdf`) });
  assert.equal(reply.result, null); assert.ok(reply.error, name); checks.push(`${name} rejected before any spool job`);
}
const protectedFile = path.join(directory, 'existing-output.pdf');
const protectedBytes = Buffer.from('existing file must not be replaced');
await writeFile(protectedFile, protectedBytes);
const refused = await runPrint({ ...base, testOutputPath: protectedFile });
assert.equal(refused.result, null); assert.match(refused.error, /覆盖/);
assert.deepEqual(await readFile(protectedFile), protectedBytes);
checks.push('existing output file overwrite rejected with bytes unchanged');

if (rasterOnly) {
  const outputs = [];
  for (const [name, input] of [['original', source], ['multiply', multiplied]]) {
    const rasters = path.join(directory, `rasters-${name}`);
    await mkdir(rasters);
    const reply = await runPrint({ ...base, pdfPath: input, testRasterDirectory: rasters });
    assert.equal(reply.error, null, reply.error);
    assert.equal(reply.result.status, 'rendered');
    assert.equal(reply.result.pageCount, 3);
    const manifest = JSON.parse(await readFile(path.join(rasters, 'rasters.json'), 'utf8'));
    assert.equal(manifest.createdSpoolJob, false);
    assert.equal(manifest.pages.length, 3);
    outputs.push({ name, input, directory: rasters, result: reply.result, pages: manifest.pages });
  }
  assert.equal(hash(await readFile(source)), sourceHash);
  const result = { status: 'PASS', mode: 'headless-raster', createdSpoolJob: false,
    executable, library, outputDirectory: directory, source, multiplied, checks, outputs,
    scope: 'Same production PDFium print configuration and BGRA buffer; this does not validate native printer dialogs, GDI submission or physical output.' };
  await writeFile(path.join(directory, 'native-raster.json'), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(path.join(releaseResults, 'native-raster.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const cases = [
  ['fit-auto', source, { scale: 'fit', orientation: 'auto', copies: 1 }],
  ['actual-auto', source, { scale: 'actual', orientation: 'auto', copies: 1 }],
  ['fit-auto-two-copies', source, { scale: 'fit', orientation: 'auto', copies: 2 }],
  ['actual-portrait', source, { scale: 'actual', orientation: 'portrait', copies: 1 }],
  ['multiply-fit-auto', multiplied, { scale: 'fit', orientation: 'auto', copies: 1 }],
];
const outputs = [];
for (const [name, input, options] of cases) {
  const output = path.join(directory, `${name}.pdf`);
  const reply = await runPrint({ ...base, pdfPath: input, options, testOutputPath: output });
  assert.equal(reply.error, null, reply.error);
  assert.equal(reply.result.status, 'printed'); assert.equal(reply.result.pageCount, 3); assert.equal(reply.result.copies, options.copies);
  await awaitPdf(output);
  outputs.push({ name, input, output, options, result: reply.result, bytes: (await stat(output)).size });
  checks.push(`${name} accepted by Microsoft Print to PDF and produced a complete PDF`);
}
assert.equal(hash(await readFile(source)), sourceHash);
checks.push('original source PDF bytes unchanged');
const result = { status: 'PASS', printer: 'Microsoft Print to PDF', executable, library, outputDirectory: directory, source, multiplied, checks, outputs, scope: 'Explicit virtual printer only; no physical printer was selected. Submission is not proof of physical output or general font fidelity.' };
await writeFile(path.join(directory, 'native-printing.json'), `${JSON.stringify(result, null, 2)}\n`);
await writeFile(path.join(releaseResults, 'native-printing.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
