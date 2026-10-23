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
 * The option names createFakeStorage accepts. Any other key is rejected, so
 * a misspelled option fails the test instead of selecting another state.
 */
const FAKE_STORAGE_OPTIONS = Object.freeze(['initial', 'failWrites']);

/**
 * Creates a Map-backed stand-in for a Storage area.
 * @param {{initial: *, failWrites: (boolean|undefined)}=} options
 *     `initial` seeds the plant key, which stays absent while `initial` is
 *     undefined; any other value, an empty string included, is stored as
 *     String(initial), as Web Storage setItem converts its value to a
 *     string. `failWrites` makes every setItem throw a QuotaExceededError.
 * @returns {{getItem: function(string): ?string,
 *     setItem: function(string, string): void,
 *     removeItem: function(string): void,
 *     writes: !Array<{key: string, value: string}>}} The fake. Its methods
 *     are own, writable properties, so a test can replace one; `writes`
 *     logs every setItem attempt, failed ones included.
 * @throws {TypeError} When `options` is null, an array or not an object,
 *     has any own key, string or symbol, enumerable or not, other than
 *     `initial` and `failWrites`, or holds a `failWrites` that is neither a
 *     boolean nor undefined.
 */
function createFakeStorage(options = {}) {
  if (options === null || typeof options !== 'object' ||
      Array.isArray(options)) {
    throw new TypeError('createFakeStorage: options must be an object');
  }
  // Reflect.ownKeys, unlike Object.keys, also yields non-enumerable and
  // symbol keys; String() names a symbol, which a template cannot convert.
  for (const name of Reflect.ownKeys(options)) {
    if (!FAKE_STORAGE_OPTIONS.includes(name)) {
      throw new TypeError(
          `createFakeStorage: unknown option "${String(name)}"`);
    }
  }
  const { initial, failWrites = false } = options;
  if (typeof failWrites !== 'boolean') {
    throw new TypeError('createFakeStorage: failWrites must be a boolean');
  }
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
