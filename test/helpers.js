'use strict';
// Generates the samples once per test file in a temp folder (removed after) with scripts/make_samples.py.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hasPython = spawnSync('python3', ['-c', 'import sys'], { encoding: 'utf8' }).status === 0;
const dirs = [];
function makeSamples(fallback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkl-samples-'));
  dirs.push(dir);
  const args = [path.join(__dirname, '..', 'scripts', 'make_samples.py'), dir];
  if (fallback) args.push('--fallback');
  const r = spawnSync('python3', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return dir;
}
function cleanup() { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
const read = (dir, f) => new Uint8Array(fs.readFileSync(path.join(dir, f)));
/** Run Python code that prints JSON; used to compare with what Python itself sees. Never unpickles the risky samples. */
function py(code, ...args) {
  const r = spawnSync('python3', ['-c', code, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}
module.exports = { hasPython, makeSamples, cleanup, read, py };
