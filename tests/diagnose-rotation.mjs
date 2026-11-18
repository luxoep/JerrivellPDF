// Read-only native rendering diagnostics. Pass an already-written merged PDF.
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'test-results/rotation-diagnostics');
await mkdir(out, { recursive: true });
const child = spawn(join(root, 'src-tauri/target/release/jerrivell-pdf.exe'), ['--pdf-worker', '--pdfium-path', join(root, 'src-tauri/resources/pdfium/bin/pdfium.dll')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let seq = 0;
const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  const msg = JSON.parse(line); const entry = pending.get(msg.id);
  if (entry) { pending.delete(msg.id); msg.error ? entry.reject(new Error(msg.error)) : entry.resolve(msg.result); }
});
function call(command, args = {}) {
  return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, command, args }) + '\n'); });
}
try {
  const original = await call('open_document', { path: join(root, 'fixtures/sample.pdf') });
  const reopened = await call('open_document', { path: resolve(process.argv[2]) });
  const metadata = { original: original.pages, reopened: reopened.pages, comparisons: [] };
  for (const targetWidth of [420, 600, 840, 1200]) {
    for (const [name, page] of [['plan', { documentId: original.id, pageIndex: 2, rotation: 90 }], ['reopened', { documentId: reopened.id, pageIndex: 0, rotation: 0 }]]) {
      const rendered = await call('render_page', { page, targetWidth });
      const path = join(out, `${name}-${targetWidth}.png`);
      await writeFile(path, Buffer.from(rendered.dataUrl.split(',')[1], 'base64'));
      metadata.comparisons.push({ name, targetWidth, width: rendered.width, height: rendered.height, path });
    }
  }
  await writeFile(join(out, 'metadata.json'), JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify(metadata, null, 2));
} finally { child.stdin.end(); child.kill(); lines.close(); }
