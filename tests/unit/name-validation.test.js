/**
 * @fileoverview Unit tests for PlantModel.validateName: the required name,
 * the 80-character limit counted in Unicode code points, and trimming.
 *
 * Run from the repository root:
 *   node --test "tests/unit/name-validation.test.js"
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { model } = require('../support/load-app.js');

const { MESSAGES } = model;

/**
 * U+1F33F HERB: one code point but two UTF-16 code units, so a name built
 * from it tells a code-point count apart from String.prototype.length.
 */
const HERB = '🌿';

const NAME_REQUIRED = { ok: false, message: 'Enter a plant name' };

const NAME_TOO_LONG = {
  ok: false,
  message: 'Name must be 80 characters or fewer',
};

describe('validateName', () => {
  describe('constants and messages', () => {
    test('NAME_MAX_LENGTH is 80', () => {
      assert.equal(model.NAME_MAX_LENGTH, 80);
    });

    test('the name messages have their fixed texts', () => {
      assert.equal(MESSAGES.nameRequired, 'Enter a plant name');
      assert.equal(MESSAGES.nameTooLong, 'Name must be 80 characters or fewer');
    });
  });

  describe('required name', () => {
    const cases = [
      ['an empty string', ''],
      ['whitespace only', '  \t\n '],
      ['undefined', undefined],
      ['null', null],
      ['a number', 42],
      ['an object', {}],
    ];

    for (const [label, raw] of cases) {
      test(`refuses ${label} with nameRequired`, () => {
        assert.deepStrictEqual(model.validateName(raw), NAME_REQUIRED);
      });
    }
  });

  describe('length limit in code points', () => {
    test('the emoji fixtures are longer than 80 UTF-16 code units', () => {
      assert.equal(Array.from(HERB).length, 1);
      assert.equal(HERB.repeat(80).length, 160);
      assert.equal(HERB.repeat(41).length, 82);
    });

    const accepted = [
      ['80 ASCII characters', 'a'.repeat(80)],
      ['80 emoji (160 UTF-16 units)', HERB.repeat(80)],
      ['41 emoji (82 UTF-16 units)', HERB.repeat(41)],
    ];

    for (const [label, raw] of accepted) {
      test(`accepts ${label} unchanged`, () => {
        assert.deepStrictEqual(
            model.validateName(raw), { ok: true, value: raw });
      });
    }

    const refused = [
      ['81 ASCII characters', 'a'.repeat(81)],
      ['81 emoji', HERB.repeat(81)],
    ];

    for (const [label, raw] of refused) {
      test(`refuses ${label} with nameTooLong`, () => {
        assert.deepStrictEqual(model.validateName(raw), NAME_TOO_LONG);
      });
    }
  });

  describe('trimming', () => {
    const trimmed = [
      ['surrounding spaces', '  Monstera  ', 'Monstera'],
      [
        'two spaces each side of 80 characters',
        '  ' + 'a'.repeat(80) + '  ',
        'a'.repeat(80),
      ],
      [
        'only the ends of a name with inner whitespace',
        ' Monstera  deliciosa ',
        'Monstera  deliciosa',
      ],
    ];

    for (const [label, raw, value] of trimmed) {
      test(`trims ${label}`, () => {
        assert.deepStrictEqual(model.validateName(raw), { ok: true, value });
      });
    }

    test('counts the limit after trimming', () => {
      assert.deepStrictEqual(
          model.validateName('  ' + 'a'.repeat(81) + '  '), NAME_TOO_LONG);
    });
  });
});
