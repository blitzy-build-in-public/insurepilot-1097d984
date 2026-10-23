/**
 * @fileoverview Unit tests for the storage module and the load-time entry
 * checks: load and save from PlantStorage.createPlantStorage, its storage
 * handle resolution, and PlantModel.normalizeStoredPlants.
 *
 * Every store receives its storage object through `getStorage`, so the
 * suite never reads a global localStorage: Node.js 25 and later define one,
 * and Node.js 26 throws on access without --localstorage-file. Each test
 * builds its own fake and store, so no state is shared between tests.
 *
 * Run from the repository root:
 *   node --test "tests/unit/storage.test.js"
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { model, storage } = require('../support/load-app.js');
const {
  createFakeStorage,
  blockedGetStorage,
} = require('../support/fake-storage.js');

/** The storage key, spelled out so that a change to it fails this suite. */
const KEY = 'plant-parent.plants.v1';

/** A canonical stored date: exactly four year digits. */
const STORED_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A valid stored record, reused as an expected value. */
const MONSTERA = Object.freeze(
    { id: 'p-a', name: 'Monstera', lastWatered: '2025-03-03' });

/** A second valid stored record. */
const FERN = Object.freeze(
    { id: 'p-b', name: 'Fern', lastWatered: '2025-03-05' });

/** What load() returns when storage cannot be reached. */
const UNAVAILABLE_LOAD = Object.freeze(
    { plants: [], available: false, unreadable: false });

/** What save() returns when storage cannot be reached. */
const UNAVAILABLE_SAVE = Object.freeze({ ok: false, reason: 'unavailable' });

/** What save() returns when the write throws. */
const WRITE_FAILED = Object.freeze({ ok: false, reason: 'write-failed' });

/** Both orders in which a store's first call can resolve its handle. */
const CALL_ORDERS = Object.freeze([['load', 'save'], ['save', 'load']]);

/**
 * Serialises stored entries the way the storage key holds them.
 * @param {!Array<*>} entries The entries, valid or not.
 * @returns {string} The JSON text to seed.
 */
function seed(entries) {
  return JSON.stringify(entries);
}

/**
 * Creates a makeId double returning 'p-test-1', 'p-test-2', and so on.
 * Each call is logged in the double's `calls` array as a snapshot of its
 * argument, because normalizeStoredPlants keeps adding to the Set it
 * passes, together with whether that argument was a Set.
 * @returns {function(!Set<string>): string} The double, with a
 *     `calls: !Array<{ids: !Set<string>, isSet: boolean}>` property.
 */
function makeIdCounter() {
  const calls = [];
  const makeId = (usedIds) => {
    calls.push({ ids: new Set(usedIds), isSet: usedIds instanceof Set });
    return `p-test-${calls.length}`;
  };
  makeId.calls = calls;
  return makeId;
}

/**
 * Wraps a storage getter and counts its invocations, which shows whether a
 * store resolves its handle once and remembers the outcome.
 * @param {function(): *} getStorage The getter to wrap.
 * @returns {function(): *} The wrapper, with a numeric `count` property.
 */
function countingGetStorage(getStorage) {
  const counted = () => {
    counted.count += 1;
    return getStorage();
  };
  counted.count = 0;
  return counted;
}

/**
 * Creates a store over a storage double.
 * @param {!Object} fake The storage double.
 * @param {function(!Set<string>): string} makeId The id repair function.
 * @returns {{load: function(): !Object, save: function(!Array): !Object}}
 *     The store.
 */
function storeOver(fake, makeId) {
  return storage.createPlantStorage({ getStorage: () => fake, makeId });
}

/**
 * Loads once from a fresh double seeded with a raw value.
 * @param {string|undefined} raw The raw stored value; undefined leaves the
 *     key absent.
 * @param {function(!Set<string>): string=} makeId The id repair function.
 * @returns {{fake: !Object, result: !Object}} The double and the result of
 *     load().
 */
function loadSeeded(raw, makeId = makeIdCounter()) {
  const fake = createFakeStorage({ initial: raw });
  return { fake, result: storeOver(fake, makeId).load() };
}

/**
 * Asserts that nothing was written: no setItem attempt, and the stored
 * value exactly as seeded.
 * @param {!Object} fake The storage double.
 * @param {?string} raw The seeded value, or null for an absent key.
 */
function assertNotWritten(fake, raw) {
  assert.deepEqual(fake.writes, []);
  assert.equal(fake.getItem(KEY), raw);
}

/**
 * Asserts that both methods of a store report storage unavailable.
 * @param {{load: function(): !Object, save: function(!Array): !Object}}
 *     store The store under test.
 * @param {!Array<string>} order The methods to call, 'load' or 'save', in
 *     calling order.
 */
function assertUnavailable(store, order) {
  for (const method of order) {
    if (method === 'load') {
      assert.deepEqual(store.load(), UNAVAILABLE_LOAD);
    } else {
      assert.deepEqual(store.save([MONSTERA]), UNAVAILABLE_SAVE);
    }
  }
}

describe('STORAGE_KEY', () => {
  test('is plant-parent.plants.v1', () => {
    assert.equal(storage.STORAGE_KEY, KEY);
  });
});

describe('load: reads that succeed', () => {
  test('returns two valid entries in order without writing', () => {
    const raw = seed([MONSTERA, FERN]);
    const makeId = makeIdCounter();
    const { fake, result } = loadSeeded(raw, makeId);
    assert.deepEqual(result, {
      plants: [MONSTERA, FERN],
      available: true,
      unreadable: false,
    });
    assertNotWritten(fake, raw);
    assert.equal(makeId.calls.length, 0);
  });

  test('returns no plants for an empty stored array', () => {
    const { fake, result } = loadSeeded('[]');
    assert.deepEqual(result, {
      plants: [],
      available: true,
      unreadable: false,
    });
    assertNotWritten(fake, '[]');
  });

  test('returns no plants and no notice for a missing key', () => {
    const { fake, result } = loadSeeded(undefined);
    assert.deepEqual(result, {
      plants: [],
      available: true,
      unreadable: false,
    });
    assertNotWritten(fake, null);
  });
});

describe('load: invalid JSON and wrong shapes', () => {
  const UNREADABLE_CASES = [
    { label: 'invalid JSON', raw: '{not json' },
    { label: 'an empty string', raw: '' },
    { label: 'an object', raw: '{}' },
    { label: 'a number', raw: '42' },
    { label: 'null', raw: 'null' },
    { label: 'a string', raw: '"Monstera"' },
  ];
  for (const { label, raw } of UNREADABLE_CASES) {
    test(`reports ${label} as unreadable without writing`, () => {
      const { fake, result } = loadSeeded(raw);
      assert.deepEqual(result, {
        plants: [],
        available: true,
        unreadable: true,
      });
      assertNotWritten(fake, raw);
    });
  }

  test('keeps only the valid entries of a mixed array, in order', () => {
    const raw = seed([
      MONSTERA,
      { name: '' },
      { id: 'p-x', name: 'Bad date', lastWatered: '2025-02-30' },
      42,
      null,
      { id: 'p-y', name: 'No date' },
      FERN,
    ]);
    const makeId = makeIdCounter();
    const { fake, result } = loadSeeded(raw, makeId);
    assert.deepEqual(result, {
      plants: [MONSTERA, FERN],
      available: true,
      unreadable: true,
    });
    assertNotWritten(fake, raw);
    assert.equal(makeId.calls.length, 0);
  });

  const NAMELESS = Object.freeze({ id: 'p-x', lastWatered: '2025-03-01' });
  const UNDATED = Object.freeze({ id: 'p-x', name: 'Ivy' });
  const SKIPPED_ENTRIES = [
    { label: 'a string entry', entry: 'Monstera' },
    { label: 'an array entry', entry: [] },
    { label: 'a boolean entry', entry: true },
    { label: 'a missing name', entry: NAMELESS },
    { label: 'a numeric name', entry: { ...NAMELESS, name: 42 } },
    { label: 'a whitespace-only name', entry: { ...NAMELESS, name: '   ' } },
    { label: 'an 81-character name',
      entry: { ...NAMELESS, name: 'a'.repeat(81) } },
    { label: 'a missing date', entry: UNDATED },
    { label: 'a numeric date', entry: { ...UNDATED, lastWatered: 20250305 } },
    { label: 'a zero-padded year, which is not stored form',
      entry: { ...UNDATED, lastWatered: '02025-01-01' } },
    { label: 'an unpadded month and day',
      entry: { ...UNDATED, lastWatered: '2025-3-5' } },
    { label: 'year 0000', entry: { ...UNDATED, lastWatered: '0000-01-01' } },
    { label: 'month 13', entry: { ...UNDATED, lastWatered: '2025-13-05' } },
    { label: 'a day the month lacks',
      entry: { ...UNDATED, lastWatered: '2025-04-31' } },
  ];
  for (const { label, entry } of SKIPPED_ENTRIES) {
    test(`skips ${label} and reads the entry after it`, () => {
      const raw = seed([entry, MONSTERA]);
      const makeId = makeIdCounter();
      const { fake, result } = loadSeeded(raw, makeId);
      assert.deepEqual(result, {
        plants: [MONSTERA],
        available: true,
        unreadable: true,
      });
      assertNotWritten(fake, raw);
      assert.equal(makeId.calls.length, 0);
    });
  }
});

describe('load: repairable entries', () => {
  test('gives an entry with no id a new one from makeId', () => {
    const makeId = makeIdCounter();
    const { result } = loadSeeded(
        seed([{ name: 'Monstera', lastWatered: '2025-03-03' }]), makeId);
    assert.deepEqual(result, {
      plants: [{ ...MONSTERA, id: 'p-test-1' }],
      available: true,
      unreadable: false,
    });
    assert.equal(makeId.calls.length, 1);
    assert.equal(makeId.calls[0].isSet, true);
    assert.deepEqual(makeId.calls[0].ids, new Set());
  });

  for (const id of [42, '']) {
    test(`replaces the invalid id ${JSON.stringify(id)}`, () => {
      const makeId = makeIdCounter();
      const { result } = loadSeeded(seed([{ ...MONSTERA, id }]), makeId);
      assert.deepEqual(result, {
        plants: [{ ...MONSTERA, id: 'p-test-1' }],
        available: true,
        unreadable: false,
      });
      assert.equal(makeId.calls.length, 1);
    });
  }

  test('keeps the first of two equal ids and replaces the second', () => {
    const makeId = makeIdCounter();
    const { result } = loadSeeded(
        seed([MONSTERA, { ...FERN, id: 'p-a' }]), makeId);
    assert.deepEqual(result, {
      plants: [MONSTERA, { ...FERN, id: 'p-test-1' }],
      available: true,
      unreadable: false,
    });
    assert.equal(makeId.calls.length, 1);
    assert.equal(makeId.calls[0].isSet, true);
    assert.deepEqual(makeId.calls[0].ids, new Set(['p-a']));
  });

  test('reserves ids only for kept entries', () => {
    const makeId = makeIdCounter();
    const { result } = loadSeeded(seed([
      { id: 'p-a', name: '', lastWatered: '2025-03-01' },
      { id: 'p-a', name: 'Fern', lastWatered: '2025-03-05' },
    ]), makeId);
    assert.deepEqual(result, {
      plants: [{ id: 'p-a', name: 'Fern', lastWatered: '2025-03-05' }],
      available: true,
      unreadable: true,
    });
    assert.equal(makeId.calls.length, 0);
  });

  test('drops extra fields without a notice', () => {
    const { result } = loadSeeded(seed([
      { ...MONSTERA, notes: 'Bright, indirect light', photo: 'monstera.jpg' },
    ]));
    assert.deepEqual(result, {
      plants: [MONSTERA],
      available: true,
      unreadable: false,
    });
    assert.deepEqual(
        Object.keys(result.plants[0]).sort(), ['id', 'lastWatered', 'name']);
  });

  test('trims a stored name with surrounding whitespace', () => {
    const { result } = loadSeeded(
        seed([{ ...MONSTERA, name: '  Monstera  ' }]));
    assert.deepEqual(result, {
      plants: [MONSTERA],
      available: true,
      unreadable: false,
    });
  });

  test('keeps a date later than today exactly as stored', () => {
    const future = { ...MONSTERA, lastWatered: '2999-01-01' };
    const { result } = loadSeeded(seed([future]));
    assert.deepEqual(result, {
      plants: [future],
      available: true,
      unreadable: false,
    });
  });

  test('applies all repairs at once, in order, without writing', () => {
    const raw = seed([
      { id: 'p-a', name: '  Monstera  ', lastWatered: '2025-03-03',
        notes: 'x' },
      { name: 'Fern', lastWatered: '2025-03-05' },
      { id: 'p-a', name: 'Cactus', lastWatered: '2999-01-01' },
      { id: 42, name: 'Ivy', lastWatered: '2025-02-28', photo: 'ivy.jpg' },
      { id: '', name: 'Pothos', lastWatered: '2024-02-29' },
      // Equal to an id repaired above, so it is replaced in turn.
      { id: 'p-test-1', name: 'Aloe', lastWatered: '2025-01-01' },
    ]);
    const makeId = makeIdCounter();
    const { fake, result } = loadSeeded(raw, makeId);
    assert.deepEqual(result, {
      plants: [
        { id: 'p-a', name: 'Monstera', lastWatered: '2025-03-03' },
        { id: 'p-test-1', name: 'Fern', lastWatered: '2025-03-05' },
        { id: 'p-test-2', name: 'Cactus', lastWatered: '2999-01-01' },
        { id: 'p-test-3', name: 'Ivy', lastWatered: '2025-02-28' },
        { id: 'p-test-4', name: 'Pothos', lastWatered: '2024-02-29' },
        { id: 'p-test-5', name: 'Aloe', lastWatered: '2025-01-01' },
      ],
      available: true,
      unreadable: false,
    });
    assertNotWritten(fake, raw);
    // Each call sees every id kept before it, repaired ones included.
    assert.deepEqual(makeId.calls.map((call) => [...call.ids]), [
      ['p-a'],
      ['p-a', 'p-test-1'],
      ['p-a', 'p-test-1', 'p-test-2'],
      ['p-a', 'p-test-1', 'p-test-2', 'p-test-3'],
      ['p-a', 'p-test-1', 'p-test-2', 'p-test-3', 'p-test-4'],
    ]);
  });

  test('normalizeStoredPlants alone: only a non-array is unreadable', () => {
    const makeId = makeIdCounter();
    assert.deepEqual(
        model.normalizeStoredPlants({}, makeId),
        { plants: [], unreadable: true });
    assert.deepEqual(
        model.normalizeStoredPlants([], makeId),
        { plants: [], unreadable: false });
    assert.equal(makeId.calls.length, 0);
  });
});

describe('save: success, projection and round trip', () => {
  /**
   * Returns the two stored records with extra in-memory properties, which
   * the write must not carry to storage.
   * @returns {!Array<!Object>} Fresh plant objects.
   */
  function plantsWithExtras() {
    return [{ ...MONSTERA, extra: 1 }, { ...FERN, notes: 'x' }];
  }

  test('writes only id, name and lastWatered under the key, in order', () => {
    const fake = createFakeStorage();
    const plants = plantsWithExtras();
    const store = storeOver(fake, makeIdCounter());
    assert.deepEqual(store.save(plants), { ok: true });
    assert.equal(fake.writes.length, 1);
    assert.equal(fake.writes[0].key, KEY);
    const stored = JSON.parse(fake.getItem(KEY));
    assert.ok(Array.isArray(stored));
    assert.deepEqual(stored, [MONSTERA, FERN]);
    for (const entry of stored) {
      assert.deepEqual(
          Object.keys(entry).sort(), ['id', 'lastWatered', 'name']);
      assert.match(entry.lastWatered, STORED_DATE);
    }
    // The projection is a copy; the in-memory plants keep their extras.
    assert.deepEqual(plants, plantsWithExtras());
  });

  test('round trip: a new store reads the saved list back', () => {
    const fake = createFakeStorage();
    const writer = storeOver(fake, makeIdCounter());
    assert.deepEqual(writer.save(plantsWithExtras()), { ok: true });
    const makeId = makeIdCounter();
    assert.deepEqual(storeOver(fake, makeId).load(), {
      plants: [MONSTERA, FERN],
      available: true,
      unreadable: false,
    });
    assert.equal(makeId.calls.length, 0);
  });

  test('save before load resolves the handle once and reuses it', () => {
    const fake = createFakeStorage();
    const getStorage = countingGetStorage(() => fake);
    const store = storage.createPlantStorage(
        { getStorage, makeId: makeIdCounter() });
    assert.deepEqual(store.save([MONSTERA]), { ok: true });
    assert.deepEqual(store.load(), {
      plants: [MONSTERA],
      available: true,
      unreadable: false,
    });
    assert.deepEqual(store.save([MONSTERA, FERN]), { ok: true });
    assert.equal(getStorage.count, 1);
    assert.equal(fake.getItem(KEY), seed([MONSTERA, FERN]));
  });
});

describe('save: write failure', () => {
  test('reports a quota failure and keeps the stored value', () => {
    const raw = seed([MONSTERA]);
    const fake = createFakeStorage({ initial: raw, failWrites: true });
    const store = storeOver(fake, makeIdCounter());
    assert.deepEqual(store.load(), {
      plants: [MONSTERA],
      available: true,
      unreadable: false,
    });
    const next = [MONSTERA, FERN];
    assert.deepEqual(store.save(next), WRITE_FAILED);
    assert.equal(fake.getItem(KEY), raw);
    assert.deepEqual(fake.writes, [{ key: KEY, value: seed(next) }]);
    // The next save writes the whole list again and fails the same way.
    assert.deepEqual(store.save(next), WRITE_FAILED);
    assert.equal(fake.getItem(KEY), raw);
    assert.equal(fake.writes.length, 2);
  });

  const THROWN = [
    { label: 'a SecurityError',
      error: () => new DOMException('x', 'SecurityError') },
    { label: 'a plain Error', error: () => new Error('boom') },
  ];
  for (const { label, error } of THROWN) {
    test(`reports ${label} from setItem as write-failed`, () => {
      const raw = seed([MONSTERA]);
      const fake = createFakeStorage({ initial: raw });
      fake.setItem = () => {
        throw error();
      };
      const store = storeOver(fake, makeIdCounter());
      assert.deepEqual(store.save([MONSTERA, FERN]), WRITE_FAILED);
      assert.equal(fake.getItem(KEY), raw);
    });
  }
});

describe('storage unavailable', () => {
  const FAILING_GETTERS = [
    { label: 'reading storage throws a SecurityError',
      getStorage: blockedGetStorage },
    { label: 'the storage object is null', getStorage: () => null },
    { label: 'the storage object is undefined', getStorage: () => undefined },
  ];
  for (const { label, getStorage } of FAILING_GETTERS) {
    for (const order of CALL_ORDERS) {
      test(`${label}: ${order.join(' then ')}`, () => {
        const makeId = makeIdCounter();
        assertUnavailable(
            storage.createPlantStorage({ getStorage, makeId }), order);
        assert.equal(makeId.calls.length, 0);
      });
    }
  }

  test('getItem throwing makes storage unavailable for good', () => {
    const fake = createFakeStorage({ initial: seed([MONSTERA]) });
    let reads = 0;
    fake.getItem = () => {
      reads += 1;
      throw new DOMException('Access is denied', 'SecurityError');
    };
    const store = storeOver(fake, makeIdCounter());
    assertUnavailable(store, ['load', 'save', 'load']);
    assert.deepEqual(fake.writes, []);
    assert.equal(reads, 1);
  });

  for (const order of CALL_ORDERS) {
    const steps = order.join(' then ');
    test(`default getter, with no window in Node.js: ${steps}`, () => {
      assert.equal(typeof window, 'undefined');
      const makeId = makeIdCounter();
      assertUnavailable(storage.createPlantStorage({ makeId }), order);
      assert.equal(makeId.calls.length, 0);
    });
  }

  test('a failed resolution is remembered across calls', () => {
    const getStorage = countingGetStorage(blockedGetStorage);
    const store = storage.createPlantStorage(
        { getStorage, makeId: makeIdCounter() });
    assertUnavailable(store, ['save', 'load', 'save', 'load']);
    assert.equal(getStorage.count, 1);
  });
});
