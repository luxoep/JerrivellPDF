// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const fonts = [], draws = [], loads = [], images = [];
const context = {
  set font(value) { fonts.push(value); },
  get font() { return fonts.at(-1); },
  measureText: text => ({ width: text.length * 20 }),
  fillText: (...args) => draws.push(args),
  drawImage: (...args) => images.push(args),
  getImageData(_left, _top, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    data[(30 * width + 80) * 4 + 3] = 255;
    data[(70 * width + 320) * 4 + 3] = 255;
    return { data };
  },
  beginPath() {}, arc() {}, stroke() {}, strokeRect() {}, fill() {}, moveTo() {}, lineTo() {}, closePath() {}, save() {}, restore() {}, translate() {}, rotate() {},
};
const document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,AA==' }),
  fonts: { load: async (...args) => { loads.push(args); return []; } },
};
class OfflineImage {
  naturalWidth = 2400;
  naturalHeight = 1200;
  async decode() { if (this.src !== 'data:image/png;base64,AA==') throw new Error('Unreadable local PNG'); }
}
const output = {};
vm.runInNewContext(ts.transpileModule(await readFile(new URL('../src/components/overlayCanvas.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: output, document, Image: OfflineImage, Error, setTimeout, clearTimeout });
const { cssFontFamily, createTextPng, createStampPng, ensureFontReady, preferredSystemFont, createTypedSignaturePng, formatSignatureTimestamp, timestampedSignaturePng } = output;
assert.equal(cssFontFamily('仿宋'), '"仿宋", sans-serif');
assert.equal(cssFontFamily('Quoted "Font"'), '"Quoted \\"Font\\"", sans-serif');
assert.match(cssFontFamily('\n\r'), /^"Century Gothic", "Microsoft YaHei UI",.*sans-serif$/);
assert.equal(preferredSystemFont(['Arial','Microsoft YaHei UI','century gothic']), 'century gothic');
assert.equal(preferredSystemFont(['Arial','Microsoft YaHei UI']), 'Microsoft YaHei UI');
await ensureFontReady('仿宋', '中文 TEST', true);
assert.equal(loads.length, 1);
assert.equal(loads[0][0], '600 24px "仿宋", sans-serif');
assert.equal(loads[0][1], '中文 TEST');
createTextPng('第一行\nSecond line', '#222222', 18, false, '楷体');
assert.ok(fonts.every(value => value.includes('"楷体"')));
assert.deepEqual(draws.map(args => args[0]), ['第一行', 'Second line']);
fonts.length = 0; draws.length = 0;
createStampPng('本机文字图章', 'TEST', '#b00000', 'round', '仿宋');
assert.ok(fonts.length && fonts.every(value => value.includes('"仿宋"')));
fonts.length = 0;
createStampPng('Custom stamp', 'TEST', '#b00000', 'rectangle', 'Times New Roman');
assert.ok(fonts.length && fonts.every(value => value.includes('"Times New Roman"')));
console.log('PASS: safe local-family quoting, font readiness, text/multiline drawing and both stamp layouts use the selected family');

fonts.length = 0; draws.length = 0; images.length = 0;
assert.equal(createTypedSignaturePng('   ', '#223344'), null);
const ink = createTypedSignaturePng('  Jerry 梁  ', '#223344');
assert.ok(ink.width < 880 && ink.height < 170, 'Typed signature is trimmed to the ink');
assert.match(fonts.at(-1), /Segoe Script/);
assert.equal(draws.at(-1)[0], 'Jerry 梁');

const originalZone = process.env.TZ;
try {
  const signingTime = new Date('2026-11-25T20:49:13Z');
  process.env.TZ = 'Asia/Shanghai';
  assert.equal(formatSignatureTimestamp(signingTime), '2026-11-26 04:49:13  UTC+08:00');
  process.env.TZ = 'Asia/Kathmandu';
  assert.equal(formatSignatureTimestamp(signingTime), '2026-11-26 02:34:13  UTC+05:45');
  process.env.TZ = 'America/St_Johns';
  const signed = await timestampedSignaturePng(ink.dataUrl, signingTime);
  assert.equal(draws.at(-1)[0], '2026-11-25 17:19:13  UTC-03:30');
  assert.equal(signed.width, 640);
  assert.equal(signed.height, 367);
  assert.deepEqual(images.at(-1).slice(1), [20, 10, 600, 300], 'Imported ink retains its aspect ratio');
  assert.equal(ink.height < signed.height, true, 'The undated template keeps its cropped dimensions');
  await timestampedSignaturePng(ink.dataUrl, new Date('2026-07-25T20:49:14Z'));
  assert.equal(draws.at(-1)[0], '2026-07-25 18:19:14  UTC-02:30', 'A reused template receives the new time and DST offset');
  await assert.rejects(timestampedSignaturePng('https://example.invalid/logo.png', signingTime), /SIGNATURE_IMAGE_INVALID/);
  await assert.rejects(timestampedSignaturePng('data:image/png;base64,broken', signingTime), /SIGNATURE_IMAGE_INVALID/);
} finally {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
}
console.log('PASS: signature template trimming, separate local signing times and UTC offsets, and PNG size/aspect/caption');
