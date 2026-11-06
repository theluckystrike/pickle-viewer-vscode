'use strict';
// Shared by the extension host, the worker and the tests. No vscode import here.

const MB = 1024 * 1024;
const EXTENSIONS = ['pkl', 'pickle', 'p'];

function fmtSize(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(1)} GB`;
}

/** Files over the limit get a clear message and are never read. */
function sizePlan(size, maxFileMB) {
  const limitMB = Number.isFinite(maxFileMB) && maxFileMB > 0 ? Math.min(maxFileMB, 2048) : 512;
  if (size > limitMB * MB) {
    return {
      load: false, limitMB,
      message: `This file is ${fmtSize(size)}. PKL Viewer opens pickle files up to ${fmtSize(limitMB * MB)} so VS Code stays responsive (setting pickleViewer.maxFileMB). The file was not read.`,
    };
  }
  if (size === 0) return { load: false, limitMB, message: 'The file is empty. There is nothing to decode.' };
  return { load: true, limitMB };
}

const str = (v, max) => typeof v === 'string' && v.length <= max;

/** Only known webview messages pass, with checked fields. Everything else is dropped. */
function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false };
  switch (m.type) {
    case 'ready':
    case 'rendered':
    case 'reload':
      return { ok: true, msg: { type: m.type } };
    case 'copy':
      if (!str(m.text, 2000000)) return { ok: false };
      return { ok: true, msg: { type: 'copy', text: m.text } };
    default:
      return { ok: false };
  }
}

/** Messages the worker may send back to the host. */
function validateWorkerMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.type === 'model') return !!m.model && typeof m.model === 'object';
  if (m.type === 'error') return typeof m.message === 'string';
  return false;
}

module.exports = { MB, EXTENSIONS, fmtSize, sizePlan, validateWebviewMessage, validateWorkerMessage };
