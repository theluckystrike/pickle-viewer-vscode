'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { iterOps, decodeLong, pyStringLiteral, rawUnicodeEscape } = require('../src/core/opcodes');
const { disassemble, listingText } = require('../src/core/disasm');
const H = require('./helpers');

test.after(H.cleanup);
const B = s => new Uint8Array(Buffer.from(s, 'latin1'));

test('opcodes: every sample lists the same opcodes at the same bytes as Python pickletools', { skip: !H.hasPython }, () => {
  const dir = H.makeSamples(false);
  const fb = H.makeSamples(true);
  for (const d of [dir, fb]) {
    for (const f of fs.readdirSync(d)) {
      const ours = [...iterOps(H.read(d, f))].map(o => `${o.pos}:${o.name}`);
      // pickletools only reads opcodes; it never loads the file.
      const theirs = H.py('import pickletools,sys,json; print(json.dumps(["%d:%s" % (p, o.name) for o, a, p in pickletools.genops(open(sys.argv[1],"rb").read())]))', path.join(d, f));
      assert.deepEqual(ours, theirs, f);
    }
  }
});

test('opcodes: LONG1 and LONG4 are signed, big values become BigInt', () => {
  assert.equal(decodeLong(Uint8Array.from([0xff])), -1);
  assert.equal(decodeLong(Uint8Array.from([0x00, 0x80])), -32768);
  assert.equal(decodeLong(Uint8Array.from([0xff, 0x00])), 255);
  assert.equal(decodeLong(new Uint8Array(0)), 0);
  assert.equal(decodeLong(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0x40])), 2n ** 70n);
  const ops = [...iterOps(B('\x80\x02\x8a\x05\xec\xe5\x66\x41\xe3.'))];
  assert.equal(ops[1].arg, -123456789012);
});

test('opcodes: protocol 0 strings and unicode escapes are decoded', () => {
  assert.equal(pyStringLiteral("'a\\nb\\x41\\''"), "a\nbA'");
  assert.equal(pyStringLiteral('"it\'s"'), "it's");
  assert.throws(() => pyStringLiteral('abc'), /quotes/);
  assert.equal(rawUnicodeEscape(B('caf\\u00e9 \\u2713')), 'café ✓');
  assert.equal(rawUnicodeEscape(B('\\U0001f600')), '\u{1f600}');
});

test('opcodes: unknown opcode, cut-off argument and a missing STOP give plain errors with the byte', () => {
  assert.throws(() => [...iterOps(B('\x80\x02\xff.'))], e => e.pos === 2 && /Unknown opcode 0xff at byte 2/.test(e.message));
  assert.throws(() => [...iterOps(B('\x80\x04X\x10\x00\x00\x00abc'))], /ends inside the BINUNICODE opcode at byte 2/);
  assert.throws(() => [...iterOps(B('\x80\x02K\x01'))], /ends before the STOP/);
  assert.throws(() => [...iterOps(B('\x80\x04\x8e\xff\xff\xff\xff\xff\xff\xff\xff'))], /too large|ends inside/);
});

test('disasm: listing looks like pickletools, keeps counts for all opcodes and caps the lines', () => {
  const bytes = B("cos\nsystem\n(S'true'\ntR.");
  const d = disassemble(bytes);
  assert.equal(d.total, 6);
  assert.deepEqual(d.lines.map(l => l.name), ['GLOBAL', 'MARK', 'STRING', 'TUPLE', 'REDUCE', 'STOP']);
  const text = listingText(d.lines);
  assert.match(text, /0: c\s+GLOBAL\s+'os' 'system'/);
  assert.match(text, /\(MARK at 11\)/);
  assert.match(text, /STRING\s+'true'/);
  // a list of 5,000 ints: lines capped, counts complete
  const parts = ['\x80\x02]('];
  for (let i = 0; i < 5000; i++) parts.push('K\x01');
  parts.push('e.');
  const big = disassemble(B(parts.join('')), { maxLines: 100 });
  assert.equal(big.lines.length, 100);
  assert.equal(big.total, 5005);
  assert.equal(big.counts.BININT1, 5000);
});

test('disasm: a damaged file still lists the opcodes before the damage', () => {
  const d = disassemble(B('\x80\x02]K\x01a\xfe'));
  assert.equal(d.lines.length, 4);
  assert.match(d.error.message, /Unknown opcode 0xfe at byte 6/);
});
