'use strict';
const vscode = require('vscode');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { validateWebviewMessage, validateWorkerMessage, sizePlan, fmtSize } = require('./core/protocol');
const { createRatingPrompt } = require('./rate');

const VIEW_TYPE = 'pickleViewer.preview';
const VIEW_TYPE_P = 'pickleViewer.previewP';
const EXT_ID = 'zovo.zovo-pickle-viewer';
const TIMEOUT_MS = 120000;
let rating = { success() {} };

function settings() {
  const c = vscode.workspace.getConfiguration('pickleViewer');
  return { maxFileMB: c.get('maxFileMB', 512) };
}

/** Decode in a worker thread so a big file never blocks the extension host. */
function decodeInWorker(workerPath, data, opts = {}) {
  let worker;
  let timer;
  const promise = new Promise((resolve, reject) => {
    worker = new Worker(workerPath, { resourceLimits: { maxOldGenerationSizeMb: opts.heapMB || 4096 } });
    timer = setTimeout(() => { worker.terminate(); reject(new Error(`Decoding took longer than ${Math.round((opts.timeoutMs || TIMEOUT_MS) / 1000)} seconds and was stopped.`)); }, opts.timeoutMs || TIMEOUT_MS);
    worker.once('message', m => {
      clearTimeout(timer); worker.terminate();
      if (!validateWorkerMessage(m)) return reject(new Error('The decoder sent an unexpected reply.'));
      if (m.type === 'error') return reject(new Error(m.message));
      resolve(m.model);
    });
    worker.once('error', e => { clearTimeout(timer); worker.terminate(); reject(new Error(/memory/i.test(String(e && e.message)) ? 'The decoded data does not fit in memory. The file may hold one very large object.' : String(e && e.message || e))); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`The decoder stopped (exit code ${code}).`)); });
    // A standalone ArrayBuffer can be moved to the worker without a copy.
    const ab = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : Uint8Array.prototype.slice.call(data).buffer;
    worker.postMessage({ bytes: new Uint8Array(ab), opts: opts.model || {} }, [ab]);
  });
  return { promise, cancel: () => { clearTimeout(timer); if (worker) worker.terminate(); } };
}

class PickleEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const uri = document.uri;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media] };
    const name = path.posix.basename(uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
    });
    let disposed = false;
    let counted = false; // one success per opened tab, for the rating prompt
    let job = null;
    const post = m => (disposed ? Promise.resolve(false) : panel.webview.postMessage(m));

    const load = async () => {
      if (job) job.cancel();
      const stat = await vscode.workspace.fs.stat(uri);
      const plan = sizePlan(stat.size, settings().maxFileMB);
      await post({ type: 'init', name, size: stat.size, sizeText: fmtSize(stat.size), plan });
      if (!plan.load) return;
      const data = await vscode.workspace.fs.readFile(uri);
      const t0 = Date.now();
      job = decodeInWorker(path.join(ctx.extensionUri.fsPath, 'dist', 'worker.js'), data);
      try {
        const model = await job.promise;
        await post({ type: 'model', model, name, sizeText: fmtSize(stat.size), ms: Date.now() - t0 });
      } catch (e) {
        await post({ type: 'error', message: e.message });
      } finally { job = null; }
    };

    panel.webview.onDidReceiveMessage(async raw => {
      const v = validateWebviewMessage(raw);
      if (!v.ok) return;
      const msg = v.msg;
      try {
        if (msg.type === 'ready' || msg.type === 'reload') { await load(); return; }
        if (msg.type === 'rendered') { if (!counted) { counted = true; rating.success(); } return; }
        if (msg.type === 'copy') { await vscode.env.clipboard.writeText(msg.text); await post({ type: 'copied', chars: msg.text.length }); }
      } catch (e) {
        await post({ type: 'error', message: e && e.message ? e.message : String(e) });
      }
    });
    panel.onDidDispose(() => { disposed = true; if (job) job.cancel(); });
  }
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'pickleViewer', message: (n) => `PKL Viewer has opened ${n} pickle files for you. A rating helps other people find it.` });
  const provider = new PickleEditorProvider(context);
  const opts = { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, opts),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE_P, provider, opts),
    vscode.commands.registerCommand('pickleViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#pickleViewer.start`, false)),
    vscode.commands.registerCommand('pickleViewer.openWith', async uri => {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, PickleEditorProvider, decodeInWorker, VIEW_TYPE, VIEW_TYPE_P, EXT_ID };
