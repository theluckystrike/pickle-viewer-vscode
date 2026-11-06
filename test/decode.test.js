'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { unpickle } = require('../src/core/unpickler');
const { buildModel, shortRepr } = require('../src/core/model');
const V = require('../src/core/values');
const H = require('./helpers');

test.after(H.cleanup);
const B = s => new Uint8Array(Buffer.from(s, 'latin1'));
const dir = H.hasPython ? H.makeSamples(false) : null;
const fb = H.hasPython ? H.makeSamples(true) : null;
const skip = !H.hasPython;

function plain(v) {
  // decoded value -> JSON-like form to compare with Python's own view
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return { int: v.toString() };
  if (v instanceof V.PyFloat) return v.value;
  if (Array.isArray(v)) return V.isTuple(v) ? { tuple: v.map(plain) } : v.map(plain);
  if (v instanceof V.PyBytes) return { [v.kind]: Buffer.from(v.data).toString('hex') };
  if (v instanceof V.PySet) return { [v.typeName]: v.items.map(plain).map(x => JSON.stringify(x)).sort() };
  if (v instanceof V.PyText) return { [v.typeName]: v.text };
  if (v instanceof V.PyDict) return { dict: v.keys.map((k, i) => [plain(k), plain(v.values[i])]) };
  if (v instanceof V.PyObject) return { object: v.className, state: plain(v.state) };
  return { other: String(v) };
}

const EXPECT_PY = String.raw`
import pickle, sys, json, datetime, types
sys.modules['lab'] = types.ModuleType('lab'); m = types.ModuleType('lab.models'); sys.modules['lab.models'] = m
class Experiment: pass
Experiment.__module__ = 'lab.models'; m.Experiment = Experiment
def plain(v):
    if v is None or isinstance(v, (bool, str)): return v
    if isinstance(v, int): return v if abs(v) <= 2**53 - 1 else {"int": str(v)}
    if isinstance(v, float): return v
    if isinstance(v, tuple): return {"tuple": [plain(x) for x in v]}
    if isinstance(v, list): return [plain(x) for x in v]
    if isinstance(v, bytearray): return {"bytearray": bytes(v).hex()}
    if isinstance(v, bytes): return {"bytes": v.hex()}
    if isinstance(v, frozenset): return {"frozenset": sorted(json.dumps(plain(x), separators=(",", ":")) for x in v)}
    if isinstance(v, set): return {"set": sorted(json.dumps(plain(x), separators=(",", ":")) for x in v)}
    if isinstance(v, datetime.datetime): return {"datetime.datetime": str(v)}
    if isinstance(v, datetime.date): return {"datetime.date": str(v)}
    if isinstance(v, datetime.timedelta): return {"datetime.timedelta": str(v)}
    if isinstance(v, dict): return {"dict": [[plain(k), plain(x)] for k, x in v.items()]}
    if isinstance(v, Experiment): return {"object": "lab.models.Experiment", "state": plain(v.__dict__)}
    return {"other": repr(v)}
# basic samples only hold the types above and our own class; they are safe to load here
print(json.dumps(plain(pickle.load(open(sys.argv[1], "rb")))))
`;

test('decode: protocols 0, 2, 4 and 5 give the same values Python sees (types kept)', { skip }, () => {
  const files = ['basic-protocol0.pkl', 'basic-protocol2.pkl', 'basic-protocol4.pickle', 'basic-protocol5.p'];
  for (const f of files) {
    const r = unpickle(H.read(dir, f));
    assert.equal(r.error, null, f);
    const ours = JSON.parse(JSON.stringify(plain(r.value)));
    const theirs = H.py(EXPECT_PY, path.join(dir, f));
    assert.deepEqual(ours, theirs, f);
  }
});

test('decode: protocol numbers and the custom class placeholder', { skip }, () => {
  const proto = { 'basic-protocol0.pkl': 0, 'basic-protocol2.pkl': 2, 'basic-protocol4.pickle': 4, 'basic-protocol5.p': 5 };
  for (const [f, p] of Object.entries(proto)) {
    const m = buildModel(H.read(dir, f));
    assert.equal(m.protocol, p, f);
    const exp = m.tree.nodes.find(n => n.k === "'experiment'");
    assert.equal(exp.t, 'lab.models.Experiment');
    assert.equal(exp.ph, 'lab.models.Experiment');
    const kids = exp.c.map(i => m.tree.nodes[i].k);
    assert.deepEqual(kids, ['.name', '.seed', '.tags', '.started']);
    const types = Object.fromEntries(m.tree.nodes[0].c.map(i => [m.tree.nodes[i].k, m.tree.nodes[i].t]));
    assert.equal(types["'point'"], 'tuple');
    assert.equal(types["'flags'"], 'list');
    assert.equal(types["'whole_float'"], 'float');
    assert.equal(types["'count'"], 'int');
    assert.equal(types["'labels'"], 'set');
    assert.equal(types["'frozen'"], 'frozenset');
    assert.equal(types["'payload'"], 'bytes');
    assert.equal(types["'buffer'"], 'bytearray');
    assert.equal(types["'when'"], 'datetime.datetime');
  }
});

test('decode: the risky samples are decoded as placeholders, nothing is called', { skip }, () => {
  const r = unpickle(H.read(dir, 'risky-os-system.pkl'));
  assert.ok(r.value instanceof V.PyObject);
  assert.equal(r.value.className, 'os.system');
  assert.deepEqual([...r.value.args], ['true']);
  const s = unpickle(H.read(dir, 'risky-stack-global.pkl'));
  assert.deepEqual(s.value.map(o => o.className), ['subprocess.check_output', 'builtins.eval']);
  assert.equal(shortRepr(s.value[1].args), "('1+1',)");
});

test('decode: the decoder bundle has no way to run code or start processes', () => {
  for (const f of ['src/core/unpickler.js', 'src/core/opcodes.js', 'src/core/values.js', 'src/core/model.js', 'src/core/arrays.js', 'src/core/frame.js', 'src/core/safety.js', 'src/core/disasm.js', 'src/worker.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /\beval\s*\(|new Function|child_process|require\(['"](fs|net|http|https|vm)['"]\)|import\(/, f);
  }
});

test('decode: NumPy arrays (protocol 2 and 5, and the hand-written stream) match NumPy', { skip }, () => {
  for (const [d, f] of [[dir, 'numpy-arrays-protocol2.pkl'], [dir, 'numpy-arrays-protocol5.pkl'], [fb, 'numpy-arrays-protocol2.pkl']]) {
    const m = buildModel(H.read(d, f));
    assert.equal(m.error, null, f);
    const w = m.arrays.find(a => a.path === "root['weights']");
    if (d === fb) {
      assert.deepEqual(w.shape, [48, 64]);
      assert.equal(w.dtype, 'float32');
      const l = m.arrays.find(a => a.path === "root['labels']");
      assert.deepEqual([l.statsText.min, l.statsText.max, l.statsText.mean], ['0', '9', '4.5']);
      continue;
    }
    const exp = H.py(`import numpy as np, sys, json, math
y, x = np.mgrid[0:96, 0:128]
w = (np.sin(y / 9.0) * np.cos(x / 13.0) + 0.15 * np.sin((x + y) / 4.0)).astype(np.float32)
print(json.dumps([float(w.min()), float(w.max()), float(w.astype(np.float64).mean()), float(w[3, 5])]))`);
    assert.deepEqual(w.shape, [96, 128]);
    assert.equal(w.dtype, 'float32');
    assert.ok(Math.abs(w.stats.min - exp[0]) < 1e-6 && Math.abs(w.stats.max - exp[1]) < 1e-6 && Math.abs(w.stats.mean - exp[2]) < 1e-9, f);
    assert.equal(Number(w.grid.cells[3][5]), Number(exp[3].toPrecision(6)));
    assert.equal(w.heat.rows, 96); assert.equal(w.heat.cols, 128);
    const fo = m.arrays.find(a => a.path === "root['fortran']");
    assert.equal(fo.order, 'F');
    assert.deepEqual(fo.grid.cells, [['0', '1', '2', '3'], ['4', '5', '6', '7'], ['8', '9', '10', '11']], 'Fortran order is shown in logical order');
    const mask = m.arrays.find(a => a.path === "root['mask']");
    assert.equal(mask.dtype, 'bool');
    assert.equal(mask.grid.cells[0][0], 'False');
    assert.ok(mask.grid.cells.flat().includes('True'));
    const scalar = m.tree.nodes.find(n => n.k === "'scalar'");
    assert.equal(scalar.t, 'numpy.float64'); assert.equal(scalar.v, '3.25');
    const bias = m.arrays.find(a => a.path === "root['bias']");
    assert.equal(bias.grid.flat, true); assert.equal(bias.grid.cells[0][0], '-1.0');
  }
});

test('decode: pandas DataFrame (real pandas, hand-written 2.x layout and legacy layout) becomes a table', { skip }, () => {
  const real = buildModel(H.read(dir, 'dataframe.pkl'));
  const f = real.frames[0];
  assert.equal(f.ok, true, f.reason);
  assert.deepEqual(f.columns.map(c => `${c.name}:${c.dtype}`), ['city:object', 'population_k:int64', 'area_km2:float64', 'coastal:bool']);
  assert.equal(f.rows, 6);
  assert.deepEqual(f.cells[1], ['Lima', '10719', '2672.3', 'True']);
  assert.deepEqual(f.index, ['0', '1', '2', '3', '4', '5']);
  assert.equal(real.arrays.length, 0, 'block arrays of a readable frame are not repeated in Arrays');
  for (const name of ['handwritten-dataframe.pkl', 'handwritten-dataframe-legacy.pkl']) {
    const m = buildModel(H.read(fb, name));
    const t = m.frames[0];
    assert.equal(t.ok, true, `${name}: ${t.reason}`);
    assert.deepEqual(t.columns.map(c => c.name), ['id', 'score', 'city']);
    assert.deepEqual(t.cells[2], ['103', '0.125', 'Pune']);
  }
});

test('decode: a frame with an extension column falls back to the tree with a clear reason', () => {
  // DataFrame whose only block holds a Categorical placeholder
  const s = "\x80\x02cpandas.core.frame\nDataFrame\n)\x81}X\x04\x00\x00\x00_mgrcpandas.core.internals.managers\nBlockManager\n((cpandas._libs.internals\n_unpickle_block\ncpandas.core.arrays.categorical\nCategorical\n)\x81c__builtin__\nslice\nK\x00K\x01K\x01\x87RK\x02\x87Rt]cpandas.core.indexes.base\n_new_Index\ncpandas.core.indexes.range\nRangeIndex\n}X\x04\x00\x00\x00stopK\x01s\x86RatRsb.";
  const m = buildModel(B(s));
  assert.equal(m.error, null, m.error && m.error.message);
  assert.equal(m.frames[0].ok, false);
  assert.match(m.frames[0].reason, /Categorical/);
});

test('decode: big, deep and self-referencing data stay safe', () => {
  // 300,000 items through one APPENDS (a spread call would overflow the stack)
  const parts = ['\x80\x02]('];
  for (let i = 0; i < 300000; i++) parts.push('K\x07');
  parts.push('e.');
  const big = buildModel(B(parts.join('')), { perNode: 1000 });
  assert.equal(big.error, null);
  assert.equal(big.tree.nodes[0].n, 300000);
  assert.equal(big.tree.nodes[0].more, 299000);
  // 50,000 nested lists
  const deep = '\x80\x02' + ']q\x00'.repeat(0) + ']'.repeat(50000) + 'a'.repeat(49999) + '.';
  const d = buildModel(B(deep), { maxNodes: 2000 });
  assert.equal(d.error, null);
  assert.ok(d.tree.truncated);
  // a list that contains itself: ]q\x00h\x00a.
  const self = buildModel(B('\x80\x02]q\x00h\x00a.'));
  assert.equal(self.tree.nodes[1].ref, 0);
  // __proto__ as a dict key does not touch any prototype
  const proto = buildModel(B('\x80\x02}X\t\x00\x00\x00__proto__}X\x08\x00\x00\x00pollutedK\x01ss.'));
  assert.equal(proto.error, null);
  assert.equal(({}).polluted, undefined);
  assert.equal(proto.tree.nodes[1].k, "'__proto__'");
});

test('decode: damaged files keep what was read and say where they stopped', () => {
  const m = buildModel(B('\x80\x02cos\nsystem\nX\x04\x00\x00\x00true\x85R\xfe'));
  assert.match(m.error.message, /Unknown opcode 0xfe at byte 24/);
  assert.equal(m.tree, null);
  assert.equal(m.safety.verdict.level, 'danger', 'names read before the damage are still rated');
  const empty = buildModel(B('hello world\n'));
  assert.ok(empty.error);
  assert.equal(empty.notPickle.head, 'hello world');
  assert.equal(m.notPickle, undefined, 'a real pickle that breaks later is not called a non-pickle');
  const memo = buildModel(B('\x80\x02h\x05.'));
  assert.match(memo.error.message, /Memo entry 5/);
});

test('decode: persistent ids, extension codes and out-of-band buffers become placeholders', () => {
  const m = buildModel(B("\x80\x05(X\x07\x00\x00\x00storageQ\x82\x07\x97\x98l."));
  assert.equal(m.error, null, m.error && m.error.message);
  assert.deepEqual(m.tree.nodes[0].c.map(i => m.tree.nodes[i].t), ['persistent id', 'extension code', 'out-of-band buffer']);
});
