// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sourceDigest, digest, executable, library, installer, gatePath, version } from './release-checks.mjs';

try {
  const gate = JSON.parse(await readFile(gatePath, 'utf8'));
  assert.equal(gate.status, 'PASS'); assert.equal(gate.version, version);
  assert.equal(await sourceDigest(), gate.sourceSha256, 'Source/checks/resources changed after verification');
  assert.equal(await digest(executable), gate.executableSha256, 'Executable changed after verification');
  assert.equal(await digest(installer), gate.installerSha256, 'Installer changed after verification');
  assert.equal(await digest(library), gate.pdfiumSha256, 'PDFium changed after verification');
  console.log('PASS: this source, executable, installer and PDFium passed the release gate');
} catch (error) {
  console.error(`Release gate missing or stale. Run npm run build:desktop before packaging.\n${error.message}`);
  process.exitCode = 1;
}
