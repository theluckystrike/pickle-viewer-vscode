'use strict';
// pandas DataFrame from its pickle state (BlockManager blocks and axes), without pandas.
const V = require('./values');
const { readerFor, dtypeInfo, prod } = require('./arrays');

const isFrame = v => v instanceof V.PyObject && v.cls instanceof V.PyGlobal && /^pandas\.core\.frame\.DataFrame$|^pandas\.DataFrame$/.test(v.cls.qualname);

function intOf(v) { return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : v instanceof V.PyFloat ? v.value : NaN; }

/** The manager inside a DataFrame's state, as PdBlockManager, from the pandas 2.x or the older layout. */
function managerOf(df) {
  let st = df.state;
  if (Array.isArray(st) && st[0] instanceof V.PyDict) st = st[0];
  if (!(st instanceof V.PyDict)) return null;
  const mgr = st.get('_mgr') ?? st.get('_data');
  if (mgr instanceof V.PdBlockManager) return mgr;
  if (mgr instanceof V.PyObject && /BlockManager$/.test(mgr.className) && Array.isArray(mgr.state)) {
    // (axes, block values, block items, {'0.14.1': {'axes': axes, 'blocks': [{'values', 'mgr_locs'}]}})
    const extra = mgr.state[3] instanceof V.PyDict ? mgr.state[3].get('0.14.1') : null;
    if (!(extra instanceof V.PyDict)) return null;
    let axes = extra.get('axes');
    if (!Array.isArray(axes) || !axes.length) axes = mgr.state[0];
    const blocks = (extra.get('blocks') || []).map(b => (b instanceof V.PyDict ? new V.PdBlock(b.get('values'), b.get('mgr_locs'), 2) : null));
    return new V.PdBlockManager(blocks, axes);
  }
  return null;
}

/** Labels of a pandas Index as an array of plain values, or null. */
function indexLabels(ix, n) {
  if (!(ix instanceof V.PdIndex)) return null;
  const f = ix.fields;
  if (/RangeIndex$/.test(ix.clsName)) {
    const start = intOf(f.get('start') ?? 0), stop = intOf(f.get('stop')), step = intOf(f.get('step') ?? 1);
    if (![start, stop, step].every(Number.isFinite) || step === 0) return null;
    const len = Math.max(0, Math.ceil((stop - start) / step));
    return { length: len, get: i => start + i * step, name: f.get('name') };
  }
  const data = f.get('data');
  if (data instanceof V.NdArray) {
    const r = readerFor(data);
    if (!r.ok) return null;
    return { length: prod(data.shape), get: r.get, fmt: r.fmt, name: f.get('name') };
  }
  if (Array.isArray(data)) return { length: data.length, get: i => data[i], name: f.get('name') };
  return n !== undefined ? null : null;
}

function locsOf(locs) {
  if (locs instanceof V.PySlice) {
    const s = intOf(locs.start ?? 0), e = intOf(locs.stop), st = intOf(locs.step ?? 1);
    if (![s, e, st].every(Number.isFinite) || st === 0) return null;
    const out = [];
    for (let i = s; st > 0 ? i < e : i > e; i += st) out.push(i);
    return out;
  }
  if (locs instanceof V.NdArray) { const r = readerFor(locs); if (!r.ok) return null; return Array.from({ length: prod(locs.shape) }, (_, i) => r.get(i)); }
  if (Array.isArray(locs)) return locs.map(intOf);
  if (locs instanceof V.PyObject && Array.isArray(locs.args) && locs.args[0]) return locsOf(locs.args[0]); // BlockPlacement(slice)
  return null;
}

/**
 * @param cell (value) -> display text for object cells
 * @returns {{ok:true, rows, cols, columns:{name,dtype}[], index:string[], cells:string[][], shownRows} | {ok:false, reason}}
 */
function frameView(df, cell, opts = {}) {
  const maxRows = opts.maxRows || 1000;
  const mgr = managerOf(df);
  if (!mgr) return { ok: false, reason: 'The DataFrame state has no block manager this viewer can read (it may come from a pandas version older than 0.14 or newer than 2.x).' };
  const [colAx, rowAx] = mgr.axes || [];
  const cols = indexLabels(colAx);
  const rows = indexLabels(rowAx);
  if (!cols) return { ok: false, reason: `The column labels use ${colAx && colAx.clsName ? colAx.clsName : 'a type'} that this viewer cannot read.` };
  const nRows = rows ? rows.length : null;
  const columns = Array.from({ length: cols.length }, (_, i) => ({ name: cell(cols.get(i)), dtype: '?' }));
  const getters = new Array(cols.length).fill(null);
  for (const b of mgr.blocks || []) {
    if (!(b instanceof V.PdBlock)) return { ok: false, reason: 'A block of this DataFrame is not in the pandas block layout.' };
    if (!(b.values instanceof V.NdArray)) {
      const t = b.values instanceof V.PyObject ? b.values.className : typeof b.values;
      return { ok: false, reason: `A column uses ${t}, an extension type this viewer does not rebuild.` };
    }
    const locs = locsOf(b.locs);
    if (!locs) return { ok: false, reason: 'The column positions of a block cannot be read.' };
    const r = readerFor(b.values);
    if (!r.ok) return { ok: false, reason: `A column has the dtype ${r.why}, which this viewer does not show in a table.` };
    const shape = b.values.shape;
    const k = shape.length === 2 ? shape[0] : 1;
    const n = shape.length === 2 ? shape[1] : shape[0];
    if (nRows !== null && n !== nRows) return { ok: false, reason: `A block has ${n} rows but the index has ${nRows}.` };
    const fortran = b.values.fortran && shape.length === 2;
    const label = r.kind === 'O' ? 'object' : r.kind === 'U' ? 'str' : r.label;
    locs.forEach((p, j) => {
      if (p < 0 || p >= cols.length || j >= k) return;
      columns[p].dtype = label;
      getters[p] = row => {
        const v = r.get(fortran ? row * k + j : j * n + row);
        return r.kind === 'O' || r.kind === 'U' ? cell(v) : r.fmt(v);
      };
    });
  }
  const missing = getters.findIndex(g => !g);
  if (missing >= 0 && cols.length) return { ok: false, reason: `Column ${columns[missing].name} has no data block.` };
  let total = nRows;
  if (total === null) {
    const b0 = (mgr.blocks || [])[0];
    total = b0 && b0.values && b0.values.shape ? b0.values.shape[b0.values.shape.length - 1] : 0;
  }
  const shown = Math.min(total, maxRows);
  const index = [], cells = [];
  for (let i = 0; i < shown; i++) {
    index.push(rows ? (rows.fmt ? rows.fmt(rows.get(i)) : cell(rows.get(i))) : String(i));
    cells.push(getters.map(g => g(i)));
  }
  return { ok: true, rows: total, cols: cols.length, columns, index, indexName: rows && rows.name != null ? cell(rows.name) : '', cells, shownRows: shown, dtypeCounts: columns.reduce((m, c) => ((m[c.dtype] = (m[c.dtype] || 0) + 1), m), {}) };
}

module.exports = { isFrame, frameView, managerOf, dtypeInfo };
