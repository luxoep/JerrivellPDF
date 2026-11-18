// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { frontendChecks, integrationChecks, run, sourceDigest, digest, executable,
  library, installer, gatePath, version } from './release-checks.mjs';
import { selfTest, checkLicensePolicy } from './check-license-policy.mjs';

// A failed retry must not leave a previous successful gate available to package.
await rm(gatePath, { force: true });
const sourceSha256 = await sourceDigest();
selfTest();
const licenseReport = checkLicensePolicy();
const licensePath = `test-results/${version}/license-policy.json`;
await mkdir(dirname(licensePath), { recursive: true });
await writeFile(licensePath, JSON.stringify(licenseReport, null, 2));
const licensePolicy = { status: licenseReport.status, ownLicense: licenseReport.ownLicense,
  windowsRustPackages: licenseReport.windowsRustPackages, shippedNpmPackages: licenseReport.shippedNpmPackages,
  reportSha256: await digest(licensePath) };
console.log('PASS: Windows license policy and expression checks', JSON.stringify(licensePolicy));
const frontend = await frontendChecks();
await run('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml']);
await run(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--bundles', 'nsis']);
const integration = await integrationChecks();
assert.equal(await sourceDigest(), sourceSha256, 'Source/resources changed during build: rerun the release checks');
const result = { status: 'PASS', version, completedAt: new Date().toISOString(), sourceSha256,
  executableSha256: await digest(executable), installerSha256: await digest(installer),
  pdfiumSha256: await digest(library), licensePolicy, frontend, rust: 'cargo test --locked', integration };
await mkdir(dirname(gatePath), { recursive: true });
await writeFile(gatePath, JSON.stringify(result, null, 2));
console.log(`PASS: release gate saved at ${gatePath}`);
