'use strict';
// NumPy arrays rebuilt from pickle data: dtype parsing, stats, a block-mean heatmap grid and a value grid.
// decodePlain comes from our tensor viewer (src/core/dtypes.js). Bytes are only read as numbers.
const { decodePlain } = require('./dtypes');
const V = require('./values');

const KIND = {
  b1: ['bool', 'bool'], i1: ['i8', 'int8'], i2: ['i16', 'int16'], i4: ['i32', 'int32'], i8: ['i64', 'int64'],
  u1: ['u8', 'uint8'], u2: ['u16', 'uint16'], u4: ['u32', 'uint32'], u8: ['u64', 'uint64'],
  f2: ['f16', 'float16'], f4: ['f32', 'float32'], f8: ['f64', 'float64'], c8: ['c64', 'complex64'], c16: ['c128', 'complex128'],
};
const SIZE = { bool: 1, i8: 1, u8: 1, i16: 2, u16: 2, f16: 2, i32: 4, u32: 4, f32: 4, i64: 8, u64: 8, f64: 8, c64: 8, c128: 16 };

/** Parse a numpy dtype into { kind, label, size, little, text } or { kind:null, label } when it is not a plain number type. */
function dtypeInfo(dt) {
  if (!(dt instanceof V.NpDtype)) return { kind: null, label: 'unknown dtype' };
  const code = dt.code.replace(/^[<>|=]/, '');
  const endian = /^[<>|=]/.test(dt.code) ? dt.code[0] : dt.endian;
  const little = endian !== '>';
  if (dt.fields) return { kind: null, label: 'structured dtype', code };
  if (dt.subarray) return { kind: null, label: 'subarray dtype', code };
  const k = KIND[code];
  if (k) return { kind: k[0], label: k[1], size: SIZE[k[0]], little, text: `${endian === '|' ? '|' : little ? '<' : '>'}${code}` };
  let m = /^U(\d+)$/.exec(code);
  if (m) return { kind: 'U', label: `str (<U${m[1]})`, size: 4 * Number(m[1]), chars: Number(m[1]), little };
  m = /^S(\d+)$/.exec(code);
  if (m) return { kind: 'S', label: `bytes (S${m[1]})`, size: Number(m[1]) };
  if (/^O\d*$/.test(code)) return { kind: 'O', label: 'object' };
  if (/^M8/.test(code)) return { kind: null, label: 'datetime64' };
  if (/^m8/.test(code)) return { kind: null, label: 'timedelta64' };
  return { kind: null, label: code };
}

const prod = s => s.reduce((a, b) => a * b, 1);
const CHUNK = 1 << 20;

/** Decode values [start, start+n) of a plain array as float64. */
function decodeRange(arr, info, start, n) {
  const b = arr.raw.subarray(start * info.size, (start + n) * info.size);
  return decodePlain(info.kind, b, n, info.little);
}

function fmtNum(x, kind) {
  if (x === null || x === undefined) return '';
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (kind === 'bool') return x ? 'True' : 'False';
  if (kind && /^[iu]/.test(kind)) return String(Math.round(x));
  if (Number.isInteger(x) && Math.abs(x) < 1e15) return x.toFixed(1);
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-4 || a >= 1e9)) return x.toExponential(4).replace(/\.?0+e/, 'e');
  return String(Number(x.toPrecision(6)));
}

function utf32(bytes, little) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let s = '';
  for (let i = 0; i + 4 <= bytes.length; i += 4) {
    const cp = dv.getUint32(i, little);
    if (cp === 0) break;
    s += cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
  }
  return s;
}

/**
 * Turn an NdArray into the view model for the Arrays tab.
 * opts: { grid: 256, gridRows: 50, gridCols: 20, flatValues: 500 }
 */
function arrayView(arr, path, opts = {}) {
  const G = opts.grid || 256, GR = opts.gridRows || 50, GC = opts.gridCols || 20, FLAT = opts.flatValues || 500;
  const shape = (arr.shape || []).map(Number);
  const count = prod(shape);
  const info = dtypeInfo(arr.dtype);
  const out = { path, clsName: arr.clsName, dtype: info.label, dtypeCode: info.text || (arr.dtype && arr.dtype.code) || '', shape, count, order: arr.fortran ? 'F' : 'C', plain: false };
  if (!Number.isSafeInteger(count) || shape.some(d => !Number.isInteger(d) || d < 0)) { out.note = 'The shape is not valid.'; return out; }
  if (info.kind === 'O') { out.note = 'Object array: its values are Python objects. They are listed in the Tree tab.'; out.objects = true; return out; }
  if (!info.kind) { out.note = `The ${info.label} type is not shown as numbers. The array is listed in the Tree tab.`; return out; }
  if (!arr.raw) { out.note = 'The array data is not in this file (out-of-band buffer).'; return out; }
  out.bytes = arr.raw.length;
  if (arr.raw.length < count * info.size) { out.note = `The data is cut off: ${count * info.size} bytes expected, ${arr.raw.length} found.`; return out; }

  if (info.kind === 'U' || info.kind === 'S') {
    const n = Math.min(count, FLAT);
    const vals = [];
    for (let i = 0; i < n; i++) {
      const b = arr.raw.subarray(i * info.size, (i + 1) * info.size);
      vals.push(info.kind === 'U' ? utf32(b, info.little) : String.fromCharCode(...b.subarray(0, Math.max(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)))));
    }
    out.grid = flatGrid(vals, count);
    out.note = 'Text array: values are shown as text, without number stats.';
    return out;
  }

  out.plain = true;
  // Stats over every value, in chunks so a big array does not need one huge buffer.
  let min = Infinity, max = -Infinity, sum = 0, finite = 0, nan = 0, inf = 0;
  for (let s = 0; s < count; s += CHUNK) {
    const v = decodeRange(arr, info, s, Math.min(CHUNK, count - s));
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (Number.isFinite(x)) { if (x < min) min = x; if (x > max) max = x; sum += x; finite++; } else if (Number.isNaN(x)) nan++; else inf++;
    }
  }
  out.stats = { min: finite ? min : null, max: finite ? max : null, mean: finite ? sum / finite : null, finite, nan, inf };
  out.statsText = { min: fmtNum(out.stats.min, info.kind), max: fmtNum(out.stats.max, info.kind), mean: out.stats.mean === null ? '' : fmtNum(out.stats.mean, 'f64') };
  if (info.kind === 'c64' || info.kind === 'c128') out.note = 'Complex values: stats and colors use the magnitude.';

  if (shape.length === 0 || shape.length === 1 || count === 0) {
    const n = Math.min(count, FLAT);
    const v = n ? decodeRange(arr, info, 0, n) : [];
    out.grid = flatGrid(Array.from(v, x => fmtNum(x, info.kind)), count);
    return out;
  }

  // 2-D view: rows = all leading dimensions, cols = last dimension.
  let rows = count / shape[shape.length - 1], cols = shape[shape.length - 1];
  let transposed = false;
  let at; // logical (r, c) -> flat index in memory
  if (arr.fortran && shape.length === 2) at = (r, c) => c * rows + r;
  else if (arr.fortran) { transposed = true; cols = shape[0]; rows = count / cols; at = (r, c) => r * cols + c; }
  else at = (r, c) => r * cols + c;

  // Value grid: top-left corner.
  const gr = Math.min(rows, GR), gc = Math.min(cols, GC);
  const cells = [];
  const small = count <= 4 * CHUNK ? decodeRange(arr, info, 0, count) : null;
  const valueAt = (r, c) => {
    const i = at(r, c);
    return small ? small[i] : decodeRange(arr, info, i, 1)[0];
  };
  for (let r = 0; r < gr; r++) { const row = []; for (let c = 0; c < gc; c++) row.push(fmtNum(valueAt(r, c), info.kind)); cells.push(row); }
  out.grid = { rows, cols, shownRows: gr, shownCols: gc, cells };

  // Heatmap: block means on at most G x G cells.
  const hr = Math.min(rows, G), hc = Math.min(cols, G);
  const sums = new Float64Array(hr * hc), ns = new Uint32Array(hr * hc);
  const rowStep = Math.max(1, Math.floor(rows / (G * 4))); // sample rows evenly when there are very many
  const contiguous = !(arr.fortran && shape.length === 2);
  for (let r = 0; r < rows; r += rowStep) {
    const R = Math.min(hr - 1, Math.floor((r * hr) / rows));
    let line;
    if (small) line = null; else if (contiguous) line = decodeRange(arr, info, at(r, 0), cols);
    const colStep = Math.max(1, Math.floor(cols / (G * 4)));
    for (let c = 0; c < cols; c += colStep) {
      const x = small ? small[at(r, c)] : contiguous ? line[c] : valueAt(r, c);
      if (!Number.isFinite(x)) continue;
      const k = R * hc + Math.min(hc - 1, Math.floor((c * hc) / cols));
      sums[k] += x; ns[k]++;
    }
  }
  const data = new Array(hr * hc);
  for (let i = 0; i < data.length; i++) data[i] = ns[i] ? sums[i] / ns[i] : null;
  out.heat = { rows: hr, cols: hc, srcRows: rows, srcCols: cols, data, reshaped: shape.length > 2, transposed, sampled: rowStep > 1 };
  return out;
}

function flatGrid(values, count) {
  const per = 10;
  const cells = [];
  for (let i = 0; i < values.length; i += per) cells.push(values.slice(i, i + per));
  return { flat: true, per, count, shown: values.length, cells };
}

/** A numpy scalar (numpy.core.multiarray.scalar) as text. */
function scalarText(s) {
  const info = dtypeInfo(s.dtype);
  const raw = s.raw instanceof Uint8Array ? s.raw : null;
  if (info.kind && SIZE[info.kind] && raw && raw.length >= info.size) return { type: `numpy.${info.label}`, text: fmtNum(decodePlain(info.kind, raw, 1, info.little)[0], info.kind) };
  if (info.kind === 'U' && raw) return { type: 'numpy.str_', text: utf32(raw, info.little) };
  return { type: `numpy scalar (${info.label})`, text: '' };
}

/** Read one value of a plain array (used by the DataFrame reader). */
function readerFor(arr) {
  const info = dtypeInfo(arr.dtype);
  if (arr.objects) return { ok: true, kind: 'O', get: i => arr.objects[i] };
  if (!info.kind || !arr.raw || info.kind === 'S') return { ok: false, why: info.label };
  if (info.kind === 'U') return { ok: true, kind: 'U', get: i => utf32(arr.raw.subarray(i * info.size, (i + 1) * info.size), info.little) };
  if (arr.raw.length < prod(arr.shape) * info.size) return { ok: false, why: 'cut off' };
  const all = prod(arr.shape) <= 4 * CHUNK ? decodePlain(info.kind, arr.raw, prod(arr.shape), info.little) : null;
  return { ok: true, kind: info.kind, label: info.label, get: i => (all ? all[i] : decodeRange(arr, info, i, 1)[0]), fmt: x => fmtNum(x, info.kind) };
}

module.exports = { dtypeInfo, arrayView, scalarText, readerFor, fmtNum, prod };
