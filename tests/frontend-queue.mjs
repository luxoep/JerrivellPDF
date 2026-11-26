// SPDX-License-Identifier: MIT OR Apache-2.0
// Test the real TypeScript queue without a webview, using only a mocked IPC edge.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/backend.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
const calls = [];
const edge = new EventTarget();
const context = vm.createContext({
  exports, window: edge, CustomEvent, Error, console,
  require(name) {
    assert.equal(name, '@tauri-apps/api/core');
    return { invoke(command, args) {
      return new Promise((resolve, reject) => calls.push({ command, args, resolve, reject }));
    } };
  },
});
vm.runInContext(compiled, context, { filename: fileURLToPath(new URL('../src/backend.ts', import.meta.url)) });
const { backend, renderPage, resetBackendQueue, cancelledRequest, sessionInvalidatedEvent } = exports;
// Workspace locking affects interaction only. It must not reach strict native
// PageOverlay JSON or change the visible PDF render/cache identity.
const lockedReference = exports.pageReference({ documentId: 'locked', pageIndex: 0, rotation: 0,
  overlays: [{ id: 'overlay', assetId: 'image', x: .1, y: .1, width: .2, height: .2, opacity: 1, locked: true, blendMode: 'multiply' }] });
assert.equal('locked' in lockedReference.overlays[0], false);
assert.equal(lockedReference.overlays[0].blendMode, 'multiply');

const featureOverlay = { id: 'cutout', assetId: 'tinted-image', x: .1, y: .2, width: .3, height: .4,
  opacity: .8, blendMode: 'normal', rotation: 90 };
const cutout = { ...featureOverlay, featureSource: { assetId: 'original-image' } };
const cutoutPage = { documentId: 'cut-page', pageIndex: 0, rotation: 0, overlays: [cutout] };
assert.deepEqual(JSON.parse(JSON.stringify(exports.pageReference(cutoutPage).overlays)), [featureOverlay]);
assert.equal(cutout.featureSource.assetId, 'original-image');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const next = () => { assert.ok(calls.length, 'expected a native invocation'); return calls.shift(); };

// Native operations are serialized, while user actions overtake queued thumbnails.
const first = backend('running', {}, 0);
const thumbnail = backend('thumbnail', {}, 0);
const save = backend('save', {}, 3);
assert.equal(calls.length, 1);
const running = next(); assert.equal(running.command, 'running'); running.resolve('first');
assert.equal(await first, 'first'); await flush();
const saveCall = next(); assert.equal(saveCall.command, 'save'); saveCall.resolve('saved');
assert.equal(await save, 'saved'); await flush();
const thumbnailCall = next(); assert.equal(thumbnailCall.command, 'thumbnail'); thumbnailCall.resolve('thumbnail');
await thumbnail; await flush();

// Identical render requests share an invocation and subsequently use the cache.
const page = { documentId: 'test', pageIndex: 0, rotation: 90 };
const image = { dataUrl: 'data:image/png;base64,test', width: 800, height: 600 };
const a = renderPage(page, 800); const b = renderPage(page, 800);
assert.equal(a, b); assert.equal(calls.length, 1);
const render = next(); assert.equal(render.command, 'render_page'); render.resolve(image);
await a; await b; await flush();
assert.equal(await renderPage(page, 800), image); assert.equal(calls.length, 0);

// Changing workspace cancels queued work, and a late result cannot repopulate its cache.
const late = renderPage(page, 700);
const waiting = backend('stale-page');
const rejectedWaiting = assert.rejects(waiting, (error) => error.message === cancelledRequest);
resetBackendQueue();
const oldRender = next(); oldRender.resolve(image);
await late; await rejectedWaiting; await flush();
assert.equal(calls.length, 0);
const fresh = renderPage(page, 700); assert.equal(calls.length, 1);
next().resolve(image); await fresh; await flush();

// A native worker failure invalidates the session once and discards stale pending work.
let invalidations = 0;
edge.addEventListener(sessionInvalidatedEvent, () => invalidations++);
// Late work for one closed tab must not cancel another tab's work or cache.
const closedTab = backend('closed-tab-render');
const liveTab = backend('surviving-tab-render');
const closedRejected = assert.rejects(closedTab, /DOCUMENT_CLOSED:/);
next().reject('DOCUMENT_CLOSED: source was released');
await closedRejected; await flush();
assert.equal(invalidations, 0);
const liveTabCall = next(); assert.equal(liveTabCall.command, 'surviving-tab-render');
liveTabCall.resolve('still-open'); assert.equal(await liveTab, 'still-open'); await flush();
assert.equal(await renderPage(page, 700), image, 'An unrelated tab keeps its rendered cache');
assert.equal(calls.length, 0);
const failure = backend('crashing');
const stale = backend('old-session');
const failed = assert.rejects(failure, /SESSION_INVALIDATED:/);
const discarded = assert.rejects(stale, (error) => error.message === cancelledRequest);
next().reject('SESSION_INVALIDATED: worker exited');
await failed; await discarded; await flush();
assert.equal(invalidations, 1); assert.equal(calls.length, 0);
const healthy = backend('new-session'); next().resolve('ok'); assert.equal(await healthy, 'ok');

// Edits must alter the render cache key, and queued IPC receives an immutable overlay snapshot.
const overlayPage = { ...page, overlays: [{ id: 'overlay', assetId: 'asset', x: 0.1, y: 0.2, width: 0.3, height: 0.2, opacity: 1, rotation: 0 }] };
const painted = renderPage(overlayPage, 800); const paintedCall = next();
assert.equal(paintedCall.args.page.overlays[0].x, 0.1);
overlayPage.overlays[0].x = 0.2;
assert.equal(paintedCall.args.page.overlays[0].x, 0.1);
paintedCall.resolve(image); await painted; await flush();
const moved = renderPage(overlayPage, 800); assert.equal(calls.length, 1);
next().resolve(image); await moved; await flush();
overlayPage.overlays[0].blendMode = 'multiply';
const multiplied = renderPage(overlayPage, 800); assert.equal(calls.length, 1, 'Changing blend mode must invalidate the preview cache');
const multipliedCall = next(); assert.equal(multipliedCall.args.page.overlays[0].blendMode, 'multiply');
multipliedCall.resolve(image); await multiplied; await flush();

// Real content changes affect previews and carry a deep immutable bounds copy.
const contentPage = { ...page, contentEdits: [{ objectIndex: 1, fingerprint: 'source', text: 'First', bounds: { x: .1, y: .2, width: .3, height: .1 } }] };
const originalContent = renderPage(contentPage, 800);
const originalContentCall = next();
contentPage.contentEdits[0].text = 'Second';
contentPage.contentEdits[0].bounds.x = .2;
assert.equal(originalContentCall.args.page.contentEdits[0].text, 'First');
assert.equal(originalContentCall.args.page.contentEdits[0].bounds.x, .1, 'Queued native edits must not mutate with workspace state');
originalContentCall.resolve(image); await originalContent; await flush();
const changedContent = renderPage(contentPage, 800);
assert.equal(calls.length, 1, 'Text or bounds changes invalidate the page cache');
next().resolve(image); await changedContent; await flush();
assert.equal(await renderPage(contentPage, 800), image);
assert.equal(calls.length, 0);
contentPage.contentEdits[0].deleted = true;
const deletedContent = renderPage(contentPage, 800);
assert.equal(calls.length, 1, 'Content removal must not reuse the previous preview');
next().resolve(image); await deletedContent; await flush();
console.log('PASS: serial IPC, priorities, render dedup/cache, workspace cancellation, worker recovery');
