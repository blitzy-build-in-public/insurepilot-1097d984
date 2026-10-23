/**
 * @fileoverview Unit tests for the model's date rules: validateDate, which
 * checks the Last watered field against today and returns the canonical
 * four-digit date, and isCalendarDate, which load validation relies on to
 * accept only canonical, existing calendar dates from storage.
 *
 * Run from the repository root:
 *   node --test "tests/unit/date-validation.test.js"
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { model } = require('../support/load-app.js');

/** Today for every validateDate call; the real clock is never read. */
const TODAY = '2025-03-06';

const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

const DATE_REQUIRED = { ok: false, message: 'Enter a date' };

const DATE_IN_FUTURE = { ok: false, message: 'Date cannot be in the future' };

/**
 * Builds validateDate's success result.
 * @param {string} value The expected canonical `YYYY-MM-DD` date.
 * @returns {{ok: true, value: string}} The expected result.
 */
function accepted(value) {
  return { ok: true, value };
}

/**
 * Renders a test input for a test name, keeping whitespace and type visible.
 * @param {*} value Any test input.
 * @returns {string} A readable rendering of `value`.
 */
function describeValue(value) {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return `Date(${value.toISOString()})`;
  }
  if (Array.isArray(value)) {
    return `array ${JSON.stringify(value)}`;
  }
  return String(value);
}

/**
 * Registers one validateDate test per row, named after its input.
 * @param {!Array<!Array<*>>} rows `[raw, expected]` pairs, where `expected`
 *     is the whole result validateDate must return against TODAY.
 */
function testValidateDate(rows) {
  for (const [raw, expected] of rows) {
    const outcome = expected.ok ? `accepts ${expected.value}` :
        `refuses with "${expected.message}"`;
    test(`${describeValue(raw)} ${outcome}`, () => {
      assert.deepStrictEqual(model.validateDate(raw, TODAY), expected);
    });
  }
}

/**
 * Registers one isCalendarDate test per row, named after its input.
 * @param {!Array<!Array<*>>} rows `[value, expected]` pairs, where
 *     `expected` is the boolean isCalendarDate must return.
 */
function testIsCalendarDate(rows) {
  for (const [value, expected] of rows) {
    test(`${describeValue(value)} is ${expected}`, () => {
      assert.equal(model.isCalendarDate(value), expected);
    });
  }
}

const EMPTY_CASES = [['', DATE_REQUIRED]];

// An array coerces to a matching string, so it catches a missing type check.
const NON_STRING_CASES = [
  [undefined, DATE_REQUIRED],
  [null, DATE_REQUIRED],
  [20250305, DATE_REQUIRED],
  [new Date(Date.UTC(2025, 2, 5)), DATE_REQUIRED],
  [['2025-03-05'], DATE_REQUIRED],
];

const PAST_CASES = [
  ['2025-03-05', accepted('2025-03-05')],
  ['2024-02-29', accepted('2024-02-29')],
  ['0001-01-01', accepted('0001-01-01')],
];

const TODAY_CASES = [[TODAY, accepted(TODAY)]];

const FUTURE_CASES = [
  ['2025-03-07', DATE_IN_FUTURE],
  ['9999-12-31', DATE_IN_FUTURE],
  ['10000-01-01', DATE_IN_FUTURE],
];

// A date input may report a year with leading zeros; its numeric value
// decides, and an accepted value is always padded back to four digits.
const PADDED_YEAR_CASES = [
  ['02025-01-01', accepted('2025-01-01')],
  ['0002025-03-05', accepted('2025-03-05')],
  ['02025-03-07', DATE_IN_FUTURE],
  ['010000-01-01', DATE_IN_FUTURE],
  ['00000-01-01', DATE_REQUIRED],
];

const MALFORMED_CASES = [
  ['2025-02-30', DATE_REQUIRED],
  ['2025-13-01', DATE_REQUIRED],
  ['03/06/2025', DATE_REQUIRED],
  ['2025-3-6', DATE_REQUIRED],
  ['2025-03-06T00:00', DATE_REQUIRED],
  [' 2025-03-05', DATE_REQUIRED],
  ['2025-00-10', DATE_REQUIRED],
  ['2025-03-00', DATE_REQUIRED],
  ['0000-01-01', DATE_REQUIRED],
];

describe('date messages', () => {
  test('MESSAGES.dateRequired is "Enter a date"', () => {
    assert.equal(model.MESSAGES.dateRequired, 'Enter a date');
  });

  test('MESSAGES.dateInFuture is "Date cannot be in the future"', () => {
    assert.equal(model.MESSAGES.dateInFuture, 'Date cannot be in the future');
  });
});

describe(`validateDate, today ${TODAY}`, () => {
  describe('empty', () => testValidateDate(EMPTY_CASES));
  describe('non-strings, without throwing', () => {
    testValidateDate(NON_STRING_CASES);
  });
  describe('valid past dates', () => testValidateDate(PAST_CASES));
  describe('today', () => testValidateDate(TODAY_CASES));
  describe('future dates', () => testValidateDate(FUTURE_CASES));
  describe('zero-padded years', () => testValidateDate(PADDED_YEAR_CASES));
  describe('malformed or non-existent dates', () => {
    testValidateDate(MALFORMED_CASES);
  });

  test('every accepted value is canonical, so storage never sees a padded ' +
      'year', () => {
    const acceptedInputs = [...PAST_CASES, ...TODAY_CASES, ...PADDED_YEAR_CASES]
        .filter(([, expected]) => expected.ok)
        .map(([raw]) => raw);
    assert.ok(acceptedInputs.includes('02025-01-01'));
    for (const raw of acceptedInputs) {
      const result = model.validateDate(raw, TODAY);
      assert.equal(result.ok, true, raw);
      assert.match(result.value, CANONICAL_DATE, raw);
      assert.equal(model.isCalendarDate(result.value), true, raw);
    }
  });
});

describe('isCalendarDate', () => {
  describe('Gregorian leap years', () => {
    testIsCalendarDate([
      ['2023-02-29', false],
      ['2000-02-29', true],
      ['1900-02-29', false],
      ['2024-02-29', true],
    ]);
  });

  describe('existing canonical dates', () => {
    testIsCalendarDate([
      ['2025-03-06', true],
      ['0001-01-01', true],
      ['9999-12-31', true],
      ['2025-04-30', true],
      ['2025-01-31', true],
    ]);
  });

  describe('out-of-range or non-canonical strings', () => {
    testIsCalendarDate([
      ['2025-00-10', false],
      ['2025-13-01', false],
      ['2025-03-00', false],
      ['2025-03-32', false],
      ['2025-04-31', false],
      ['0000-01-01', false],
      ['02025-01-01', false],
      ['2025-3-6', false],
      ['20250306', false],
      [' 2025-03-06', false],
      ['2025-03-06 ', false],
      ['', false],
    ]);
  });

  // An array coerces to a matching string, so it catches a missing type
  // check that load validation relies on.
  describe('non-strings', () => {
    testIsCalendarDate([
      [undefined, false],
      [null, false],
      [20250306, false],
      [new Date(0), false],
      [['2025-03-06'], false],
    ]);
  });
});
