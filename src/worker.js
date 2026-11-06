'use strict';
// Worker thread: decodes one pickle and posts the view model back. Keeps the extension host free while it runs.
const { parentPort } = require('worker_threads');
const { buildModel } = require('./core/model');

parentPort.on('message', msg => {
  try {
    if (!msg || !(msg.bytes instanceof Uint8Array || msg.bytes instanceof ArrayBuffer)) throw new Error('No file data.');
    const bytes = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes);
    const model = buildModel(bytes, msg.opts || {});
    parentPort.postMessage({ type: 'model', model });
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
});
