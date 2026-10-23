/**
 * @fileoverview Unit tests for the model's date strings in five time zones:
 * toLocalDateString must give the local calendar date, never the UTC one,
 * and formatDate must give the same en-US text whatever the zone.
 *
 * Each zone group assigns process.env.TZ, which Node applies to the local
 * Date getters at once, and then evaluates app.js afresh: an
 * Intl.DateTimeFormat fixes its time zone when it is built, and app.js
 * builds its display formatter once, at evaluation, so only an evaluation
 * made after the zone is set shows whether the display depends on the zone.
 * The cross-zone comparison evaluates app.js in each zone itself, so it
 * holds when run alone. node --test runs every test file in its own
 * process, so the setting cannot reach another file; it is still restored
 * after each group and after the comparison, and checked at the end.
 *
 * Run from the repository root:
 *   node --test "tests/unit/date-format.test.js"
 */
'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_TZ = process.env.TZ;

/**
 * 07:30 UTC on March 4: still March 3 in zones more than 7.5 hours behind
 * UTC (Los Angeles, Pago Pago).
 */
const INSTANT_A = '2025-03-04T07:30:00Z';

/**
 * 11:30 UTC on March 3: already March 4 in zones more than 12.5 hours ahead
 * of UTC (Kiritimati).
 */
const INSTANT_B = '2025-03-03T11:30:00Z';

/** The instants, in the order of each zone's `localDates`. */
const INSTANTS = Object.freeze([INSTANT_A, INSTANT_B]);

/**
 * Offset in minutes at INSTANT_A under the original TZ. Read at load, before
 * any group changes the zone, so the end can prove the restore took effect.
 */
const ORIGINAL_OFFSET_AT_A = new Date(INSTANT_A).getTimezoneOffset();

/**
 * Zones under test: UTC, UTC-8 (Los Angeles in winter), UTC+9 (Tokyo) and
 * the two extremes, UTC+14 (Kiritimati) and UTC-11 (Pago Pago).
 * `offsetAtA` is getTimezoneOffset() at INSTANT_A; `localDates` holds the
 * local calendar date of each entry of INSTANTS.
 */
const ZONES = Object.freeze([
  {
    zone: 'UTC',
    offsetAtA: 0,
    localDates: ['2025-03-04', '2025-03-03'],
  },
  {
    zone: 'America/Los_Angeles',
    offsetAtA: 480,
    localDates: ['2025-03-03', '2025-03-03'],
  },
  {
    zone: 'Asia/Tokyo',
    offsetAtA: -540,
    localDates: ['2025-03-04', '2025-03-03'],
  },
  {
    zone: 'Pacific/Kiritimati',
    offsetAtA: -840,
    localDates: ['2025-03-04', '2025-03-04'],
  },
  {
    zone: 'Pacific/Pago_Pago',
    offsetAtA: 660,
    localDates: ['2025-03-03', '2025-03-03'],
  },
]);

const FORMAT_CASES = Object.freeze([
  { input: '2025-03-03', expected: 'Mar 3, 2025' },
  { input: '2025-12-31', expected: 'Dec 31, 2025' },
  { input: '2024-02-29', expected: 'Feb 29, 2024' },
  // Los Angeles changes UTC offset on this date; the displayed calendar
  // day must remain March 9 in every zone.
  { input: '2025-03-09', expected: 'Mar 9, 2025' },
  // Not calendar dates: returned unchanged, so rendering never fails.
  { input: 'x', expected: 'x' },
  { input: '2025-02-30', expected: '2025-02-30' },
  // new Date(50, 0, 1) and Date.UTC would remap the year 50 to 1950.
  { input: '0050-01-01', expected: 'Jan 1, 50' },
]);

/**
 * Puts process.env.TZ back as it was at load, deleting it when it was unset,
 * since assigning undefined would store the string 'undefined'.
 */
function restoreTz() {
  if (ORIGINAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
}

/**
 * Evaluates app.js afresh and returns its model. app.js builds its display
 * formatter once, at evaluation, pinned to UTC; a formatter built without
 * that option would take the time zone in force at evaluation. Evaluating
 * afresh after each process.env.TZ assignment makes the loss of that option
 * observable: the cached loader would keep the first zone's formatter, and
 * the cross-zone comparison could not tell.
 * @returns {!Object} PlantModel from a new evaluation of app.js.
 */
function loadFreshModel() {
  delete require.cache[require.resolve('../support/load-app.js')];
  return require('../support/load-app.js').model;
}

/**
 * Returns the UTC calendar date of an instant, the value a toISOString-based
 * implementation would wrongly report as today.
 * @param {string} instant An ISO 8601 instant in UTC.
 * @returns {string} Its UTC date as `YYYY-MM-DD`.
 */
function utcDateOf(instant) {
  return new Date(instant).toISOString().slice(0, 10);
}

test('each instant falls on a non-UTC day in at least one zone', () => {
  INSTANTS.forEach((instant, index) => {
    const utcDate = utcDateOf(instant);
    const differing = ZONES.filter(
        ({ localDates }) => localDates[index] !== utcDate);
    assert.ok(differing.length > 0, `${instant} never differs from UTC`);
  });
});

for (const { zone, offsetAtA, localDates } of ZONES) {
  describe(zone, () => {
    /** This zone's model, evaluated after the zone is set. */
    let model;

    before(() => {
      process.env.TZ = zone;
      model = loadFreshModel();
    });
    after(restoreTz);

    test('the zone applies to the local Date getters', () => {
      assert.equal(new Date(INSTANT_A).getTimezoneOffset(), offsetAtA);
    });

    INSTANTS.forEach((instant, index) => {
      const expected = localDates[index];
      test(`toLocalDateString(${instant}) is ${expected}`, () => {
        const result = model.toLocalDateString(new Date(instant));
        assert.equal(result, expected);
        const utcDate = utcDateOf(instant);
        if (expected !== utcDate) {
          assert.notStrictEqual(result, utcDate);
        }
      });
    });

    test('toLocalDateString keeps a whole local day on one date', () => {
      const firstMoment = new Date(2025, 2, 6, 0, 0, 0, 0);
      const lastMoment = new Date(2025, 2, 6, 23, 59, 59, 999);
      assert.equal(model.toLocalDateString(firstMoment), '2025-03-06');
      assert.equal(model.toLocalDateString(lastMoment), '2025-03-06');
    });

    test('toLocalDateString zero-pads the month and day', () => {
      const date = new Date(2025, 0, 5, 12);
      assert.equal(model.toLocalDateString(date), '2025-01-05');
    });

    FORMAT_CASES.forEach(({ input, expected }) => {
      test(`formatDate('${input}') is '${expected}'`, () => {
        assert.equal(model.formatDate(input), expected);
      });
    });
  });
}

test('formatDate gives identical output in all five zones', () => {
  const outputsByZone = new Map();
  try {
    for (const { zone } of ZONES) {
      process.env.TZ = zone;
      const zoneModel = loadFreshModel();
      outputsByZone.set(
          zone, FORMAT_CASES.map(({ input }) => zoneModel.formatDate(input)));
    }
  } finally {
    restoreTz();
  }
  assert.deepEqual(
      [...outputsByZone.keys()], ZONES.map(({ zone }) => zone));
  const [[firstZone, first], ...others] = outputsByZone;
  assert.deepEqual(first, FORMAT_CASES.map(({ expected }) => expected));
  for (const [zone, outputs] of others) {
    assert.deepEqual(outputs, first, `${zone} differs from ${firstZone}`);
  }
});

test('process.env.TZ is restored after the zone groups', () => {
  if (ORIGINAL_TZ === undefined) {
    assert.equal('TZ' in process.env, false);
  } else {
    assert.equal(process.env.TZ, ORIGINAL_TZ);
  }
  assert.equal(
      new Date(INSTANT_A).getTimezoneOffset(), ORIGINAL_OFFSET_AT_A);
});
