// SPDX-License-Identifier: MIT OR Apache-2.0
// Exercise actual bounded storage code; no PDF or desktop IPC is mocked here.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(await readFile(new URL('../src/stampLibrary.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports }, { filename: 'src/stampLibrary.ts' });
const { loadStampLibrary, saveStampLibrary, pngFileName, cleanLibraryName, pngByteLength } = exports;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const item = { id: 'one', name: '自定义图章', kind: 'stamp', dataUrl: png, width: 1, height: 1, createdAt: '2026-10-30T00:00:00.000Z' };
let raw = null;
const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
assert.equal(loadStampLibrary(storage).length, 0);
saveStampLibrary([{ ...item, assetId: 'ephemeral-worker-id' }], storage);
assert.ok(!raw.includes('assetId'), 'Worker handles must never enter persistent storage');
assert.equal(loadStampLibrary(storage)[0].name, item.name);
assert.equal(pngByteLength(png), Buffer.from(png.split(',')[1], 'base64').length);
assert.equal(pngFileName('CON'), '_CON.png');
assert.equal(pngFileName('合同:签名?.png'), '合同_签名_.png');
assert.equal(cleanLibraryName(' a\u0000b\n '), 'ab');
assert.equal(Array.from(cleanLibraryName('😀'.repeat(100))).length, 80);

const tooMany = Array.from({ length: 21 }, (_, i) => ({ ...item, id: String(i) }));
assert.throws(() => saveStampLibrary(tooMany, storage), error => error.code === 'count');
const hugePng = 'data:image/png;base64,' + Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(1024 * 1024)]).toString('base64');
assert.throws(() => saveStampLibrary([{ ...item, dataUrl: hugePng }], storage), error => error.code === 'image-size');
const mediumPng = 'data:image/png;base64,' + Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(800_000)]).toString('base64');
assert.throws(() => saveStampLibrary([{ ...item, dataUrl: mediumPng }, { ...item, id: 'two', dataUrl: mediumPng }], storage), error => error.code === 'storage-size');
assert.throws(() => saveStampLibrary([item], { setItem: () => { throw new Error('quota'); } }), error => error.code === 'storage');
assert.throws(() => loadStampLibrary({ getItem: () => 'invalid json' }), error => error.code === 'invalid');
assert.throws(() => loadStampLibrary({ getItem: () => { throw new Error('storage disabled'); } }), error => error.code === 'storage');
assert.throws(() => loadStampLibrary({ getItem: () => JSON.stringify([{ ...item, dataUrl: 'data:image/svg+xml;base64,AA==' }]) }), error => error.code === 'invalid');
assert.throws(() => loadStampLibrary({ getItem: () => JSON.stringify([item, item]) }), error => error.code === 'invalid');
const previousRaw = raw;
assert.throws(() => saveStampLibrary([item, item], storage), error => error.code === 'invalid');
assert.throws(() => saveStampLibrary([{ ...item, name: '\u0000 \n' }], storage), error => error.code === 'invalid');
assert.throws(() => saveStampLibrary([{ ...item, id: '' }], storage), error => error.code === 'invalid');
assert.equal(raw, previousRaw, 'Validation failures must leave existing stored data intact');
// Old libraries stay compatible; new blend metadata is validated and round-trips.
saveStampLibrary([item], storage);
assert.equal(loadStampLibrary(storage)[0].blendMode, undefined);
saveStampLibrary([{ ...item, blendMode: 'multiply', assetId: 'temporary' }], storage);
assert.equal(loadStampLibrary(storage)[0].blendMode, 'multiply');
assert.ok(!raw.includes('assetId'));
const blendRaw = raw;
assert.throws(() => saveStampLibrary([{ ...item, blendMode: 'screen' }], storage), error => error.code === 'invalid');
assert.throws(() => loadStampLibrary({ getItem: () => JSON.stringify([{ ...item, blendMode: 'screen' }]) }), error => error.code === 'invalid');
assert.equal(raw, blendRaw);
console.log('PASS: local PNG library round trip, no persistent worker handles, limits, corruption, storage failure and safe filenames');
