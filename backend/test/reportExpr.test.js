// backend/test/reportExpr.test.js
//
// Prompt 12b: the calculated-ratio language is parsed and evaluated by a
// small hand-written parser (lib/analytics/expr.js) — never eval / new
// Function. Precedence, unary minus, parentheses, null on division by zero
// or a missing value, and every hostile input refused with a clear code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../lib/analytics/expr');

const NAMES = ['net', 'cost', 'qty', 'margin'];
const calc = (text, values) => E.evaluate(E.parse(text, NAMES), values);

test('arithmetic: precedence, associativity, unary minus, parentheses, decimals', () => {
  const v = { net: 200, cost: 150, qty: 4, margin: 50 };
  assert.equal(calc('(net - cost) / net * 100', v), 25);
  assert.equal(calc('net - cost - qty', v), 46, 'left-associative minus');
  assert.equal(calc('net / qty / 2', v), 25, 'left-associative divide');
  assert.equal(calc('net + cost * 2', v), 500, '* before +');
  assert.equal(calc('-margin + 60', v), 10);
  assert.equal(calc('--qty', v), 4);
  assert.equal(calc('margin / net * 100', v), 25);
  assert.equal(calc('.5 * qty + 1.25', v), 3.25);
  assert.equal(calc('((((qty))))', v), 4);
  assert.equal(calc(`${'('.repeat(20)}qty${')'.repeat(20)}`, v), 4, '20 levels of parentheses are allowed');
});

test('division by zero and missing values give null, never Infinity or NaN', () => {
  assert.equal(calc('margin / net', { net: 0, margin: 5 }), null);
  assert.equal(calc('margin / (net - net)', { net: 3, margin: 5 }), null);
  assert.equal(calc('net + cost', { net: 1, cost: null }), null);
  assert.equal(calc('-cost', { cost: undefined }), null);
  assert.equal(calc('net / qty', { net: 0, qty: 3 }), 0);
});

test('hostile or invalid input is refused with a code, nothing is executed', () => {
  const bad = {
    'process.exit(1)': 'expr_bad_char',
    'net; cost': 'expr_bad_char',
    'constructor': 'expr_unknown_name',
    '__proto__': 'expr_unknown_name',
    'require': 'expr_unknown_name',
    'net ** 2': 'expr_syntax',
    'net +': 'expr_incomplete',
    '(net': 'expr_paren',
    'net cost': 'expr_syntax',
    '': 'expr_empty',
    '   ': 'expr_empty',
    'NET': 'expr_bad_char',
    'net % 2': 'expr_bad_char',
    '`net`': 'expr_bad_char',
    'net[0]': 'expr_bad_char',
    '1e9': 'expr_syntax',
    [`${'('.repeat(25)}net${')'.repeat(25)}`]: 'expr_too_deep',
    [`${'-'.repeat(25)}net`]: 'expr_too_deep',
    ['net+'.repeat(60) + 'net']: 'expr_too_long',
  };
  for (const [text, code] of Object.entries(bad)) {
    assert.throws(() => E.parse(text, NAMES), (e) => e instanceof E.ExprError && e.code === code && e.status === 400, `${JSON.stringify(text)} -> ${code}`);
  }
  assert.throws(() => E.parse(null, NAMES), (e) => e.code === 'expr_empty');
  assert.throws(() => E.parse({ toString: () => 'net' }, NAMES), (e) => e.code === 'expr_empty');
});

test('refs lists the measures an expression reads', () => {
  assert.deepEqual([...E.refs(E.parse('(net - cost) / net * qty', NAMES))].sort(), ['cost', 'net', 'qty']);
});

test('the module never reaches for eval, Function or vm', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'analytics', 'expr.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\beval\s*\(|new\s+Function|\bFunction\s*\(|require\(['"]vm['"]\)/);
});
