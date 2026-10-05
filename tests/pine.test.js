/*
 * The generated Pine is what Trader.dev runs, so these tests check the two
 * things that matter: the script obeys the rules Trader.dev's engine
 * enforces, and it really does carry the app's current settings.
 */
const test = require('node:test');
const assert = require('node:assert');
const { load, strategyFiles } = require('./load');

const BT = load();

// The ta.* functions Trader.dev's engine implements.
const ALLOWED_TA = new Set(
  (
    'accdist alma atr barssince bb bbw cci change cmo cog correlation cross crossover crossunder cum dev dmi ema ' +
    'falling highest highestbars hma iii kc kcw linreg lowest lowestbars macd max median mfi min mode mom nvi obv ' +
    'percentile_linear_interpolation percentile_nearest_rank percentrank pivothigh pivotlow pvi pvt range rising ' +
    'rma roc rsi sar sma stdev stoch supertrend swma tr tsi valuewhen variance vwap vwma wad wma wpr wvad'
  ).split(' ')
);

const FORBIDDEN = [
  'strategy.cancel',
  'strategy.order(',
  'request.security',
  'array.',
  'map.',
  'matrix.',
  'line.new',
  'label.new',
  'calc_on_every_tick',
  'calc_on_order_fills',
  // the engine's parser stops at a '[' that opens a list, so no input may
  // carry options=[...] — a dropdown has to be a plain string input
  'options=[',
];

const settings = (over) => Object.assign({}, BT.strategy.DEFAULT_SETTINGS, over || {});

function build(code, over, paramOver) {
  const compiled = BT.strategy.compile(code);
  const params = Object.assign(BT.strategy.defaultParams(compiled), paramOver || {});
  return BT.pine.build(compiled, params, settings(over));
}

const MA_CROSS = strategyFiles().find((s) => s.id === 'ma_crossover').code;

test('every bundled strategy generates Pine that obeys the engine rules', () => {
  const files = strategyFiles();
  assert.ok(files.length >= 8, 'expected the example strategies to be there');
  for (const { id, code } of files) {
    const src = build(code);
    assert.match(src, /^\/\/@version=6\n/, `${id}: must declare Pine v6`);
    assert.match(src, /pyramiding=1/, `${id}: pyramiding must be 1`);
    assert.match(src, /process_orders_on_close=true/, `${id}: must fill on bar close`);
    assert.match(src, /commission_type=strategy\.commission\.percent, commission_value=0\.05/, `${id}: commission profile`);
    assert.match(src, /default_qty_type=strategy\.percent_of_equity, default_qty_value=100/, `${id}: sizing profile`);
    assert.match(src, /margin_long=100, margin_short=100/, `${id}: margin profile`);
    assert.match(src, /strategy\.entry\(/, `${id}: must open a position somewhere`);
    for (const bad of FORBIDDEN) {
      assert.ok(!src.includes(bad), `${id}: must not use ${bad}`);
    }
    for (const m of src.matchAll(/\bta\.([a-z_]+)\s*\(/g)) {
      assert.ok(ALLOWED_TA.has(m[1]), `${id}: ta.${m[1]} is not on the engine's allowlist`);
    }
    assert.ok(!/\b(undefined|NaN|null)\b/.test(src), `${id}: generated code leaked a JavaScript value`);
  }
});

test('each parameter becomes a Pine input holding its current value', () => {
  const src = build(MA_CROSS, null, { fast: 7, slow: 99, type: 'SMA' });
  assert.match(src, /p_fast = input\.int\(7, "Fast MA length", minval=2, maxval=200/);
  assert.match(src, /p_slow = input\.int\(99, "Slow MA length"/);
  // Trader.dev's parser rejects options=[...], so the choices go in the title
  assert.match(src, /p_type = input\.string\("SMA", "MA type \(SMA\/EMA\/WMA\)"\)/);
  // the body refers to the inputs, not to baked-in numbers
  assert.match(src, /ta\.sma\(close, p_fast\)/);
});

test('changing a parameter changes the code that would be sent', () => {
  const a = build(MA_CROSS, null, { fast: 10 });
  const b = build(MA_CROSS, null, { fast: 11 });
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, build(MA_CROSS, null, { fast: 10 }), 'the same inputs must give the same script');
});

test('float parameters keep a decimal point so Pine sees a float', () => {
  const bb = strategyFiles().find((s) => s.id === 'bollinger_breakout').code;
  const src = build(bb, null, { mult: 2 });
  assert.match(src, /p_mult = input\.float\(2\.0, "Width/);
});

test('a stop loss becomes an input and a strategy.exit', () => {
  const off = build(MA_CROSS);
  assert.ok(!off.includes('r_stopLossPct'));
  assert.ok(!off.includes('strategy.exit('), 'with no stop or target there is nothing to place');

  const on = build(MA_CROSS, { stopLossPct: 2.5 });
  assert.match(on, /r_stopLossPct = input\.float\(2\.5, "Stop loss %", minval=0\.0\)/);
  assert.match(on, /lStop := close \* \(1 - r_stopLossPct \/ 100\)/);
  assert.match(on, /sStop := close \* \(1 \+ r_stopLossPct \/ 100\)/);
  assert.match(on, /strategy\.exit\("LX", from_entry="L", stop=lStop\)/);
});

test('the ATR stop wins over stop loss %, as it does in the app', () => {
  const src = build(MA_CROSS, { stopLossPct: 2, atrStopMult: 1.5, atrLength: 20 });
  assert.match(src, /atrVal = ta\.atr\(r_atrLength\)/);
  assert.match(src, /r_atrLength = input\.int\(20, "ATR length", minval=1\)/);
  assert.match(src, /lStop := nz\(close - r_atrStopMult \* atrVal, close \* \(1 - r_stopLossPct \/ 100\)\)/);
});

test('a strategy that sets its own stop keeps it, with the sidebar as the fallback', () => {
  const donchian = strategyFiles().find((s) => s.id === 'donchian_breakout').code;
  const src = build(donchian, { stopLossPct: 3 });
  assert.match(src, /lStop := nz\(\(close - p_stopAtr \* atrVal\), close \* \(1 - r_stopLossPct \/ 100\)\)/);
});

test('reward:risk builds the target from the stop, and does nothing without one', () => {
  const withStop = build(MA_CROSS, { stopLossPct: 2, rrTarget: 3 });
  assert.match(withStop, /lTarget := na\(lStop\) \? na : close \+ r_rrTarget \* math\.abs\(close - lStop\)/);
  const withoutStop = build(MA_CROSS, { rrTarget: 3 });
  assert.ok(!withoutStop.includes('r_rrTarget'), 'reward:risk needs a stop to measure from');
});

test('the trailing stop ratchets instead of closing at the bar close', () => {
  const src = build(MA_CROSS, { trailingStopPct: 4 });
  assert.match(src, /lPeak := math\.max\(nz\(lPeak, high\), high\)/);
  assert.match(src, /lTrail = lPeak \* \(1 - r_trailingStopPct \/ 100\)/);
  assert.match(src, /lStop := na\(lStop\) \? lTrail : math\.max\(lStop, lTrail\)/);
  assert.match(src, /strategy\.exit\("LX", from_entry="L", stop=lStop\)/);
  // the pattern the engine rejects: comparing low to the trail, then closing
  assert.ok(!/low <= \w*[Tt]rail/.test(src));
  assert.ok(!/high >= \w*[Tt]rail/.test(src));
});

test('break-even moves the stop to the entry once the trade is far enough ahead', () => {
  const src = build(MA_CROSS, { stopLossPct: 2, breakEvenR: 1.5 });
  assert.match(src, /lRisk := na\(lStop\) \? na : math\.abs\(close - lStop\)/);
  assert.match(src, /if not na\(lRisk\) and high - lEntry >= r_breakEvenR \* lRisk/);
  assert.match(src, /lStop := na\(lStop\) \? lEntry : math\.max\(lStop, lEntry\)/);
});

test('the time stop closes the position after the given number of bars', () => {
  const src = build(MA_CROSS, { maxBarsInTrade: 30 });
  assert.match(src, /r_maxBarsInTrade = input\.int\(30, "Time stop \(bars\)", minval=1\)/);
  assert.match(src, /if not na\(lBar\) and bar_index - lBar >= r_maxBarsInTrade/);
  assert.match(src, /strategy\.close\("L"\)/);
});

test('the trend filter only blocks entries', () => {
  const src = build(MA_CROSS, { trendFilterLength: 150 });
  assert.match(src, /trendVal = ta\.sma\(close, r_trendFilterLength\)/);
  assert.match(src, /longEntry = \(ta\.crossover\(fastMa, slowMa\)\) and close > trendVal/);
  assert.match(src, /shortEntry = \(ta\.crossunder\(fastMa, slowMa\)\) and close < trendVal/);
});

test('with shorting off a short signal closes the long instead of selling', () => {
  const src = build(MA_CROSS, { allowShorts: false });
  assert.ok(!src.includes('strategy.entry("S"'), 'must not open shorts');
  assert.match(src, /longExit = \(ta\.crossunder\(fastMa, slowMa\)\)/);
  assert.match(src, /strategy\.close\("L"\)/);
});

test('starting capital reaches the strategy header', () => {
  assert.match(build(MA_CROSS, { capital: 25000 }), /initial_capital=25000/);
});

test('a strategy without pine() is refused with an explanation', () => {
  assert.throws(
    () => BT.strategy.compile("export default { name: 'x', params: {} };"),
    /needs a pine\(\{ p \}\) function/
  );
});

test('pine() must return an entry condition', () => {
  const code = "export default { name: 'x', pine() { return { body: 'a = close' }; } };";
  assert.throws(() => build(code), /longEntry or shortEntry/);
});

test('the sweepable list covers the parameters and only the settings in use', () => {
  const compiled = BT.strategy.compile(MA_CROSS);
  const off = BT.pine.sweepable(compiled, settings());
  assert.deepStrictEqual(off.map((p) => p.name), ['p_fast', 'p_slow']);

  const on = BT.pine.sweepable(compiled, settings({ atrStopMult: 2, rrTarget: 2 }));
  const names = on.map((p) => p.name);
  assert.ok(names.includes('r_atrStopMult'));
  assert.ok(names.includes('r_rrTarget'));
  assert.ok(names.includes('r_atrLength'), 'the ATR length matters once the ATR stop is on');
  assert.ok(!names.includes('r_stopLossPct'), 'a setting that is off is not in the script to sweep');
});

test('the new-strategy template generates valid Pine', () => {
  const src = build(BT.strategy.TEMPLATE);
  assert.match(src, /ta\.ema\(close, p_fast\)/);
  assert.match(src, /strategy\.entry\("L", strategy\.long\)/);
});
