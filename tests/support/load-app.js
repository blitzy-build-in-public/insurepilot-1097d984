/**
 * @fileoverview Loads app.js into Node.js for the unit tests, with no DOM.
 * app.js is a classic browser script. Its entry guard exports
 * { model, storage } when a CommonJS-style `module` object is in scope and
 * otherwise starts the app, so this loader supplies that object itself.
 *
 * app.js is never passed to require(): Node would then treat it according to
 * its CommonJS/ESM detection and any ancestor package.json "type" field, and
 * the loader could not control the `module` binding the entry guard tests.
 *
 * Usage, from a test file in tests/unit/:
 *   const { model, storage } = require('../support/load-app.js');
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Absolute path of app.js, whatever the working directory of the run. */
const APP_PATH = path.resolve(__dirname, '..', '..', 'app.js');

/**
 * Tells whether a value is a non-null object.
 * @param {*} value Any value.
 * @returns {boolean} True for an object other than null.
 */
function isObject(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * Evaluates app.js inside a `(module, exports)` wrapper and returns what its
 * entry guard exported.
 *
 * Compiling in the current context keeps the results in the caller's realm,
 * so assert.deepStrictEqual can compare the model's arrays and objects with
 * literals; a separate vm context would give them foreign prototypes. No
 * window, document or other global is defined, so only the entry guard's
 * export branch can run and `typeof document` stays 'undefined'.
 * @returns {{model: !Object, storage: !Object}} The object app.js assigned
 *     to module.exports, unchanged: `model` is PlantModel (name and date
 *     validation, date strings, ids and plant-list functions) and `storage`
 *     is PlantStorage (STORAGE_KEY and createPlantStorage).
 * @throws {Error} When app.js does not export object-valued `model` and
 *     `storage`, so a broken entry guard fails once, with its cause, rather
 *     than as undefined-property errors in every test.
 */
function loadApp() {
  const source = fs.readFileSync(APP_PATH, 'utf8');
  // vm.compileFunction, not vm.runInThisContext on a
  // '(function (module, exports) {' + source + '})' string: Node's coverage
  // maps V8's character offsets onto app.js as read from disk, so the
  // prefix's 29 characters would shift every range, misnumber uncovered
  // lines and hide some of them from the coverage gate. Compiling the source
  // unchanged as the body of a (module, exports) function in this context
  // keeps offsets, stack-trace positions and coverage lines exact, and the
  // real file name lets --test-coverage-include="app.js" match it.
  const wrapper = vm.compileFunction(source, ['module', 'exports'], {
    filename: APP_PATH,
  });
  const mod = { exports: {} };
  wrapper.call(undefined, mod, mod.exports);
  const exported = mod.exports;
  if (!isObject(exported) || !isObject(exported.model) ||
      !isObject(exported.storage)) {
    throw new Error(
        `${APP_PATH}: the entry guard did not export { model, storage }`);
  }
  return exported;
}

// The require cache evaluates app.js once per process; node --test gives
// each test file its own process, so every file gets a fresh evaluation.
module.exports = loadApp();
