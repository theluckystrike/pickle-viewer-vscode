'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rate } = require('../src/core/safety');
const { buildModel } = require('../src/core/model');
const H = require('./helpers');

test.after(H.cleanup);
const B = s => new Uint8Array(Buffer.from(s, 'latin1'));

test('safety: commands, code and file access are risky', () => {
  for (const t of ['os.system', 'posix.system', 'nt.system', 'subprocess.Popen', 'subprocess.check_output', 'builtins.eval', '__builtin__.exec',
    'builtins.compile', 'builtins.open', 'builtins.__import__', 'builtins.getattr', 'sys.modules', 'importlib.import_module', 'runpy._run_code',
    'shutil.rmtree', 'socket.socket', 'ctypes.CDLL', 'pickle.loads', 'marshal.loads', 'pty.spawn', 'webbrowser.open', 'platform.popen', 'types.CodeType']) {
    assert.equal(rate(t).level, 'danger', t);
  }
});

test('safety: gadget helpers need a check, data types are fine, other packages need the package', () => {
  assert.equal(rate('operator.attrgetter').level, 'warn');
  assert.equal(rate('functools.partial').level, 'warn');
  assert.equal(rate('builtins.print').level, 'warn');
  for (const t of ['builtins.set', '__builtin__.frozenset', 'copy_reg._reconstructor', '_codecs.encode', 'collections.OrderedDict', 'datetime.datetime',
    'numpy.core.multiarray._reconstruct', 'numpy._core.multiarray._reconstruct', 'numpy.dtype', 'numpy.core.numeric._frombuffer',
    'pandas.core.frame.DataFrame', 'pandas._libs.internals._unpickle_block', 'sklearn.linear_model._base.LinearRegression']) {
    assert.equal(rate(t).level, 'data', t);
  }
  assert.equal(rate('lab.models.Experiment').level, 'custom');
  assert.equal(rate('__main__.Thing').level, 'custom');
  // look-alike names are not confused with risky modules
  assert.equal(rate('osmnx.graph').level, 'custom');
  assert.equal(rate('codecs_extra.x').level, 'custom');
  assert.equal(rate('operator_tools.x').level, 'custom');
});

test('safety: the os.system sample is flagged with its argument', { skip: !H.hasPython }, () => {
  const dir = H.makeSamples(false);
  const m = buildModel(H.read(dir, 'risky-os-system.pkl'));
  assert.equal(m.safety.verdict.level, 'danger');
  assert.match(m.safety.verdict.title, /os\.system/);
  assert.equal(m.safety.verdict.example, "os.system('true',)");
  assert.deepEqual(m.safety.rows.map(r => `${r.op} ${r.target} ${r.level}`), ['GLOBAL os.system danger', 'REDUCE os.system danger']);
  const sg = buildModel(H.read(dir, 'risky-stack-global.pkl'));
  assert.deepEqual(sg.safety.imports.map(i => i.target), ['subprocess.check_output', 'builtins.eval']);
  assert.ok(sg.safety.rows.some(r => r.op === 'STACK_GLOBAL' && r.target === 'builtins.eval' && r.level === 'danger'));
  const df = buildModel(H.read(dir, 'dataframe.pkl'));
  assert.equal(df.safety.verdict.level, 'data');
  assert.ok(df.safety.rows.some(r => r.op === 'BUILD'));
  const basic = buildModel(H.read(dir, 'basic-protocol4.pickle'));
  assert.equal(basic.safety.verdict.level, 'custom');
  assert.match(basic.safety.verdict.title, /lab/);
});

test('safety: every GLOBAL, STACK_GLOBAL, INST, REDUCE and BUILD is listed', () => {
  const m = buildModel(B("(S'id'\nios\nsystem\n.")); // INST os.system with ('id',)
  assert.equal(m.error, null);
  assert.deepEqual(m.safety.rows.map(r => r.op), ['INST']);
  assert.equal(m.safety.rows[0].args, "('id',)");
  assert.equal(m.safety.verdict.level, 'danger');
  const plain = buildModel(B('\x80\x04]K\x01a.'));
  assert.equal(plain.safety.verdict.level, 'data');
  assert.match(plain.safety.verdict.title, /No imports/);
});
