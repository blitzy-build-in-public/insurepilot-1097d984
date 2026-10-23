/**
 * @fileoverview Unit tests for loading app.js in Node.js and for the plant
 * model's message texts, record creation, append order, combined input
 * validation and id generation. Supports success criteria 2 (one added
 * plant) and 3 (insertion order).
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

/** The fixed local "today" every date-dependent call receives. */
const TODAY = '2025-03-06';

const ID_PATTERN = /^p-[0-9a-f]{32}$/;

const MODEL_FUNCTIONS = Object.freeze([
  'validateName',
  'validateDate',
  'validatePlantInput',
  'isCalendarDate',
  'toLocalDateString',
  'formatDate',
  'generateId',
  'createPlant',
  'addPlant',
  'markWatered',
  'normalizeStoredPlants',
]);

const EXPECTED_MESSAGES = Object.freeze({
  nameRequired: 'Enter a plant name',
  nameTooLong: 'Name must be 80 characters or fewer',
  dateRequired: 'Enter a date',
  dateInFuture: 'Date cannot be in the future',
  storageUnavailable:
      'Storage is unavailable, so plants will not be kept after this ' +
      'page is closed.',
  storageUnreadable: 'Some saved data could not be read.',
  saveFailed:
      'Could not save your last change. It will be lost when this page ' +
      'is closed.',
});

/**
 * Returns what the test loader exports. The first call evaluates app.js and
 * later calls come from the require cache. Requiring inside test bodies
 * rather than at the top of the file lets the loading test observe that
 * first evaluation, and a broken loader fails each test with its cause.
 * @returns {{model: !Object, storage: !Object}} The loader's export.
 */
function loadApp() {
  return require('../support/load-app.js');
}

/**
 * Returns n bytes that all hold one value.
 * @param {number} n The number of bytes.
 * @param {number} value The byte value, 0-255.
 * @returns {!Uint8Array} The bytes.
 */
function filledBytes(n, value) {
  return new Uint8Array(n).fill(value);
}

/**
 * A deterministic byte source for generateId: every call returns 0xab
 * bytes.
 * @param {number} n The number of bytes.
 * @returns {!Uint8Array} The bytes.
 */
function fixedBytes(n) {
  return filledBytes(n, 0xab);
}

/**
 * Creates a deterministic byte source for generateId that logs each call.
 * @param {function(number, number): !Uint8Array} makeBytes Builds a call's
 *     bytes from its size `n` and its zero-based call index.
 * @returns {{getRandomBytes: function(number): !Uint8Array,
 *     sizes: !Array<number>}} The source, and the `n` of every call so far
 *     in order, so `sizes.length` is the call count.
 */
function createByteSource(makeBytes) {
  const sizes = [];
  return {
    /**
     * Logs `n` in `sizes`, then returns `makeBytes(n, index)`, where index
     * is this call's zero-based position.
     * @param {number} n The number of bytes.
     * @returns {!Uint8Array} The bytes `makeBytes` builds for this call.
     */
    getRandomBytes(n) {
      sizes.push(n);
      return makeBytes(n, sizes.length - 1);
    },
    sizes,
  };
}

describe('loading app.js in Node.js', () => {
  test('evaluates app.js without throwing or adding globals', () => {
    const globalsBefore = new Set(Object.getOwnPropertyNames(globalThis));
    assert.doesNotThrow(() => loadApp());
    const added = Object.getOwnPropertyNames(globalThis)
        .filter((name) => !globalsBefore.has(name));
    assert.deepEqual(added, []);
    assert.equal(globalThis.PlantModel, undefined);
    assert.equal(globalThis.PlantStorage, undefined);
  });

  test('exports exactly model and storage', () => {
    assert.deepEqual(Object.keys(loadApp()).sort(), ['model', 'storage']);
  });

  test('defines no DOM', () => {
    loadApp();
    assert.equal(typeof document, 'undefined');
    assert.equal(typeof window, 'undefined');
  });

  test('the model exposes every function and NAME_MAX_LENGTH', () => {
    const { model } = loadApp();
    for (const name of MODEL_FUNCTIONS) {
      assert.equal(typeof model[name], 'function', name);
    }
    assert.equal(model.NAME_MAX_LENGTH, 80);
  });

  test('storage exposes STORAGE_KEY and createPlantStorage', () => {
    const { storage } = loadApp();
    assert.equal(storage.STORAGE_KEY, 'plant-parent.plants.v1');
    assert.equal(typeof storage.createPlantStorage, 'function');
  });
});

describe('MESSAGES', () => {
  test('is frozen', () => {
    assert.equal(Object.isFrozen(loadApp().model.MESSAGES), true);
  });

  test('has exactly the seven message keys', () => {
    assert.deepEqual(
        Object.keys(loadApp().model.MESSAGES).sort(),
        Object.keys(EXPECTED_MESSAGES).sort());
  });

  for (const [key, text] of Object.entries(EXPECTED_MESSAGES)) {
    test(`${key} reads "${text}"`, () => {
      assert.equal(loadApp().model.MESSAGES[key], text);
    });
  }
});

describe('createPlant', () => {
  test('returns a new record with exactly id, name and lastWatered', () => {
    const { model } = loadApp();
    const value = Object.freeze({ name: 'Monstera', lastWatered: TODAY });
    const plant = model.createPlant(value, 'p-1');
    assert.deepEqual(
        plant, { id: 'p-1', name: 'Monstera', lastWatered: TODAY });
    assert.deepEqual(
        Object.getOwnPropertyNames(plant).sort(),
        ['id', 'lastWatered', 'name']);
    assert.notEqual(plant, value);
  });

  test('drops any property beyond name and lastWatered', () => {
    const { model } = loadApp();
    const value = { name: 'Fern', lastWatered: '2025-03-05', notes: 'x' };
    const plant = model.createPlant(value, 'p-2');
    assert.deepEqual(
        Object.getOwnPropertyNames(plant).sort(),
        ['id', 'lastWatered', 'name']);
    assert.deepEqual(
        plant, { id: 'p-2', name: 'Fern', lastWatered: '2025-03-05' });
  });
});

describe('addPlant', () => {
  test('appends in insertion order without changing earlier lists', () => {
    const { model } = loadApp();
    const additions = [
      model.createPlant({ name: 'Monstera', lastWatered: TODAY }, 'p-a'),
      model.createPlant({ name: 'Fern', lastWatered: '2025-03-05' }, 'p-b'),
      model.createPlant({ name: 'Cactus', lastWatered: '2025-02-28' }, 'p-c'),
    ];
    // Frozen lists make any in-place change throw under app.js's strict mode.
    let list = Object.freeze([]);
    for (const plant of additions) {
      const previous = list;
      const previousLength = previous.length;
      list = Object.freeze(model.addPlant(previous, plant));
      assert.notEqual(list, previous);
      assert.equal(previous.length, previousLength);
      assert.equal(list.length, previousLength + 1);
      previous.forEach((kept, i) => assert.equal(list[i], kept));
      assert.equal(list[list.length - 1], plant);
    }
    assert.deepEqual(
        list.map((plant) => plant.name), ['Monstera', 'Fern', 'Cactus']);
  });
});

describe('criterion 2: adding Monstera with today\'s date', () => {
  test('yields one plant named Monstera shown as Mar 6, 2025', () => {
    const { model } = loadApp();
    const input = model.validatePlantInput(
        { name: 'Monstera', lastWatered: TODAY }, TODAY);
    assert.equal(input.ok, true);
    const plant = model.createPlant(
        input.value, model.generateId(new Set(), fixedBytes));
    const plants = model.addPlant([], plant);
    assert.equal(plants.length, 1);
    assert.equal(plants[0].name, 'Monstera');
    assert.equal(plants[0].lastWatered, '2025-03-06');
    assert.match(plants[0].id, ID_PATTERN);
    assert.equal(model.formatDate(plants[0].lastWatered), 'Mar 6, 2025');
  });
});

describe('validatePlantInput', () => {
  test('reports both errors together', () => {
    const { model } = loadApp();
    assert.deepEqual(
        model.validatePlantInput({ name: '', lastWatered: '' }, TODAY),
        {
          ok: false,
          errors: { name: 'Enter a plant name', lastWatered: 'Enter a date' },
        });
  });

  // The contract marks each error key optional, so an absent error is
  // checked as undefined rather than by comparing the whole object.
  test('reports only the date error for a future date', () => {
    const { model } = loadApp();
    const result = model.validatePlantInput(
        { name: 'Monstera', lastWatered: '2025-03-07' }, TODAY);
    assert.equal(result.ok, false);
    assert.equal(result.errors.lastWatered, 'Date cannot be in the future');
    assert.equal(result.errors.name, undefined);
  });

  test('reports only the name error for an 81-character name', () => {
    const { model } = loadApp();
    const result = model.validatePlantInput(
        { name: 'a'.repeat(81), lastWatered: '2025-03-05' }, TODAY);
    assert.equal(result.ok, false);
    assert.equal(result.errors.name, 'Name must be 80 characters or fewer');
    assert.equal(result.errors.lastWatered, undefined);
  });

  test('returns the trimmed name and the canonical date', () => {
    const { model } = loadApp();
    assert.deepEqual(
        model.validatePlantInput(
            { name: '  Fern  ', lastWatered: '02025-03-05' }, TODAY),
        { ok: true, value: { name: 'Fern', lastWatered: '2025-03-05' } });
  });

  for (const fields of [
    { name: '  Ivy ', lastWatered: '2025-03-01' },
    { name: ' ', lastWatered: '2025-03-07' },
  ]) {
    test(`does not mutate a frozen input ${JSON.stringify(fields)}`, () => {
      const { model } = loadApp();
      const input = Object.freeze({ ...fields });
      assert.doesNotThrow(() => model.validatePlantInput(input, TODAY));
      assert.deepEqual(input, fields);
    });
  }
});

describe('generateId', () => {
  for (const { label, makeBytes, expected } of [
    {
      label: 'zero-pads each byte to two hex digits',
      /**
       * Returns the bytes 0, 1, 2, ... in order.
       * @param {number} n The number of bytes.
       * @returns {!Uint8Array} The bytes.
       */
      makeBytes: (n) => Uint8Array.from({ length: n }, (_, i) => i),
      expected: 'p-000102030405060708090a0b0c0d0e0f',
    },
    {
      label: 'writes lowercase hex',
      /**
       * Returns n bytes that all hold 0xff.
       * @param {number} n The number of bytes.
       * @returns {!Uint8Array} The bytes.
       */
      makeBytes: (n) => filledBytes(n, 0xff),
      expected: `p-${'ff'.repeat(16)}`,
    },
  ]) {
    test(`draws 16 bytes and ${label}`, () => {
      const { model } = loadApp();
      const source = createByteSource(makeBytes);
      const id = model.generateId(new Set(), source.getRandomBytes);
      assert.equal(id, expected);
      assert.match(id, ID_PATTERN);
      assert.deepEqual(source.sizes, [16]);
    });
  }

  test('draws again while the id is in use, leaving the set as it was', () => {
    const { model } = loadApp();
    const taken = `p-${'00'.repeat(16)}`;
    const existing = new Set([taken]);
    const source = createByteSource(
        (n, call) => filledBytes(n, call === 0 ? 0x00 : 0x01));
    const id = model.generateId(existing, source.getRandomBytes);
    assert.equal(id, `p-${'01'.repeat(16)}`);
    assert.deepEqual(source.sizes, [16, 16]);
    assert.equal(existing.size, 1);
    assert.equal(existing.has(taken), true);
  });

  // A fresh, empty set on every call means distinctness comes from the
  // randomness, not from the redraw loop.
  test('gives 1,000 distinct ids from crypto.getRandomValues', () => {
    const { model } = loadApp();
    const ids = Array.from(
        { length: 1000 },
        () => model.generateId(
            new Set(), (n) => crypto.getRandomValues(new Uint8Array(n))));
    for (const id of ids) {
      assert.match(id, ID_PATTERN);
    }
    assert.equal(new Set(ids).size, 1000);
  });
});
