// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/editableProject.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports });
const { validateEditableWorkspace, validateLoadedProject, editableAssetIds } = exports;
const clone = value => JSON.parse(JSON.stringify(value));
const workspace = [{ id: 'page-1', documentId: 'source-1', pageIndex: 0, rotation: 90, width: 240, height: 360, sourceName: 'embedded.pdf',
  overlays: [
    { id: 'text-1', assetId: 'image-1', x: .2, y: .2, width: .4, height: .1, opacity: 1,
      textSource: { content: 'Jerry 中文🙂', fontFamily: 'Arial', fontSize: 12, color: '#243746', bold: false, frame: { width: 100, height: 36, autoHeight: false } } },
    { id: 'leader-1', assetId: 'image-2', x: .1, y: .1, width: .2, height: .2, opacity: .8, leaderFor: 'text-1',
      markSource: { color: '#243746', geometry: { tool: 'callout', bounds: { x: .1, y: .1, width: .2, height: .2 },
        points: [{ x: .11, y: .11 }, { x: .25, y: .29 }, { x: .29, y: .29 }], pageWidth: 360, pageHeight: 240, lineWidth: 2, lineStyle: 'dashDot', arrowHeads: 'start' } } },
  ], contentEdits: [{ objectIndex: 0, fingerprint: 'source-object', replacementAssetId: 'image-3' }], decorations: [] }];
const valid = validateEditableWorkspace(workspace);
assert.deepEqual(clone(valid), workspace);
assert.deepEqual([...editableAssetIds(valid)], ['image-1', 'image-2', 'image-3']);
assert.notEqual(valid, workspace, 'Validation returns an isolated snapshot for saving');
valid[0].overlays[0].textSource.content = 'Different';
assert.equal(workspace[0].overlays[0].textSource.content, 'Jerry 中文🙂');

const invalid = change => { const input = clone(workspace); change(input); assert.throws(() => validateEditableWorkspace(input), /PROJECT_INVALID/); };
invalid(pages => pages.push(clone(pages[0])));
invalid(pages => pages[0].overlays[0].width = 1);
invalid(pages => pages[0].overlays[0].textSource.frame.autoHeight = 'yes');
invalid(pages => pages[0].overlays[0].textSource.frame.width = 3);
const compact=clone(workspace);compact[0].overlays[0].textSource.padding=0;compact[0].overlays[0].textSource.frame.width=3;compact[0].overlays[0].textSource.frame.height=3;
assert.equal(validateEditableWorkspace(compact)[0].overlays[0].textSource.padding,0);
invalid(pages => pages[0].overlays[0].textSource.padding = -1);
invalid(pages => pages[0].overlays[0].textSource.padding = 25);
invalid(pages => pages[0].overlays[0].textSource.fontSize = 300);
invalid(pages => pages[0].overlays[0].textSource.content = 'x'.repeat(4001));
invalid(pages => pages[0].overlays[1].leaderFor = 'missing');
invalid(pages => pages[0].overlays[1].leaderFor = 'leader-1');
invalid(pages => pages[0].overlays[1].markSource.geometry.points[0].x = Number.NaN);
invalid(pages => pages[0].overlays[1].markSource.geometry.points = []);
invalid(pages => pages[0].overlays[1].markSource.geometry.arrowHeads = 'triangular');
invalid(pages => pages[0].contentEdits[0].objectIndex = .5);

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const response = { title: 'Portable Jerry', workspace: clone(workspace), documents: [{ id: 'source-1', path: 'memory://project-1/embedded.pdf', fileName: 'embedded.pdf',
  pageCount: 1, fileSize: 1000, pages: [{ index: 0, width: 240, height: 360, rotation: 0 }], warnings: [] }],
  assets: ['image-1', 'image-2', 'image-3'].map(id => ({ id, dataUrl: png, width: 1, height: 1 })) };
const restored = validateLoadedProject(response);
assert.deepEqual(clone(restored), response);
assert.deepEqual(clone(restored.workspace[0].overlays[1].markSource), response.workspace[0].overlays[1].markSource);
for (const change of [data => data.assets.pop(), data => data.workspace[0].documentId = 'not-restored',
  data => data.assets[0].dataUrl = 'https://example.invalid/external.png', data => data.documents[0].pages = [], data => data.assets.push(clone(data.assets[0]))]) {
  const input = clone(response); change(input); assert.throws(() => validateLoadedProject(input), /PROJECT_INVALID/);
}
assert.throws(() => validateEditableWorkspace([]), /PROJECT_INVALID/);
console.log('Editable project validation: source semantics, linked nodes, resource references, isolated save snapshots and malformed responses passed.');
