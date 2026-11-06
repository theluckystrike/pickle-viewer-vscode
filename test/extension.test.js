'use strict';
// The extension host on a mocked VS Code API, with the real worker thread from dist/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkl-ext-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const root = path.join(__dirname, '..');

const state = { config: { maxFileMB: 512, askForRating: true }, clipboard: '', sizeOverride: null, reads: 0 };
function uriOf(p) { return { scheme: 'file', fsPath: p, path: p, with(o) { return uriOf(o.path || p); }, toString() { return 'file://' + p; } }; }
const vscodeMock = {
  Uri: { file: uriOf, joinPath: (u, ...s) => uriOf(path.posix.join(u.path, ...s)), parse: s => ({ toString: () => s }) },
  workspace: {
    workspaceFolders: [{ uri: uriOf('/ws') }],
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
    fs: { stat: async u => ({ size: state.sizeOverride ?? fs.statSync(u.fsPath).size }), readFile: async u => { state.reads++; return fs.readFileSync(u.fsPath); } },
    isTrusted: true,
  },
  window: {
    registered: [], state: { focused: true },
    registerCustomEditorProvider(id, p, o) { this.registered.push([id, p, o]); return { dispose() {} }; },
    showInformationMessage: async () => undefined,
  },
  commands: { list: [], registerCommand(id) { this.list.push(id); return { dispose() {} }; }, executeCommand: async () => {} },
  env: { clipboard: { writeText: async t => { state.clipboard = t; } }, sessionId: 's1', openExternal: async () => true },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension.js');

function fakePanel() {
  const sent = []; let handler = null; let dispose = null;
  const panel = {
    webview: { options: null, html: '', cspSource: 'https://csp', asWebviewUri: u => 'https://res' + u.path, postMessage: async m => { sent.push(JSON.parse(JSON.stringify(m))); return true; }, onDidReceiveMessage: h => { handler = h; } },
    onDidDispose: h => { dispose = h; },
  };
  return { panel, sent, send: m => handler(m), close: () => dispose() };
}
const ctxOf = () => ({ extensionUri: uriOf(root), subscriptions: [], globalState: { data: new Map(), get(k) { return this.data.get(k); }, async update(k, v) { this.data.set(k, v); } } });
async function open(file, ctx = ctxOf()) {
  const prov = new ext.PickleEditorProvider(ctx);
  const f = fakePanel();
  await prov.resolveCustomEditor({ uri: uriOf(file) }, f.panel);
  return Object.assign(f, { ctx });
}
const risky = path.join(tmp, 'risky.pkl');
fs.writeFileSync(risky, Buffer.from("cos\nsystem\n(S'true'\ntR.", 'latin1'));

test('activate registers both editors and the commands; manifest matches', () => {
  ext.activate(ctxOf());
  assert.deepEqual(vscodeMock.window.registered.map(r => r[0]), ['pickleViewer.preview', 'pickleViewer.previewP']);
  assert.deepEqual(vscodeMock.commands.list.sort(), ['pickleViewer.moreViewers', 'pickleViewer.openWalkthrough', 'pickleViewer.openWith', 'pickleViewer.supportDeveloper']);
  const pkg = require('../package.json');
  const eds = pkg.contributes.customEditors;
  assert.deepEqual(eds.map(e => e.viewType), [ext.VIEW_TYPE, ext.VIEW_TYPE_P]);
  assert.deepEqual(eds[0].selector.map(s => s.filenamePattern), ['*.pkl', '*.pickle']);
  assert.equal(eds[0].priority, 'default');
  assert.deepEqual(eds[1].selector.map(s => s.filenamePattern), ['*.p']);
  assert.equal(eds[1].priority, 'option', '.p is also Progress ABL source, so it opens by choice');
  assert.ok(pkg.displayName.toLowerCase().startsWith('pkl viewer') && pkg.displayName.length <= 45);
  assert.ok(pkg.keywords.length <= 30);
  assert.equal(`${pkg.publisher}.${pkg.name}`, ext.EXT_ID);
  assert.equal(pkg.version, '0.1.1');
  assert.equal(pkg.contributes.configuration.properties['pickleViewer.askForRating'].default, true);
  assert.equal(pkg.contributes.configuration.properties['pickleViewer.maxFileMB'].default, 512);
});

test('webview options: scripts on, roots are only dist and media; CSP set', async () => {
  const f = await open(risky);
  assert.equal(f.panel.webview.options.enableScripts, true);
  assert.deepEqual(f.panel.webview.options.localResourceRoots.map(u => u.path), [path.join(root, 'dist'), path.join(root, 'media')]);
  assert.match(f.panel.webview.html, /Content-Security-Policy/);
});

test('ready: init, then the model decoded in the worker thread', async () => {
  const f = await open(risky);
  await f.send({ type: 'ready' });
  assert.equal(f.sent[0].type, 'init');
  assert.equal(f.sent[0].plan.load, true);
  const m = f.sent[1];
  assert.equal(m.type, 'model', JSON.stringify(m).slice(0, 300));
  assert.equal(m.model.safety.verdict.level, 'danger');
  assert.equal(m.model.tree.nodes[0].t, 'os.system');
  assert.equal(m.model.ops.total, 6);
});

test('over the limit: message, the file is never read', async () => {
  state.sizeOverride = 600 * 1024 * 1024; const before = state.reads;
  try {
    const f = await open(risky);
    await f.send({ type: 'ready' });
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].plan.load, false);
    assert.match(f.sent[0].plan.message, /600\.0 MB/);
    assert.equal(state.reads, before);
  } finally { state.sizeOverride = null; }
});

test('a damaged file gives a model with an error, not a crash', async () => {
  const bad = path.join(tmp, 'bad.pkl');
  fs.writeFileSync(bad, Buffer.from('\x80\x02]K\x01a\xfe', 'latin1'));
  const f = await open(bad);
  await f.send({ type: 'ready' });
  assert.equal(f.sent[1].type, 'model');
  assert.match(f.sent[1].model.error.message, /Unknown opcode 0xfe/);
});

test('worker: a timeout stops the decode with a message', async () => {
  const job = ext.decodeInWorker(path.join(root, 'dist', 'worker.js'), new Uint8Array(Buffer.from('\x80\x02].', 'latin1')), { timeoutMs: 1 });
  await assert.rejects(job.promise, /longer than|stopped|exit/);
});

test('rendered counts once per tab, copy goes to the clipboard, unknown messages are dropped', async () => {
  const f = await open(risky);
  const key = 'rating.state';
  await f.send({ type: 'rendered' }); await f.send({ type: 'rendered' });
  const st = [...f.ctx.globalState.data.values()].find(v => v && typeof v === 'object' && 'count' in v);
  assert.ok(!st || st.count <= 1, key);
  await f.send({ type: 'copy', text: 'a\tb' });
  assert.equal(state.clipboard, 'a\tb');
  assert.equal(f.sent.at(-1).type, 'copied');
  const n = f.sent.length;
  await f.send({ type: 'writeFile', path: '/tmp/x' }); await f.send({ type: 'eval', code: '1' });
  assert.equal(f.sent.length, n);
  f.close();
  await f.send({ type: 'copy', text: 'z' });
  assert.equal(f.sent.length, n, 'nothing is posted after dispose');
});

// ---------- support links (Sponsor, More free viewers) ----------
test('support: package.json has the sponsor field, the two commands and the setting', () => {
  const pkg = require('../package.json');
  const support = require('../src/support');
  assert.equal(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.equal(pkg.sponsor.url, support.sponsorUrl());
  const ids = pkg.contributes.commands.map(c => c.command);
  assert.ok(ids.includes('pickleViewer.supportDeveloper') && ids.includes('pickleViewer.moreViewers'));
  assert.equal(pkg.contributes.configuration.properties['pickleViewer.showSupportLinks'].default, true);
  assert.ok(support.otherProducts(ext.EXT_ID).every(p => p.id !== ext.EXT_ID));
});

test('support: the footer shows by default and pickleViewer.showSupportLinks=false hides it', async () => {
  for (const [value, shown] of [[undefined, true], [false, false]]) {
    if (value === undefined) delete state.config.showSupportLinks; else state.config.showSupportLinks = value;
    try {
      const f = await open(risky);
      assert.equal(/id="zovo-support"/.test(f.panel.webview.html), shown, String(value));
      assert.equal(f.panel.webview.html.includes('command:pickleViewer.moreViewers'), shown);
      assert.deepEqual(f.panel.webview.options.enableCommandUris, ['pickleViewer.supportDeveloper', 'pickleViewer.moreViewers', 'workbench.action.openSettings']);
      f.close();
    } finally { delete state.config.showSupportLinks; }
  }
});
