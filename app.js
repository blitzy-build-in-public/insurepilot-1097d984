/**
 * @fileoverview Plant Parent: log houseplants and the date each was last
 * watered. index.html loads this file as a classic deferred script, so it
 * runs from file:// as well as from a static server, with no build step and
 * no dependencies. The whole file is one IIFE and adds no globals.
 *
 * Blocks, in dependency order, with the only calls each may make:
 *   1. Plant model functions: pure rules for names, dates, ids and the
 *      plant list. Calls ECMAScript built-ins only and reads no clock,
 *      random source, DOM or storage.
 *   2. Storage module: the only code that touches localStorage. Calls the
 *      model.
 *   3. Rendering: builds the DOM from state. Calls the model, never
 *      storage.
 *   4. Event wiring: owns the state, the DOM references, the listeners,
 *      the clock and the random source. Calls the model, storage and
 *      rendering.
 *   5. Entry: exports { model, storage } when a CommonJS module object is
 *      in scope (the Node.js tests); otherwise starts the app.
 *
 * Commands, from the repository root:
 *   node --check app.js
 *   node --test "tests/unit/*.test.js"
 *   node --test --experimental-test-coverage \
 *     --test-coverage-include="app.js" "tests/unit/*.test.js"
 *   npm ci --prefix tests
 *   npx --prefix tests playwright install chromium
 *   node --test --test-concurrency=1 "tests/browser/*.test.js"
 */
(function () {
  'use strict';

  // ===== 1. Plant model functions =====

  /**
   * A saved plant. Records carry exactly these three fields.
   * @typedef {{id: string, name: string, lastWatered: string}} Plant
   */

  /** Longest allowed plant name, in Unicode code points. */
  const NAME_MAX_LENGTH = 80;

  const MESSAGES = Object.freeze({
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

  /** A canonical calendar date: exactly four year digits. */
  const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

  /**
   * A valid HTML date string as a date input reports it: four or more year
   * digits, so a year may carry leading zeros (02025 is the year 2025).
   */
  const INPUT_DATE_PATTERN = /^(\d{4,})-(\d{2})-(\d{2})$/;

  /** Days in each month of a common year, January first. */
  const MONTH_LENGTHS = Object.freeze(
      [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

  /**
   * Formats display dates. Pinned to en-US to match the page's English text
   * and to UTC so the formatted day never depends on the user's time zone.
   */
  const DISPLAY_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

  /**
   * Validates a typed plant name.
   * @param {string} raw The name as typed; a non-string counts as ''.
   * @returns {{ok: true, value: string}|{ok: false, message: string}}
   *     `value` is the trimmed name; `message` is one of MESSAGES.
   */
  function validateName(raw) {
    const value = (typeof raw === 'string' ? raw : '').trim();
    if (value === '') {
      return { ok: false, message: MESSAGES.nameRequired };
    }
    // Array.from splits by code point, so a supplementary-plane code point
    // (beyond U+FFFF) counts once rather than as its two UTF-16 code units.
    if (Array.from(value).length > NAME_MAX_LENGTH) {
      return { ok: false, message: MESSAGES.nameTooLong };
    }
    return { ok: true, value };
  }

  /**
   * Tells whether a value is a canonical `YYYY-MM-DD` calendar date: year
   * 0001-9999, month 01-12 and a day that exists in that month, with
   * Gregorian leap years. Never uses Date's string parser.
   * @param {*} value Any value.
   * @returns {boolean} True only for an existing canonical calendar date.
   */
  function isCalendarDate(value) {
    const match =
        typeof value === 'string' ? CALENDAR_DATE_PATTERN.exec(value) : null;
    if (match === null) {
      return false;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12) {
      return false;
    }
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthLength = month === 2 && leap ? 29 : MONTH_LENGTHS[month - 1];
    return day >= 1 && day <= monthLength;
  }

  /**
   * Validates a date input's value against today. A date input's `max` only
   * limits its picker, so a typed, pasted or stepped future date still
   * arrives here and is refused.
   * @param {string} raw The input's value: '' or a valid HTML date string.
   * @param {string} today Today's local date, canonical `YYYY-MM-DD`.
   * @returns {{ok: true, value: string}|{ok: false, message: string}}
   *     `value` is the canonical four-digit `YYYY-MM-DD`; `message` is
   *     MESSAGES.dateRequired or MESSAGES.dateInFuture.
   */
  function validateDate(raw, today) {
    const match =
        typeof raw === 'string' ? INPUT_DATE_PATTERN.exec(raw) : null;
    if (match === null) {
      return { ok: false, message: MESSAGES.dateRequired };
    }
    // Read numerically, so leading zeros do not count toward the year.
    const year = Number(match[1]);
    if (year > 9999) {
      return { ok: false, message: MESSAGES.dateInFuture };
    }
    const value = `${String(year).padStart(4, '0')}-${match[2]}-${match[3]}`;
    if (!isCalendarDate(value)) {
      return { ok: false, message: MESSAGES.dateRequired };
    }
    // Canonical strings are fixed-width, so string order is date order.
    if (value > today) {
      return { ok: false, message: MESSAGES.dateInFuture };
    }
    return { ok: true, value };
  }

  /**
   * Validates the add-plant form's two fields independently, so both
   * messages can be reported together.
   * @param {{name: string, lastWatered: string}} input The raw field values.
   * @param {string} today Today's local date, canonical `YYYY-MM-DD`.
   * @returns {{ok: true, value: {name: string, lastWatered: string}}|
   *     {ok: false, errors: {name: (string|undefined),
   *     lastWatered: (string|undefined)}}} `errors` holds a message only
   *     for each failing field.
   */
  function validatePlantInput(input, today) {
    const name = validateName(input.name);
    const lastWatered = validateDate(input.lastWatered, today);
    if (name.ok && lastWatered.ok) {
      return {
        ok: true,
        value: { name: name.value, lastWatered: lastWatered.value },
      };
    }
    const errors = {};
    if (!name.ok) {
      errors.name = name.message;
    }
    if (!lastWatered.ok) {
      errors.lastWatered = lastWatered.message;
    }
    return { ok: false, errors };
  }

  /**
   * Returns the local calendar date of an instant. Local getters, never
   * toISOString(), which is UTC and can be a day off.
   * @param {!Date} date The instant.
   * @returns {string} Its local date as `YYYY-MM-DD`.
   */
  function toLocalDateString(date) {
    const year = String(date.getFullYear()).padStart(4, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Formats a calendar date for display, for example 'Mar 3, 2025'.
   * @param {string} ymd A canonical `YYYY-MM-DD` date.
   * @returns {string} The display text, or `ymd` unchanged when it is not a
   *     calendar date, so rendering never fails.
   */
  function formatDate(ymd) {
    if (!isCalendarDate(ymd)) {
      return ymd;
    }
    const [year, month, day] = ymd.split('-').map(Number);
    // Built at UTC midnight and formatted in UTC, so neither DST nor the
    // zone offset can shift the day. setUTCFullYear also avoids the 0-99 to
    // 1900-1999 year remapping of new Date(y, m, d) and Date.UTC.
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return DISPLAY_DATE_FORMAT.format(date);
  }

  /**
   * Generates a plant id unique within the current list.
   * The byte source is injected: the wiring passes crypto.getRandomValues,
   * because crypto.randomUUID exists only in secure contexts and would fail
   * on a page served over plain HTTP from a LAN address.
   * @param {!Set<string>} existingIds Ids already in use.
   * @param {function(number): !Uint8Array} getRandomBytes Returns n random
   *     bytes.
   * @returns {string} 'p-' followed by 32 lowercase hex digits, not in
   *     `existingIds`.
   */
  function generateId(existingIds, getRandomBytes) {
    let id;
    do {
      const hex = Array.from(
          getRandomBytes(16), (byte) => byte.toString(16).padStart(2, '0'));
      id = `p-${hex.join('')}`;
    } while (existingIds.has(id));
    return id;
  }

  /**
   * Creates a plant record from validated input.
   * @param {{name: string, lastWatered: string}} value Validated fields.
   * @param {string} id The new plant's id.
   * @returns {!Plant} A new record with exactly `id`, `name` and
   *     `lastWatered`.
   */
  function createPlant(value, id) {
    return { id, name: value.name, lastWatered: value.lastWatered };
  }

  /**
   * Appends a plant to the end of the list.
   * @param {!Array<!Plant>} plants The current list.
   * @param {!Plant} plant The plant to add.
   * @returns {!Array<!Plant>} A new list; the input is not changed.
   */
  function addPlant(plants, plant) {
    return [...plants, plant];
  }

  /**
   * Records a watering. No plant moves, and every other element is the same
   * object, so the list keeps its order and length.
   * @param {!Array<!Plant>} plants The current list; never mutated.
   * @param {string} id The watered plant's id.
   * @param {string} today Today's local date, canonical `YYYY-MM-DD`.
   * @returns {!Array<!Plant>} A new list in which the matching plant has
   *     `lastWatered` set to `today`; an equal copy when no id matches.
   */
  function markWatered(plants, id, today) {
    return plants.map(
        (plant) => plant.id === id ? { ...plant, lastWatered: today } : plant);
  }

  /**
   * Validates a parsed stored value entry by entry. Stored text is
   * untrusted, so only entries with a valid name and date are kept. A date
   * later than today is kept: a clock or time-zone change can produce one,
   * and the no-future rule governs input only.
   * @param {*} value The parsed JSON value.
   * @param {function(!Set<string>): string} makeId Returns an id not in the
   *     given set; used for a missing, invalid or duplicate stored id.
   * @returns {{plants: !Array<!Plant>, unreadable: boolean}} The kept
   *     entries in stored order, trimmed and reduced to `id`, `name` and
   *     `lastWatered`; `unreadable` is true when the value is not an array
   *     or any entry was skipped.
   */
  function normalizeStoredPlants(value, makeId) {
    if (!Array.isArray(value)) {
      return { plants: [], unreadable: true };
    }
    const plants = [];
    const usedIds = new Set();
    let unreadable = false;
    for (const entry of value) {
      // A non-record entry reads as {}, so its name check fails below.
      const fields = (typeof entry === 'object' && entry !== null &&
          !Array.isArray(entry)) ? entry : {};
      const name = validateName(fields.name);
      if (!name.ok || !isCalendarDate(fields.lastWatered)) {
        unreadable = true;
        continue;
      }
      // A repaired id is not reported: the entry itself was read.
      const storedId = fields.id;
      const id = (typeof storedId === 'string' && storedId !== '' &&
          !usedIds.has(storedId)) ? storedId : makeId(usedIds);
      usedIds.add(id);
      plants.push({ id, name: name.value, lastWatered: fields.lastWatered });
    }
    return { plants, unreadable };
  }

  const PlantModel = Object.freeze({
    NAME_MAX_LENGTH,
    MESSAGES,
    validateName,
    validateDate,
    validatePlantInput,
    isCalendarDate,
    toLocalDateString,
    formatDate,
    generateId,
    createPlant,
    addPlant,
    markWatered,
    normalizeStoredPlants,
  });

  // ===== 2. Storage module =====

  /** The one storage key. The .v1 suffix leaves room for a migration. */
  const STORAGE_KEY = 'plant-parent.plants.v1';

  /**
   * Returns the page's localStorage area, the only reference to it in the
   * codebase. Reading the property itself throws a SecurityError when the
   * browser blocks storage, and Firefox with dom.storage.enabled set to
   * false returns null. With no window, as in Node.js, it throws a
   * ReferenceError. Callers treat each of these as unavailable.
   * @returns {?Storage} The storage area.
   */
  function defaultGetStorage() {
    return window.localStorage;
  }

  /**
   * Creates the plant store. Every failure becomes a result value, so
   * neither method throws. Detection never inspects an error's name or
   * message, which differ between engines.
   * @param {{getStorage: (function(): ?Storage|undefined),
   *     makeId: function(!Set<string>): string}=} options `getStorage`
   *     returns the storage object and defaults to the page's
   *     localStorage; `makeId` repairs stored ids and is required.
   * @returns {{load: function(): {plants: !Array<!Plant>,
   *     available: boolean, unreadable: boolean},
   *     save: function(!Array<!Plant>): ({ok: true}|{ok: false,
   *     reason: string})}} The store.
   */
  function createPlantStorage({ getStorage = defaultGetStorage, makeId } = {}) {
    // undefined until the first load or save resolves it; then the storage
    // object, or null once storage is known to be unavailable. The outcome
    // holds for the page's lifetime.
    let handle;

    /**
     * Resolves the storage handle on first use.
     * @returns {?Storage} The storage object, or null when unavailable.
     */
    function resolveHandle() {
      if (handle === undefined) {
        try {
          handle = getStorage() ?? null;
        } catch {
          handle = null;
        }
      }
      return handle;
    }

    /**
     * Reads the plant list. Never writes: rewriting on load could destroy
     * entries a later version could still read, so the first user change
     * performs the write-back.
     * @returns {{plants: !Array<!Plant>, available: boolean,
     *     unreadable: boolean}} `available` is false when storage cannot be
     *     reached; `unreadable` is true when the stored value is not valid
     *     JSON, not an array, or held an entry that was skipped.
     */
    function load() {
      let raw;
      try {
        // An unavailable handle yields undefined here. A getItem that
        // throws makes storage unavailable for the rest of the page.
        raw = resolveHandle()?.getItem(STORAGE_KEY);
      } catch {
        handle = null;
      }
      if (handle === null) {
        return { plants: [], available: false, unreadable: false };
      }
      if (raw === null) {
        return { plants: [], available: true, unreadable: false };
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { plants: [], available: true, unreadable: true };
      }
      const result = PlantModel.normalizeStoredPlants(parsed, makeId);
      return {
        plants: result.plants,
        available: true,
        unreadable: result.unreadable,
      };
    }

    /**
     * Writes the whole plant list. The explicit projection means no field
     * other than `id`, `name` and `lastWatered` can reach storage. A failed
     * setItem leaves the previous value in place, so nothing is rolled
     * back.
     * @param {!Array<!Plant>} plants The full in-memory list.
     * @returns {{ok: true}|{ok: false, reason: string}} `reason` is
     *     'unavailable' when storage cannot be reached, in which case it is
     *     not called, or 'write-failed' when the write throws (for example
     *     QuotaExceededError).
     */
    function save(plants) {
      const storage = resolveHandle();
      if (storage === null) {
        return { ok: false, reason: 'unavailable' };
      }
      const records = plants.map((plant) => ({
        id: plant.id,
        name: plant.name,
        lastWatered: plant.lastWatered,
      }));
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(records));
      } catch {
        return { ok: false, reason: 'write-failed' };
      }
      return { ok: true };
    }

    return { load, save };
  }

  const PlantStorage = Object.freeze({ STORAGE_KEY, createPlantStorage });

  // ===== 3. Rendering =====

  const WATER_LABEL = 'Water now';
  const WATER_NAME_PREFIX = 'Water now: ';
  const DATE_PREFIX = 'Last watered ';
  const DATE_ID_PREFIX = 'plant-date-';

  /**
   * Creates an element with a class and optional text. Text is set as
   * textContent, so typed and stored values never become markup.
   * @param {!Document} doc The owning document.
   * @param {string} tagName The element's tag.
   * @param {string} className The element's class attribute.
   * @param {string=} text The element's text, if any.
   * @returns {!HTMLElement} The new element.
   */
  function createElement(doc, tagName, className, text) {
    const element = doc.createElement(tagName);
    element.className = className;
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  /**
   * Renders the whole page state: the plant list, then the notices.
   * @param {!Object} view The DOM references built by startApp.
   * @param {{plants: !Array<!Plant>, storageAvailable: boolean,
   *     unreadable: boolean, saveFailed: boolean}} state The app state.
   * @returns {!Map<string, !HTMLButtonElement>} Each plant's new Water now
   *     button by plant id, for focus restoration.
   */
  function renderApp(view, state) {
    const buttons = renderPlantList(view, state.plants);
    renderNotices(view, noticesFor(state));
    return buttons;
  }

  /**
   * Rebuilds every row in one fragment and swaps it in, then shows either
   * the list or the empty state.
   * @param {!Object} view The DOM references built by startApp.
   * @param {!Array<!Plant>} plants The validated in-memory list.
   * @returns {!Map<string, !HTMLButtonElement>} Each plant's new Water now
   *     button by plant id.
   */
  function renderPlantList(view, plants) {
    const doc = view.list.ownerDocument;
    const fragment = doc.createDocumentFragment();
    const buttons = new Map();
    for (const [index, plant] of plants.entries()) {
      const time = doc.createElement('time');
      time.setAttribute('datetime', plant.lastWatered);
      time.textContent = PlantModel.formatDate(plant.lastWatered);
      const date = createElement(doc, 'span', 'plant__date');
      date.append(doc.createTextNode(DATE_PREFIX), time);
      // The date line describes the row's button, so a screen reader reads
      // the new date when focus returns to that button after Water now. The
      // id comes from the row index, never plant.id: a stored id is kept as
      // found and may hold spaces, which would split the IDREF list.
      date.id = DATE_ID_PREFIX + index;

      const text = createElement(doc, 'div', 'plant__text');
      text.append(createElement(doc, 'span', 'plant__name', plant.name), date);

      const button = createElement(doc, 'button', 'plant__water', WATER_LABEL);
      button.type = 'button';
      button.setAttribute('data-plant-id', plant.id);
      // aria-label rather than visually hidden text: a hidden span gave
      // "Water now : Monstera", with a stray space, in Chromium and Firefox.
      // This name is exact and begins with the visible label (WCAG 2.5.3).
      button.setAttribute('aria-label', WATER_NAME_PREFIX + plant.name);
      button.setAttribute('aria-describedby', date.id);

      const row = createElement(doc, 'li', 'plant');
      row.append(text, button);
      fragment.append(row);
      buttons.set(plant.id, button);
    }
    view.list.replaceChildren(fragment);
    view.list.hidden = plants.length === 0;
    view.emptyState.hidden = plants.length > 0;
    return buttons;
  }

  /**
   * Lists the notices the state calls for, in their fixed display order.
   * @param {{storageAvailable: boolean, unreadable: boolean,
   *     saveFailed: boolean}} state The app state.
   * @returns {!Array<{key: string, text: string, tone: string}>} The active
   *     notices; `tone` is 'info' or 'error'.
   */
  function noticesFor(state) {
    const notices = [];
    if (!state.storageAvailable) {
      notices.push({
        key: 'unavailable',
        text: PlantModel.MESSAGES.storageUnavailable,
        tone: 'info',
      });
    }
    if (state.unreadable) {
      notices.push({
        key: 'unreadable',
        text: PlantModel.MESSAGES.storageUnreadable,
        tone: 'info',
      });
    }
    if (state.saveFailed) {
      notices.push({
        key: 'saveFailed',
        text: PlantModel.MESSAGES.saveFailed,
        tone: 'error',
      });
    }
    return notices;
  }

  /**
   * Shows the notices in the status region. The region is rewritten only
   * when the set of notices changes, because rewriting an unchanged
   * role="status" region would announce it again. Notices never take focus.
   * @param {!Object} view The DOM references built by startApp.
   * @param {!Array<{key: string, text: string, tone: string}>} notices The
   *     notices to show.
   */
  function renderNotices(view, notices) {
    const shownKeys = Array.from(
        view.notices.children,
        (element) => element.getAttribute('data-notice-key'));
    const nextKeys = notices.map((notice) => notice.key);
    if (shownKeys.join(' ') === nextKeys.join(' ')) {
      return;
    }
    const doc = view.notices.ownerDocument;
    const fragment = doc.createDocumentFragment();
    for (const notice of notices) {
      const className =
          notice.tone === 'error' ? 'notice notice--error' : 'notice';
      const paragraph = createElement(doc, 'p', className, notice.text);
      paragraph.setAttribute('data-notice-key', notice.key);
      fragment.append(paragraph);
    }
    view.notices.replaceChildren(fragment);
  }

  /**
   * Shows or clears one field's inline message and ties it to the input.
   * @param {!HTMLInputElement} input The field.
   * @param {!HTMLElement} errorElement The field's message element.
   * @param {string|undefined} message The message, or '' or undefined to
   *     clear it.
   */
  function renderFieldError(input, errorElement, message) {
    if (message) {
      errorElement.textContent = message;
      errorElement.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', errorElement.id);
    } else {
      errorElement.hidden = true;
      errorElement.textContent = '';
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
  }

  /**
   * Shows the form's inline messages; a field without one is cleared.
   * @param {!Object} view The DOM references built by startApp.
   * @param {{name: (string|undefined), lastWatered: (string|undefined)}}
   *     errors The message for each failing field.
   */
  function renderFieldErrors(view, errors) {
    renderFieldError(view.nameInput, view.nameError, errors.name);
    renderFieldError(view.dateInput, view.dateError, errors.lastWatered);
  }

  // ===== 4. Event wiring =====

  /**
   * Draws random bytes from the platform's cryptographic generator, which,
   * unlike crypto.randomUUID, works outside secure contexts too.
   * @param {number} n The number of bytes.
   * @returns {!Uint8Array} n random bytes.
   */
  function getRandomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  /**
   * Generates a new plant id not in the given set.
   * @param {!Set<string>} usedIds Ids already in use.
   * @returns {string} The new id.
   */
  function makeId(usedIds) {
    return PlantModel.generateId(usedIds, getRandomBytes);
  }

  /**
   * Reads the clock afresh, so a page left open past midnight uses the new
   * date.
   * @returns {string} Today's local date as `YYYY-MM-DD`.
   */
  function getToday() {
    return PlantModel.toLocalDateString(new Date());
  }

  /**
   * Starts the app on a parsed document: loads the saved list, renders it
   * and attaches the listeners. Every change runs model, then state, then
   * save, then render, so the page always shows the in-memory list whether
   * or not the save succeeded.
   * @param {!Document} doc The page's document.
   */
  function startApp(doc) {
    const view = {
      form: doc.getElementById('add-plant-form'),
      nameInput: doc.getElementById('plant-name'),
      nameError: doc.getElementById('plant-name-error'),
      dateInput: doc.getElementById('last-watered'),
      dateError: doc.getElementById('last-watered-error'),
      list: doc.getElementById('plant-list'),
      emptyState: doc.getElementById('empty-state'),
      notices: doc.getElementById('notices'),
    };
    const store = PlantStorage.createPlantStorage({ makeId });
    const loaded = store.load();
    const state = {
      plants: loaded.plants,
      storageAvailable: loaded.available,
      unreadable: loaded.unreadable,
      saveFailed: false,
    };
    // True once the user edits Last watered, so a refresh never overwrites
    // their value.
    let dateEdited = false;

    /**
     * Brings the date field's max, and its value until the user edits it,
     * up to today. Each property is written only when it differs, so an
     * unchanged date never disturbs the control mid-edit.
     */
    function refreshDateInput() {
      const today = getToday();
      if (view.dateInput.max !== today) {
        view.dateInput.max = today;
      }
      if (!dateEdited && view.dateInput.value !== today) {
        view.dateInput.value = today;
      }
    }

    /**
     * Adopts a new plant list, saves it and re-renders from it.
     * @param {!Array<!Plant>} next The new list.
     * @returns {!Map<string, !HTMLButtonElement>} The new Water now buttons
     *     by plant id.
     */
    function commit(next) {
      state.plants = next;
      const result = store.save(next);
      state.saveFailed = !result.ok && result.reason === 'write-failed';
      return renderApp(view, state);
    }

    /**
     * Adds a plant from the form, or shows the inline messages and moves
     * focus to the first invalid field, keeping both values as typed.
     * @param {!Event} event The form's submit event.
     */
    function handleSubmit(event) {
      event.preventDefault();
      refreshDateInput();
      const result = PlantModel.validatePlantInput(
          { name: view.nameInput.value, lastWatered: view.dateInput.value },
          getToday());
      if (!result.ok) {
        const firstInvalid =
            result.errors.name ? view.nameInput : view.dateInput;
        // Enter inside a field submits with that field still focused, and
        // focus() on the focused element fires no focus event. Blurring it
        // makes the focus move real, so a screen reader re-reads the field
        // with its new message. The blur comes before the messages render,
        // so a change event it commits cannot clear the one just shown.
        if (firstInvalid === doc.activeElement) {
          firstInvalid.blur();
        }
        renderFieldErrors(view, result.errors);
        firstInvalid.focus();
        return;
      }
      const usedIds = new Set(state.plants.map((plant) => plant.id));
      const plant = PlantModel.createPlant(result.value, makeId(usedIds));
      commit(PlantModel.addPlant(state.plants, plant));
      view.nameInput.value = '';
      dateEdited = false;
      refreshDateInput();
      renderFieldErrors(view, {});
      view.nameInput.focus();
    }

    /**
     * Records a watering for the clicked row's plant. Enter and Space on a
     * button fire click too. Re-rendering replaces the pressed button, so
     * focus moves to that plant's new button.
     * @param {!Event} event A click inside the list.
     */
    function handleWaterClick(event) {
      const button = event.target.closest('button[data-plant-id]');
      if (button === null) {
        return;
      }
      const id = button.getAttribute('data-plant-id');
      if (!state.plants.some((plant) => plant.id === id)) {
        return;
      }
      const buttons =
          commit(PlantModel.markWatered(state.plants, id, getToday()));
      refreshDateInput();
      buttons.get(id).focus();
    }

    /** Clears the Name message once the user edits the field. */
    function handleNameInput() {
      renderFieldError(view.nameInput, view.nameError, '');
    }

    /**
     * Marks the date as the user's own and clears its message once the user
     * edits the field.
     */
    function handleDateEdit() {
      dateEdited = true;
      renderFieldError(view.dateInput, view.dateError, '');
    }

    /** Refreshes the date field when the page becomes visible again. */
    function handleVisibilityChange() {
      if (doc.visibilityState === 'visible') {
        refreshDateInput();
      }
    }

    refreshDateInput();
    renderApp(view, state);

    view.form.addEventListener('submit', handleSubmit);
    view.list.addEventListener('click', handleWaterClick);
    view.nameInput.addEventListener('input', handleNameInput);
    view.dateInput.addEventListener('input', handleDateEdit);
    view.dateInput.addEventListener('change', handleDateEdit);
    // These fire before the picker opens or a key edits a segment, so a tab
    // that stayed in the foreground past midnight offers the new date.
    view.dateInput.addEventListener('focus', refreshDateInput);
    view.dateInput.addEventListener('pointerdown', refreshDateInput);
    view.dateInput.addEventListener('keydown', refreshDateInput);
    doc.defaultView.addEventListener('focus', refreshDateInput);
    doc.addEventListener('visibilitychange', handleVisibilityChange);
  }

  // ===== 5. Entry =====

  // Under the Node.js test loader a CommonJS module object is in scope, so
  // the file exports its pure parts and touches no DOM. In the browser
  // there is no module object, and the app starts.
  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = { model: PlantModel, storage: PlantStorage };
  } else {
    startApp(document);
  }
})();
