'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/core/protocol');
const { buildHtml } = require('../src/html');

test('protocol: size plan refuses files over the limit with a clear message and clamps bad settings', () => {
  const big = P.sizePlan(600 * P.MB, 512);
  assert.equal(big.load, false);
  assert.match(big.message, /This file is 600\.0 MB\. PKL Viewer opens pickle files up to 512\.0 MB/);
  assert.match(big.message, /The file was not read\./);
  assert.equal(P.sizePlan(512 * P.MB, 512).load, true);
  assert.equal(P.sizePlan(10, -5).limitMB, 512);
  assert.equal(P.sizePlan(10, 99999).limitMB, 2048);
  assert.equal(P.sizePlan(0, 512).load, false);
});

test('protocol: only known webview messages pass', () => {
  assert.deepEqual(P.validateWebviewMessage({ type: 'ready', extra: 1 }), { ok: true, msg: { type: 'ready' } });
  assert.equal(P.validateWebviewMessage({ type: 'rendered' }).ok, true);
  assert.equal(P.validateWebviewMessage({ type: 'reload' }).ok, true);
  assert.equal(P.validateWebviewMessage({ type: 'copy', text: 'a\tb' }).ok, true);
  for (const bad of [null, 'ready', {}, { type: 'copy', text: 5 }, { type: 'copy', text: 'x'.repeat(2000001) }, { type: 'writeFile', path: '/etc/x' }, { type: 'openExternal', url: 'https://x' }, { type: 'eval', code: '1' }]) {
    assert.equal(P.validateWebviewMessage(bad).ok, false, JSON.stringify(bad && bad.type));
  }
  assert.equal(P.validateWorkerMessage({ type: 'model', model: {} }), true);
  assert.equal(P.validateWorkerMessage({ type: 'error', message: 'x' }), true);
  assert.equal(P.validateWorkerMessage({ type: 'run' }), false);
});

test('html: strict CSP with a nonce, no remote origin, escaped title', () => {
  const h = buildHtml({ cspSource: 'https://res', scriptUri: 'https://res/w.js', styleUri: 'https://res/w.css', title: '<x>"a.pkl', nonce: 'N1' });
  const csp = /content="([^"]+)"/.exec(h)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-N1'/);
  assert.doesNotMatch(csp, /unsafe|http:|\*|connect-src/);
  assert.match(h, /<title>&lt;x&gt;&quot;a\.pkl<\/title>/);
});

test('webview: file text only goes in through textContent; no innerHTML, eval or network', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'main.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|fetch\(|XMLHttpRequest|WebSocket|importScripts/);
  assert.match(src, /textContent = v/);
  assert.match(src, /Opened without Python\. No code in this file was run\./);
  // style attributes would break the CSP; the code sets styles through CSSOM
  assert.doesNotMatch(src, /setAttribute\('style'/);
  const posted = [...src.matchAll(/postMessage\(\{ type: '(\w+)'/g)].map(m => m[1]);
  for (const t of posted) assert.equal(P.validateWebviewMessage({ type: t, text: '' }).ok, true, t);
});
