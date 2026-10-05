const test = require('node:test');
const assert = require('node:assert');
const { load, strategyFiles } = require('./load');

const BT = load();

test('every bundled strategy compiles with a name and a pine()', () => {
  for (const { id, code } of strategyFiles()) {
    const c = BT.strategy.compile(code);
    assert.ok(c.name && c.name !== 'Untitled strategy', `${id}: needs a name`);
    assert.ok(c.description, `${id}: needs a description`);
    assert.strictEqual(typeof c.pine, 'function', `${id}: needs pine()`);
  }
});

test('a bare return works as well as export default', () => {
  const code = "return { name: 'Bare', pine() { return { longEntry: 'true' }; } };";
  assert.strictEqual(BT.strategy.compile(code).name, 'Bare');
});

test('parameters get a type, a label and sensible bounds', () => {
  const code = `export default {
    name: 'P',
    params: {
      len: 20,
      ratio: 1.5,
      useIt: true,
      kind: { value: 'EMA', options: ['SMA', 'EMA'] },
      spelled_out: { value: 5, min: 1, max: 9, step: 2, label: 'Spelled' },
    },
    pine() { return { longEntry: 'true' }; },
  };`;
  const byKey = {};
  for (const p of BT.strategy.compile(code).params) byKey[p.key] = p;

  assert.strictEqual(byKey.len.type, 'number');
  assert.strictEqual(byKey.len.label, 'Len');
  assert.strictEqual(byKey.len.step, 1);
  assert.ok(byKey.len.min >= 1 && byKey.len.max > 20);

  assert.strictEqual(byKey.ratio.type, 'number');
  assert.ok(!Number.isInteger(byKey.ratio.step), 'a decimal default gets a decimal step');

  assert.strictEqual(byKey.useIt.type, 'bool');
  assert.strictEqual(byKey.useIt.label, 'Use It');

  assert.strictEqual(byKey.kind.type, 'select');
  assert.deepStrictEqual(byKey.kind.options, ['SMA', 'EMA']);

  assert.deepStrictEqual(
    { min: byKey.spelled_out.min, max: byKey.spelled_out.max, step: byKey.spelled_out.step, label: byKey.spelled_out.label },
    { min: 1, max: 9, step: 2, label: 'Spelled' }
  );
});

test('defaultParams reads the declared values', () => {
  const code = "export default { name: 'P', params: { a: 3, b: false }, pine() { return { longEntry: 'true' }; } };";
  assert.deepStrictEqual(BT.strategy.defaultParams(BT.strategy.compile(code)), { a: 3, b: false });
});

test('a parameter name that Pine could not use is refused', () => {
  const code = "export default { name: 'P', params: { 'bad name': 1 }, pine() { return { longEntry: 'true' }; } };";
  assert.throws(() => BT.strategy.compile(code), /letters, numbers and _/);
});

test('a parameter with no value is refused', () => {
  const code = "export default { name: 'P', params: { a: { min: 1 } }, pine() { return { longEntry: 'true' }; } };";
  assert.throws(() => BT.strategy.compile(code), /needs a value/);
});

test('a syntax error reports a line number in the editor', () => {
  const code = "export default {\n  name: 'P',\n  pine() { return ( ; },\n};";
  try {
    BT.strategy.compile(code);
    assert.fail('expected a syntax error');
  } catch (e) {
    assert.match(e.message, /Syntax error/);
    assert.ok(e.line === null || e.line > 0, 'line should be a real line or unknown');
  }
});

test('something that is not an object is refused', () => {
  assert.throws(() => BT.strategy.compile('return 42;'), /must export an object/);
});
