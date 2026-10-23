/**
 * @fileoverview Unit tests for PlantModel.markWatered, the model half of the
 * Water now button: the pressed plant's date becomes today, no plant moves,
 * every other plant stays the same object, and the input list never changes.
 *
 * Every input is deep-frozen. app.js runs in strict mode, so any write to an
 * input inside markWatered throws a TypeError and fails the test.
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { model } = require('../support/load-app.js');

/** Today's local date for every call; these tests never read the clock. */
const TODAY = '2025-03-06';

/**
 * Freezes a value and every object it holds, at any depth.
 * @param {*} value Any value; primitives are returned as they are.
 * @returns {*} the same value, frozen recursively.
 */
function deepFreeze(value) {
  if (typeof value === 'object' && value !== null) {
    for (const member of Object.values(value)) {
      deepFreeze(member);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Three plants with distinct past dates, in insertion order A, B, C.
 * @returns {!Array<{id: string, name: string, lastWatered: string}>} A new,
 *     unfrozen list of new objects, so no two tests share state.
 */
function threePlants() {
  return [
    { id: 'p-a', name: 'Monstera', lastWatered: '2025-03-01' },
    { id: 'p-b', name: 'Fern', lastWatered: '2025-03-02' },
    { id: 'p-c', name: 'Cactus', lastWatered: '2025-02-28' },
  ];
}

/**
 * Two plants with the same name and date, told apart only by their ids.
 * @returns {!Array<{id: string, name: string, lastWatered: string}>} A new,
 *     unfrozen list of new objects, so no two tests share state.
 */
function twoFerns() {
  return [
    { id: 'p-1', name: 'Fern', lastWatered: '2025-03-05' },
    { id: 'p-2', name: 'Fern', lastWatered: '2025-03-05' },
  ];
}

/**
 * Lists one field of every plant, in list order.
 * @param {!Array<!Object>} plants A plant list.
 * @param {string} field The field to read: 'id', 'name' or 'lastWatered'.
 * @returns {!Array<string>} The field's values in list order.
 */
function pluck(plants, field) {
  return plants.map((plant) => plant[field]);
}

describe('markWatered', () => {
  test('sets the middle of three plants to today and moves none', () => {
    const plants = threePlants();
    const snapshot = structuredClone(plants);
    deepFreeze(plants);

    let next;
    assert.doesNotThrow(() => {
      next = model.markWatered(plants, 'p-b', TODAY);
    });

    assert.ok(Array.isArray(next));
    assert.notStrictEqual(next, plants);
    assert.strictEqual(next.length, 3);
    assert.deepStrictEqual(pluck(next, 'id'), ['p-a', 'p-b', 'p-c']);
    assert.deepStrictEqual(
        next[1], { id: 'p-b', name: 'Fern', lastWatered: '2025-03-06' });
    assert.notStrictEqual(next[1], plants[1]);
    assert.strictEqual(next[0], plants[0]);
    assert.strictEqual(next[2], plants[2]);

    assert.deepStrictEqual(plants, snapshot);
    assert.strictEqual(plants[1].lastWatered, '2025-03-02');
  });

  test('keeps today on a plant already watered today', () => {
    const plants = deepFreeze(
        [{ id: 'p-a', name: 'Monstera', lastWatered: '2025-03-06' }]);

    const next = model.markWatered(plants, 'p-a', TODAY);

    assert.notStrictEqual(next, plants);
    assert.strictEqual(next.length, 1);
    assert.deepStrictEqual(
        next[0], { id: 'p-a', name: 'Monstera', lastWatered: '2025-03-06' });
  });

  test('returns an equal copy of the same objects for an unknown id', () => {
    const plants = deepFreeze(threePlants());

    const next = model.markWatered(plants, 'p-zzz', TODAY);

    assert.notStrictEqual(next, plants);
    assert.deepStrictEqual(next, plants);
    plants.forEach((plant, index) => {
      assert.strictEqual(next[index], plant, `element ${index}`);
    });
  });

  test('returns a new empty array for an empty list', () => {
    const plants = deepFreeze([]);

    const next = model.markWatered(plants, 'p-a', TODAY);

    assert.notStrictEqual(next, plants);
    assert.deepStrictEqual(next, []);
  });

  describe('with two plants named "Fern"', () => {
    for (const [target, changedIndex] of [['p-1', 0], ['p-2', 1]]) {
      test(`changes only the plant with id ${target}`, () => {
        const plants = deepFreeze(twoFerns());

        const next = model.markWatered(plants, target, TODAY);

        assert.deepStrictEqual(pluck(next, 'id'), ['p-1', 'p-2']);
        plants.forEach((plant, index) => {
          if (index === changedIndex) {
            assert.deepStrictEqual(
                next[index], { id: target, name: 'Fern', lastWatered: TODAY });
            assert.strictEqual(plant.lastWatered, '2025-03-05');
          } else {
            assert.strictEqual(next[index], plant, `element ${index}`);
          }
        });
      });
    }
  });

  test('keeps the list order through presses on B, then C, then A', () => {
    let plants = deepFreeze(threePlants());

    for (const id of ['p-b', 'p-c', 'p-a']) {
      const next = model.markWatered(plants, id, TODAY);
      assert.deepStrictEqual(
          pluck(next, 'id'), ['p-a', 'p-b', 'p-c'], `after pressing ${id}`);
      assert.deepStrictEqual(
          pluck(next, 'name'), ['Monstera', 'Fern', 'Cactus'],
          `after pressing ${id}`);
      plants = deepFreeze(next);
    }

    assert.deepStrictEqual(
        pluck(plants, 'lastWatered'), [TODAY, TODAY, TODAY]);
  });
});
