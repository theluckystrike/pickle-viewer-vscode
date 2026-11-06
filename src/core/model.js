'use strict';
// Builds everything the webview shows from the bytes of a pickle: the tree, arrays, tables, opcodes and safety rows.
// Runs in a worker thread. Uses only plain data; nothing from the file is ever executed.
const V = require('./values');
const { unpickle } = require('./unpickler');
const { disassemble } = require('./disasm');
const { bytesRepr, strRepr } = require('./disasm');
const { analyze } = require('./safety');
const { arrayView, scalarText, dtypeInfo } = require('./arrays');
const { isFrame, frameView } = require('./frame');

function pyFloat(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  return String(x).replace(/e([+-])(\d)$/, 'e$10$2'); // Python writes 1e-07, JS writes 1e-7
}

function typeOf(v) {
  if (v === null || v === undefined) return 'None';
  switch (typeof v) {
    case 'boolean': return 'bool';
    case 'number': return Number.isInteger(v) ? 'int' : 'float';
    case 'bigint': return 'int';
    case 'string': return 'str';
  }
  if (Array.isArray(v)) return v.typeName || (V.isTuple(v) ? 'tuple' : 'list');
  if (v instanceof V.PyFloat) return 'float';
  if (v instanceof V.PyBytes) return v.kind;
  if (v instanceof V.PyDict) return v.typeName;
  if (v instanceof V.PySet) return v.typeName;
  if (v instanceof V.PyText) return v.typeName;
  if (v instanceof V.PyComplex) return 'complex';
  if (v instanceof V.PySlice) return 'slice';
  if (v instanceof V.PyGlobal) return 'global name';
  if (v instanceof V.PyObject) return v.className;
  if (v instanceof V.NdArray) return v.clsName;
  if (v instanceof V.NpDtype) return 'numpy.dtype';
  if (v instanceof V.NpScalar) return scalarText(v).type;
  if (v instanceof V.PdIndex) return v.clsName.replace(/^pandas\.core\.indexes\.\w+\./, 'pandas.');
  if (v instanceof V.PdBlockManager) return 'pandas BlockManager';
  if (v instanceof V.PdBlock) return 'pandas Block';
  if (v instanceof V.PyPersistent) return 'persistent id';
  if (v instanceof V.PyExtension) return 'extension code';
  if (v instanceof V.PyOutOfBand) return 'out-of-band buffer';
  return typeof v;
}

/** Python-like short text for a value, at most about `budget` characters. */
function shortRepr(v, budget = 80, depth = 0) {
  if (v === null || v === undefined) return 'None';
  switch (typeof v) {
    case 'boolean': return v ? 'True' : 'False';
    case 'number': return Number.isInteger(v) ? String(v) : pyFloat(v);
    case 'bigint': return v.toString();
    case 'string': return strRepr(v, Math.max(8, budget - 2));
  }
  if (v instanceof V.PyFloat) return pyFloat(v.value);
  if (v instanceof V.PyBytes) { const r = bytesRepr(v.data, Math.max(8, budget - 3)); return v.kind === 'bytearray' ? `bytearray(${r})` : r; }
  if (v instanceof V.PyText) return v.typeName === 'range' ? v.text : `${v.typeName.replace(/^datetime\./, '')}(${v.text})`;
  if (v instanceof V.PyComplex) return `(${pyFloat(v.re)}${v.im < 0 ? '-' : '+'}${pyFloat(Math.abs(v.im))}j)`;
  if (v instanceof V.PySlice) return `slice(${shortRepr(v.start)}, ${shortRepr(v.stop)}, ${shortRepr(v.step)})`;
  if (v instanceof V.PyGlobal) return v.qualname;
  if (v instanceof V.NpDtype) return `dtype('${dtypeInfo(v).text || v.code}')`;
  if (v instanceof V.NdArray) return `array(${dtypeInfo(v.dtype).label}, shape (${(v.shape || []).join(', ')}${v.shape && v.shape.length === 1 ? ',' : ''}))`;
  if (v instanceof V.NpScalar) return scalarText(v).text;
  if (v instanceof V.PyObject) return `${v.className}(...)`;
  if (v instanceof V.PyPersistent) return `persistent_id(${shortRepr(v.pid, budget - 16, depth + 1)})`;
  if (depth > 3) return '...';
  const seq = (open, close, items, n) => {
    let s = open;
    for (let i = 0; i < items.length; i++) {
      const part = shortRepr(items[i], Math.max(10, budget - s.length), depth + 1);
      if (s.length + part.length > budget) { s += '...'; return s + close; }
      s += (i ? ', ' : '') + part;
    }
    return s + (n === 1 && open === '(' ? ',' : '') + close;
  };
  if (Array.isArray(v)) return V.isTuple(v) ? seq('(', ')', v.slice(0, 20), v.length) : seq('[', ']', v.slice(0, 20), v.length);
  if (v instanceof V.PySet) return v.items.length ? seq('{', '}', v.items.slice(0, 20)) : `${v.typeName}()`;
  if (v instanceof V.PyDict) {
    let s = '{';
    for (let i = 0; i < v.keys.length; i++) {
      const part = `${shortRepr(v.keys[i], 30, depth + 1)}: ${shortRepr(v.values[i], 40, depth + 1)}`;
      if (s.length + part.length > budget) return s + '...}';
      s += (i ? ', ' : '') + part;
    }
    return s + '}';
  }
  return typeOf(v);
}

function lengthText(v) {
  if (typeof v === 'string') return `${v.length.toLocaleString('en-US')} char${v.length === 1 ? '' : 's'}`;
  if (v instanceof V.PyBytes) return `${v.data.length.toLocaleString('en-US')} byte${v.data.length === 1 ? '' : 's'}`;
  if (Array.isArray(v)) return `${v.length.toLocaleString('en-US')} item${v.length === 1 ? '' : 's'}`;
  if (v instanceof V.PySet) return `${v.items.length.toLocaleString('en-US')} item${v.items.length === 1 ? '' : 's'}`;
  if (v instanceof V.PyDict) return `${v.size.toLocaleString('en-US')} key${v.size === 1 ? '' : 's'}`;
  return '';
}

/** Children of a value as [label, value, kind] where kind tags attribute/key/index. */
function childrenOf(v) {
  if (Array.isArray(v)) return { n: v.length, at: i => [`[${i}]`, v[i]] };
  if (v instanceof V.PySet) return { n: v.items.length, at: i => ['', v.items[i]] };
  if (v instanceof V.PyDict) return { n: v.size, at: i => [shortRepr(v.keys[i], 60), v.values[i], 'key'] };
  if (v instanceof V.PyObject) {
    const kids = [];
    if (v.args && v.args.length) kids.push(['args', v.args]);
    if (v.kwargs !== undefined) kids.push(['kwargs', v.kwargs]);
    let st = v.state;
    if (Array.isArray(st) && st.length === 2 && (st[0] instanceof V.PyDict || st[0] === null) && (st[1] instanceof V.PyDict || st[1] === null)) {
      if (st[0]) st[0].keys.forEach((k, i) => kids.push([typeof k === 'string' ? '.' + k : shortRepr(k, 40), st[0].values[i], 'attr']));
      st = st[1];
    }
    if (st instanceof V.PyDict) st.keys.forEach((k, i) => kids.push([typeof k === 'string' ? '.' + k : shortRepr(k, 40), st.values[i], 'attr']));
    else if (st !== undefined && st !== null) kids.push(['state', st]);
    if (v.listItems) v.listItems.forEach((x, i) => kids.push([`[${i}]`, x]));
    if (v.dictItems) v.dictItems.keys.forEach((k, i) => kids.push([shortRepr(k, 60), v.dictItems.values[i], 'key']));
    return { n: kids.length, at: i => kids[i] };
  }
  if (v instanceof V.PdIndex) return { n: v.fields.size, at: i => [String(v.fields.keys[i]), v.fields.values[i], 'key'] };
  if (v instanceof V.PdBlockManager) return { n: 2, at: i => (i ? ['axes', v.axes] : ['blocks', v.blocks]) };
  if (v instanceof V.PdBlock) return { n: 2, at: i => (i ? ['mgr_locs', v.locs] : ['values', v.values]) };
  if (v instanceof V.NdArray && v.objects) return { n: v.objects.length, at: i => [`[${i}]`, v.objects[i]] };
  if (v instanceof V.PyText && v.parts && v.parts.tz != null) return { n: 1, at: () => ['tzinfo', v.parts.tz] };
  if (v instanceof V.PyPersistent && v.pid && typeof v.pid === 'object') return { n: 1, at: () => ['pid', v.pid] };
  return null;
}

/**
 * Flatten the decoded value into tree nodes, breadth first, with caps so a huge file stays fast.
 * Node: { k: label, t: type, v: preview, len: length text, n: child count, c: child ids, more: hidden count,
 *         ph: placeholder class, arr: array index, df: frame index, ref: id of the first node for a shared object }
 */
function buildTree(root, opts = {}) {
  const maxNodes = opts.maxNodes || 50000, perNode = opts.perNode || 1000;
  const nodes = [];
  const seen = new Map();
  const arrays = [], frames = [];
  const arrayIndex = new Map(), frameIndex = new Map();
  const queue = [];
  let truncated = false;
  const add = (label, value, path) => {
    const t = typeOf(value);
    const node = { k: label, t, v: '', len: lengthText(value) };
    const id = nodes.length;
    nodes.push(node);
    if (value !== null && typeof value === 'object') {
      if (seen.has(value) && childrenOf(value)) { node.ref = seen.get(value); node.v = shortRepr(value, 60); return id; }
      seen.set(value, id);
    }
    if (value instanceof V.PyObject) node.ph = value.className;
    if (value instanceof V.NdArray) {
      if (!arrayIndex.has(value)) { arrayIndex.set(value, arrays.length); arrays.push({ value, path, node: id }); }
      node.arr = arrayIndex.get(value);
    }
    if (isFrame(value)) {
      if (!frameIndex.has(value)) { frameIndex.set(value, frames.length); frames.push({ value, path, node: id }); }
      node.df = frameIndex.get(value);
    }
    const kids = childrenOf(value);
    if (value instanceof V.NdArray) node.v = shortRepr(value);
    else if (!kids || typeof value === 'string' || value instanceof V.PyBytes) node.v = shortRepr(value, 300);
    else node.v = shortRepr(value, 90);
    if (kids && kids.n) { node.n = kids.n; queue.push({ id, kids, path }); }
    return id;
  };
  add('root', root, 'root');
  while (queue.length) {
    const { id, kids, path } = queue.shift();
    const node = nodes[id];
    node.c = [];
    const n = Math.min(kids.n, perNode);
    for (let i = 0; i < n; i++) {
      if (nodes.length >= maxNodes) { truncated = true; break; }
      const [label, value] = kids.at(i);
      const childPath = label.startsWith('[') || label.startsWith('.') ? path + label : `${path}[${label}]`;
      node.c.push(add(label, value, childPath));
    }
    if (kids.n > node.c.length) node.more = kids.n - node.c.length;
  }
  return { nodes, truncated, arrays, frames };
}

/**
 * The full model for one file.
 * @param {Uint8Array} bytes
 */
function buildModel(bytes, opts = {}) {
  const t0 = Date.now();
  const dis = disassemble(bytes, { maxLines: opts.maxLines || 20000 });
  const dec = unpickle(bytes, { maxEvents: opts.maxEvents || 20000 });
  const safety = analyze(dec.events, dec.eventCount, a => shortRepr(a, 120));
  const model = {
    size: bytes.length, protocol: dec.protocol || dis.protocol, highest: dis.highest, opCount: dis.total,
    error: dec.error, trailing: dec.trailing || 0, safety,
    ops: { lines: dis.lines, total: dis.total, counts: dis.counts, error: dis.error },
    tree: null, arrays: [], frames: [],
  };
  if (dec.error === null) {
    const tree = buildTree(dec.value, opts);
    model.tree = { nodes: tree.nodes, truncated: tree.truncated };
    model.arrays = tree.arrays.map(a => {
      try { return { ...arrayView(a.value, a.path, opts), node: a.node }; } catch (e) { return { path: a.path, node: a.node, note: `This array could not be read: ${e.message}` }; }
    });
    model.frames = tree.frames.map(f => {
      let v;
      try { v = frameView(f.value, x => cellText(x), opts); } catch (e) { v = { ok: false, reason: e.message }; }
      return { ...v, path: f.path, node: f.node };
    });
    // Arrays inside a readable DataFrame are its columns; the Tables tab shows them, so the Arrays tab skips them.
    const inner = model.frames.filter(f => f.ok).map(f => f.path + '._mgr');
    model.arrays = model.arrays.filter(a => !inner.some(p => a.path && a.path.startsWith(p)));
    for (const n of tree.nodes) delete n.arr;
    model.arrays.forEach((a, i) => { tree.nodes[a.node].arr = i; });
  }
  // A file that fails in its first bytes and has no PROTO header is most likely not a pickle at all.
  if (dec.error && bytes[0] !== 0x80 && (dec.error.pos || 0) < 16) {
    const head = Array.from(bytes.subarray(0, 48), c => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : c === 0x0a ? ' ' : '.')).join('');
    model.notPickle = { head: head.trim() + (bytes.length > 48 ? '...' : '') };
  }
  model.ms = Date.now() - t0;
  return model;
}

function cellText(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'number' && !Number.isInteger(v)) return pyFloat(v);
  return shortRepr(v, 120);
}

module.exports = { buildModel, buildTree, shortRepr, typeOf, pyFloat };
