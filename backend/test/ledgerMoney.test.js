// Unit tests for the exact (no floating point) money conversion used by
// the ledger at the API boundary.

const test = require('node:test');
const assert = require('node:assert/strict');
const { toMinor, fromMinor, rateToPpm, convertToBaseMinor } = require('../lib/ledgerCurrencies');

test('toMinor parses decimal strings exactly', () => {
  assert.equal(toMinor('1234.5', 2), 123450);
  assert.equal(toMinor('0.1', 2) + toMinor('0.2', 2), toMinor('0.3', 2));
  assert.equal(toMinor('1,000', 0), 1000);
  assert.equal(toMinor(19.99, 2), 1999);
  assert.equal(toMinor('', 2), 0);
  assert.equal(toMinor('7.10', 1), 71, 'trailing zeros are not extra precision');
});

test('toMinor rejects garbage and excess precision', () => {
  assert.throws(() => toMinor('12.345', 2));
  assert.throws(() => toMinor('10.5', 0));
  assert.throws(() => toMinor('abc', 2));
  assert.throws(() => toMinor('1e400', 2));
});

test('fromMinor formats minor units', () => {
  assert.equal(fromMinor(123450, 2), '1234.50');
  assert.equal(fromMinor(5, 2), '0.05');
  assert.equal(fromMinor(-5, 2), '-0.05');
  assert.equal(fromMinor(1500, 0), '1500');
});

test('rateToPpm and convertToBaseMinor round half away from zero', () => {
  assert.equal(rateToPpm('14000.5'), 14000500000);
  assert.throws(() => rateToPpm('0'));
  assert.throws(() => rateToPpm('-1'));
  // 100.25 EUR (cents) at 14000.5 -> SYP (0 digits)
  assert.equal(convertToBaseMinor(10025, 14000500000, 2, 0), 1403550);
  // 1500 SYP at 0.000067 -> USD cents: 0.1005 USD -> 10 cents
  assert.equal(convertToBaseMinor(1500, 67, 0, 2), 10);
  // exact .5 rounds up
  assert.equal(convertToBaseMinor(1, 500000, 0, 0), 1);
});
