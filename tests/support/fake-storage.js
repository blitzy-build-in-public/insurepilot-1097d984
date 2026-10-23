/**
 * @fileoverview Storage doubles for the unit tests. Tests inject them
 * through createPlantStorage({ getStorage }) and never touch a global
 * localStorage, which Node.js 25 and later define (and Node.js 26 throws on
 * access without --localstorage-file).
 */
'use strict';

// Duplicated from app.js rather than required, so the double stays
// independent of the code under test.
const STORAGE_KEY = 'plant-parent.plants.v1';

/**
 * Creates a Map-backed stand-in for a Storage area.
 * @param {{initial: (string|undefined), failWrites: (boolean|undefined)}=}
 *     options `initial` seeds the plant key, which stays absent while it is
 *     undefined (an empty string is seeded); `failWrites` makes every
 *     setItem throw a QuotaExceededError.
 * @returns {{getItem: function(string): ?string,
 *     setItem: function(string, string): void,
 *     removeItem: function(string): void,
 *     writes: !Array<{key: string, value: string}>}} The fake. Its methods
 *     are own, writable properties, so a test can replace one; `writes`
 *     logs every setItem attempt, failed ones included.
 */
function createFakeStorage({ initial, failWrites = false } = {}) {
  const data = new Map();
  const writes = [];
  if (initial !== undefined) {
    data.set(STORAGE_KEY, String(initial));
  }
  return {
    /**
     * Reads a value.
     * @param {string} key The key.
     * @returns {?string} The stored value, or null when the key is absent.
     */
    getItem(key) {
      const k = String(key);
      return data.has(k) ? data.get(k) : null;
    },

    /**
     * Writes a value, or throws without changing it when writes fail, as
     * the standard checks the quota before assigning.
     * @param {string} key The key.
     * @param {string} value The value, converted to a string.
     * @throws {DOMException} QuotaExceededError when `failWrites` is set.
     */
    setItem(key, value) {
      const k = String(key);
      const v = String(value);
      writes.push({ key: k, value: v });
      if (failWrites) {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      data.set(k, v);
    },

    /**
     * Removes a value; an absent key is ignored.
     * @param {string} key The key.
     */
    removeItem(key) {
      data.delete(String(key));
    },

    writes,
  };
}

/**
 * Models reading window.localStorage while the browser blocks site data.
 * Tests pass the function itself as `getStorage`.
 * @throws {DOMException} Always, a SecurityError.
 */
function blockedGetStorage() {
  throw new DOMException('Access is denied', 'SecurityError');
}

module.exports = { createFakeStorage, blockedGetStorage };
