'use strict';
// An opcode listing in the style of Python's pickletools.dis. Reads bytes only.
const { iterOps, BY_CODE } = require('./opcodes');

const HEX = b => Array.from(b.subarray(0, 24), x => x.toString(16).padStart(2, '0')).join(' ');

function bytesRepr(b, max = 48) {
  let s = "b'";
  const n = Math.min(b.length, max);
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0x5c) s += '\\\\';
    else if (c === 0x27) s += "\\'";
    else if (c === 0x0a) s += '\\n';
    else if (c === 0x0d) s += '\\r';
    else if (c === 0x09) s += '\\t';
    else if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
    else s += '\\x' + c.toString(16).padStart(2, '0');
  }
  s += "'";
  if (b.length > max) s += ` ... (${b.length.toLocaleString('en-US')} bytes)`;
  return s;
}

function strRepr(s, max = 80) {
  const cut = s.length > max;
  const body = (cut ? s.slice(0, max) : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  return `'${body}'${cut ? ` ... (${s.length.toLocaleString('en-US')} chars)` : ''}`;
}

function argText(op) {
  const a = op.arg;
  if (a === undefined) return '';
  if (op.name === 'GLOBAL' || op.name === 'INST') return `${strRepr(a[0])} ${strRepr(a[1])}`;
  if (a instanceof Uint8Array) return op.name === 'BYTEARRAY8' ? `bytearray(${bytesRepr(a)})` : bytesRepr(a);
  if (typeof a === 'string') return strRepr(a);
  if (typeof a === 'bigint') return a.toString();
  if (typeof a === 'boolean') return a ? 'True' : 'False';
  if (typeof a === 'number' && (op.name === 'BINFLOAT' || op.name === 'FLOAT')) return Number.isInteger(a) ? a.toFixed(1) : String(a);
  return String(a);
}

/**
 * @returns {{lines:{pos:number, code:string, name:string, depth:number, arg:string}[], total:number, counts:Object<string,number>,
 *            protocol:number, highest:number, error:{message:string,pos:number}|null, endPos:number}}
 * maxLines caps the listing; total and counts cover the whole file.
 */
function disassemble(bytes, opts = {}) {
  const maxLines = opts.maxLines || 20000;
  const lines = [];
  const counts = {};
  let depth = 0, total = 0, protocol = 0, highest = 0, error = null, endPos = 0;
  const marks = [];
  try {
    for (const op of iterOps(bytes)) {
      total++;
      counts[op.name] = (counts[op.name] || 0) + 1;
      if (op.proto > highest) highest = op.proto;
      if (op.name === 'PROTO') protocol = op.arg;
      const closes = ['TUPLE', 'LIST', 'DICT', 'APPENDS', 'SETITEMS', 'POP_MARK', 'FROZENSET', 'ADDITEMS', 'INST', 'OBJ'].includes(op.name);
      if (closes && depth > 0) depth--;
      if (lines.length < maxLines) {
        let arg = argText(op);
        if (closes && marks.length) arg = (arg ? arg + ' ' : '') + `(MARK at ${marks[marks.length - 1]})`;
        const ch = BY_CODE[op.code].ch;
        const code = ch >= ' ' && ch <= '~' ? ch : '\\x' + op.code.toString(16).padStart(2, '0');
        lines.push({ pos: op.pos, code, name: op.name, depth, arg });
      }
      if (closes) marks.pop();
      if (op.name === 'MARK') { marks.push(op.pos); depth++; }
      endPos = op.end;
    }
  } catch (e) {
    error = { message: e.message, pos: e.pos ?? endPos };
  }
  return { lines, total, counts, protocol, highest, error, endPos };
}

/** The listing as plain text, like pickletools.dis prints it. */
function listingText(lines) {
  return lines.map(l => `${String(l.pos).padStart(8)}: ${l.code.padEnd(4)} ${'    '.repeat(l.depth)}${l.name.padEnd(16)} ${l.arg}`.trimEnd()).join('\n');
}

module.exports = { disassemble, listingText, bytesRepr, strRepr, HEX };
