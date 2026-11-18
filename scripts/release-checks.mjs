// SPDX-License-Identifier: MIT OR Apache-2.0
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
export const executable = join(root, 'src-tauri/target/release/jerrivell-pdf.exe');
export const library = join(root, 'src-tauri/resources/pdfium/bin/pdfium.dll');
export const installer = join(root, `src-tauri/target/release/bundle/nsis/Jerrivell PDF_${version}_x64-setup.exe`);
export const gatePath = join(root, `test-results/${version}/release-gate.json`);
export const digest = path => readFile(path).then(data => createHash('sha256').update(data).digest('hex'));

// Includes shipped resources and all code/checks that establish the gate.
// Documentation and generated build/test outputs do not affect executable behavior.
export async function sourceDigest() {
  const files = ['package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts',
    'rust-toolchain.toml', 'LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'THIRD_PARTY_NOTICES.md', 'src-tauri/build.rs',
    'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'src-tauri/windows-hooks.nsh'];
  async function walk(folder) {
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unexpected release input: ${path}`);
    }
  }
  for (const folder of ['src', 'src-tauri/src', 'src-tauri/capabilities', 'src-tauri/icons',
    'src-tauri/resources/pdfium', 'licenses', 'tests', 'scripts', 'fixtures', 'tools']) await walk(folder);
  const hash = createHash('sha256');
  for (const path of files.sort()) hash.update(`${path}\0${await digest(join(root, path))}\n`);
  return hash.digest('hex');
}

export function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} ${args[0] ?? ''} failed (${signal ?? code})`)));
  });
}

export async function frontendChecks() {
  const names = ['frontend-queue', 'frontend-pages-i18n', 'local-font-canvas', 'overlay-geometry',
    'original-content', 'pdf-stamp-editor', 'precise-editor', 'printing', 'reader-experience',
    'stamp-library', 'document-tools', 'live-preview', 'workbench-experience', 'multi-region', 'performance'];
  for (const name of names) await run(process.execPath, [`tests/${name}.mjs`]);
  return names;
}

export async function integrationChecks(exe = executable, dll = library) {
  // Batch-export tests refuse overwrites; each run owns an unused output folder.
  const output = join(root, `test-results/${version}/integration-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(output, { recursive: true });
  const names = ['live-worker', 'pdf-fragment-workflow', 'image-edit-workflow', 'worker-smoke', 'original-worker', 'document-worker'];
  for (const name of names) await run(process.execPath, [`tests/${name}.mjs`, exe, dll, join(output, name)]);
  const result = { status: 'PASS', executable: exe, output, tests: names };
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2));
  return { ...result, output: relative(root, output).replaceAll('\\', '/') };
}
