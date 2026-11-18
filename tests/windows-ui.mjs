// SPDX-License-Identifier: MIT OR Apache-2.0
// Execute the shipped components with deterministic React hooks and platform IPC.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const flush = () => new Promise(resolve => setImmediate(resolve));
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
const i18n = { useI18n: () => ({ t: (zh, en) => en ?? zh }) };
let host;
const document = { activeElement: null };
class Element {
  isConnected = true;
  focusCount = 0;
  controls = [];
  focus() { this.focusCount++; document.activeElement = this; }
  querySelectorAll() { return this.controls; }
}
const react = {
  useState(initial) {
    const owner = host, index = owner.cursor++;
    if (!(index in owner.slots)) owner.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [owner.slots[index], value => {
      if (!owner.mounted) owner.lateUpdates++;
      owner.slots[index] = typeof value === 'function' ? value(owner.slots[index]) : value;
    }];
  },
  useRef(initial) { const index = host.cursor++; return host.slots[index] ??= { current: initial }; },
  useEffect(effect, deps) {
    const owner = host, index = owner.cursor++, previous = owner.effects[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      owner.pending.push(() => { previous?.cleanup?.(); owner.effects[index] = { deps, cleanup: effect() }; });
    }
  },
};
function walk(node, predicate, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (Array.isArray(node)) { for (const child of node) walk(child, predicate, result); return result; }
  if (predicate(node)) result.push(node);
  walk(node.props?.children, predicate, result);
  return result;
}
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.props?.children);
}
function load(file, modules, globals = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
  const exports = {};
  vm.runInNewContext(result.outputText, { exports, console, Error, document, HTMLElement: Element,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return jsx;
      if (name === '../i18n') return i18n;
      if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) });
      if (name in modules) return modules[name];
      throw new Error(`Unexpected component dependency: ${name}`);
    }, ...globals });
  return exports;
}
function harness(Component, props) {
  const owner = { cursor: 0, slots: [], effects: [], pending: [], tree: null, mounted: true, lateUpdates: 0, elements: new Map() };
  return {
    owner,
    render() {
      assert.ok(owner.mounted, 'Do not render an unmounted component');
      host = owner; owner.cursor = 0; owner.pending = []; owner.tree = Component(props);
      // Ref assignment precedes effects, matching React commit order.
      const controls = walk(owner.tree, node => node.type === 'button' && !node.props.disabled).map(node => {
        const key = node.props['aria-label'] ?? text(node);
        if (!owner.elements.has(key)) owner.elements.set(key, new Element());
        return owner.elements.get(key);
      });
      for (const node of walk(owner.tree, node => node.props?.ref?.current !== undefined)) {
        if (!node.props.ref.current) node.props.ref.current = new Element();
        node.props.ref.current.controls = controls;
      }
      for (const effect of owner.pending) effect();
      return owner.tree;
    },
    unmount() {
      for (const effect of owner.effects) effect?.cleanup?.();
      owner.mounted = false;
    },
  };
}
function key(key, extra = {}) {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, prevented: 0, stopped: 0,
    preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; }, ...extra };
}
function button(tree, label) {
  const matches = walk(tree, node => node.type === 'button' && (node.props['aria-label'] === label || text(node).trim() === label));
  assert.equal(matches.length, 1, `Expected one ${label} button`);
  return matches[0];
}

// Deferred content appears only after two independently flushed animation frames.
const frames = new Map(); let frameId = 0;
const animation = {
  requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
  cancelAnimationFrame(id) { frames.delete(id); },
};
const runFrame = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
const { DeferredDialog } = load('../src/components/DeferredDialog.tsx', {}, animation);
const heavy = { type: 'HeavyPdfDialog', props: { children: 'Actual preview children' } };
let cancelled = 0;
let deferred = harness(DeferredDialog, { children: heavy, onCancel: () => cancelled++ });
let tree = deferred.render();
assert.notEqual(tree, heavy); assert.ok(text(tree).includes('Preparing preview'));
assert.equal(walk(tree, node => node.props?.role === 'dialog')[0].props.ref.current.focusCount, 1);
assert.equal(frames.size, 1);
runFrame(); tree = deferred.render(); assert.notEqual(tree, heavy, 'One frame is not enough to mount the expensive children');
assert.equal(frames.size, 1);
runFrame(); tree = deferred.render();
assert.equal(tree.props.className, 'deferred-dialog-ready');
assert.equal(tree.props.children, heavy, 'Ready content keeps its identity inside a layout-free host');
assert.equal(frames.size, 0);
deferred.unmount(); assert.equal(deferred.owner.lateUpdates, 0);

// Cancellation can happen before either scheduled frame; neither may commit late.
for (const elapsedFrames of [0, 1]) {
  let cancelCount = 0;
  deferred = harness(DeferredDialog, { children: heavy, onCancel: () => { cancelCount++; deferred.unmount(); } });
  tree = deferred.render();
  for (let i = 0; i < elapsedFrames; i++) { runFrame(); tree = deferred.render(); }
  if (elapsedFrames === 0) button(tree, 'Cancel').props.onClick();
  else { const event = key('Escape'); tree.props.onKeyDown(event); assert.equal(event.prevented, 1); assert.equal(event.stopped, 1); }
  assert.equal(cancelCount, 1); assert.equal(frames.size, 0);
  runFrame(); assert.equal(deferred.owner.lateUpdates, 0);
}
deferred = harness(DeferredDialog, { children: heavy, onCancel: () => cancelled++ });
tree = deferred.render(); const globalSave = key('s', { ctrlKey: true }); tree.props.onKeyDown(globalSave);
assert.equal(globalSave.prevented, 1); assert.equal(globalSave.stopped, 1);
deferred.unmount(); runFrame(); assert.equal(deferred.owner.lateUpdates, 0);

// Settings executes the real onClick handlers against a mocked, deferred native IPC.
let desktop = true;
const requests = [];
const backend = {
  isDesktop: () => desktop,
  errorMessage: error => error.message ?? String(error),
  backend(command) { return new Promise((resolve, reject) => requests.push({ command, resolve, reject })); },
};
const { WindowsSettingsDialog } = load('../src/components/WindowsSettingsDialog.tsx', {
  '../backend': backend,
  '../../package.json': JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
});
let closeCount = 0, shortcutCount = 0;
const previousFocus = new Element(); previousFocus.focus();
let settings = harness(WindowsSettingsDialog, { onClose: () => closeCount++, onShortcuts: () => shortcutCount++ });
tree = settings.render();
assert.equal(requests.length, 0, 'Opening settings cannot register the app or change the OS');
const section = walk(tree, node => node.type === 'section')[0].props.ref.current;
assert.equal(document.activeElement, section);
assert.ok(text(tree).includes('Windows confirms the association'));
assert.equal(button(tree, 'Set as default PDF app').props.disabled, false);

// The focus loop contains keyboard navigation and leaves ordinary interior Tab native.
let event = key('Tab'); tree.props.onKeyDown(event); assert.equal(document.activeElement, section.controls[0]); assert.equal(event.prevented, 1);
event = key('Tab', { shiftKey: true }); tree.props.onKeyDown(event); assert.equal(document.activeElement, section.controls.at(-1)); assert.equal(event.prevented, 1);
event = key('Tab'); tree.props.onKeyDown(event); assert.equal(document.activeElement, section.controls[0]);
document.activeElement = section.controls[1]; event = key('Tab'); tree.props.onKeyDown(event); assert.equal(event.prevented, 0);
for (const [commandKey, modifiers] of [['s', { ctrlKey: true }], ['p', { metaKey: true }]]) {
  event = key(commandKey, modifiers); tree.props.onKeyDown(event); assert.equal(event.prevented, 1); assert.equal(event.stopped, 1);
}

const openDefault = button(tree, 'Set as default PDF app').props.onClick;
openDefault(); openDefault();
assert.equal(requests.length, 1, 'Pending ref prevents repeated clicks before React has rendered disabled state');
assert.equal(requests[0].command, 'open_default_pdf_settings');
tree = settings.render();
for (const control of walk(tree, node => node.type === 'button')) assert.equal(control.props.disabled, true, 'All close and action buttons are disabled during native work');
const backdrop = {};
tree.props.onMouseDown({ target: backdrop, currentTarget: backdrop });
event = key('Escape'); tree.props.onKeyDown(event); assert.equal(closeCount, 0, 'Busy backdrop/Escape cannot close');
event = key('Tab'); tree.props.onKeyDown(event); assert.equal(event.prevented, 1, 'No focus escape while all controls are disabled');
requests.shift().resolve({ registered: true, settingsOpened: true }); await flush(); tree = settings.render();
assert.ok(text(tree).includes('Windows settings opened. Choose the default app for .pdf'));
assert.equal(walk(tree, node => node.props?.role === 'alert').length, 0);
button(tree, 'Set as default PDF app').props.onClick();
requests.shift().resolve({ registered: true, settingsOpened: false }); await flush(); tree = settings.render();
assert.ok(text(walk(tree, node => node.props?.role === 'alert')[0]).includes('Windows settings did not open'));
assert.ok(!text(tree).includes('Windows settings opened.'));

button(tree, 'Repair Open with registration').props.onClick();
assert.equal(requests.length, 1); assert.equal(requests[0].command, 'register_pdf_integration');
tree = settings.render(); assert.ok(!text(tree).includes('Windows settings opened.'));
requests.shift().resolve({ registered: false }); await flush(); tree = settings.render();
assert.ok(text(walk(tree, node => node.props?.role === 'alert')[0]).includes('registration did not complete'));
assert.equal(button(tree, 'Repair Open with registration').props.disabled, false);
button(tree, 'Repair Open with registration').props.onClick();
requests.shift().reject(new Error('Registry access denied')); await flush(); tree = settings.render();
assert.ok(text(walk(tree, node => node.props?.role === 'alert')[0]).includes('Registry access denied'));
button(tree, 'Repair Open with registration').props.onClick();
tree = settings.render(); assert.equal(walk(tree, node => node.props?.role === 'alert').length, 0, 'Retry clears the previous error');
requests.shift().resolve({ registered: true }); await flush(); tree = settings.render();
assert.ok(text(tree).includes('Open with registration was updated.'));
button(tree, 'Keyboard shortcuts').props.onClick(); assert.equal(shortcutCount, 1);
button(tree, 'Close settings').props.onClick(); assert.equal(closeCount, 1);
button(tree, 'Done').props.onClick(); assert.equal(closeCount, 2);
tree.props.onMouseDown({ target: {}, currentTarget: backdrop }); assert.equal(closeCount, 2);
tree.props.onMouseDown({ target: backdrop, currentTarget: backdrop }); assert.equal(closeCount, 3);
event = key('Escape'); tree.props.onKeyDown(event); assert.equal(closeCount, 4); assert.equal(event.prevented, 1);
assert.equal(requests.length, 0);
settings.unmount(); assert.equal(document.activeElement, previousFocus, 'Unmount restores the connected element focused before the dialog');

desktop = false;
settings = harness(WindowsSettingsDialog, { onClose() {}, onShortcuts() {} }); tree = settings.render();
assert.ok(text(tree).includes('Use these settings in the Windows desktop app.'));
for (const label of ['Set as default PDF app', 'Repair Open with registration']) {
  const control = button(tree, label); assert.equal(control.props.disabled, true); control.props.onClick();
}
assert.equal(requests.length, 0, 'Handlers remain guarded in a non-desktop preview'); settings.unmount();

// Late completion or failure after an external unmount never touches state.
desktop = true;
for (const completion of ['resolve', 'reject']) {
  settings = harness(WindowsSettingsDialog, { onClose() {}, onShortcuts() {} }); tree = settings.render();
  button(tree, 'Repair Open with registration').props.onClick();
  assert.equal(requests.length, 1); const request = requests.shift(); settings.unmount();
  if (completion === 'resolve') request.resolve({ registered: true }); else request.reject(new Error('Late native failure'));
  await flush(); assert.equal(settings.owner.lateUpdates, 0);
}
console.log('PASS: actual DeferredDialog two-frame paint/cancel/cleanup; actual WindowsSettingsDialog user-initiated IPC, duplicate and busy guards, retries, truthful success, focus loop/restoration, callbacks, desktop guards, and unmount-safe native completions');
