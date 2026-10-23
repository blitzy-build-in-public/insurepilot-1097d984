/**
 * @fileoverview Browser checks for Plant Parent in headless Chromium: the
 * success criteria C01-C14 and the states S1-S4, each run once in every run
 * of the matrix (opened from file:// and served from 127.0.0.1, at 360 px
 * and 1280 px wide), so 72 tests in all.
 *
 * Every check runs inside harness.runCheck, which fails it on any page error
 * or console error or warning, guarantees tests/evidence/<run>/<check>.png,
 * records one entry in tests/evidence/results.json with the values the
 * check observed, and closes every browser context the check opened. No
 * check reads state another check wrote: each opens its own sessions, and a
 * fresh context starts with empty storage.
 *
 * The fixed browser clock is 2025-03-06T20:00:00-08:00 in
 * America/Los_Angeles, so local today is 2025-03-06 while the UTC date is
 * already 2025-03-07: a date shown for today must read "Mar 6, 2025", and
 * "Mar 7, 2025" means a UTC slip.
 *
 * Run from the repository root, after `npm ci --prefix tests` and
 * `npx --prefix tests playwright install chromium`:
 *   node --test --test-concurrency=1 "tests/browser/*.test.js"
 * or from anywhere:
 *   npm --prefix tests run test:browser
 */
'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const h = require('./harness.js');

/** The page texts the checks expect, compared as exact strings. */
const T = h.TEXT;

/** Local today at the default clock. */
const TODAY = h.TODAY;

/** Local today once S2 moves the clock past midnight. */
const TOMORROW = '2025-03-07';

/** S2's clock one minute before local midnight. */
const BEFORE_MIDNIGHT = '2025-03-06T23:59:00-08:00';

/** S2's clock one minute after local midnight. */
const AFTER_MIDNIGHT = '2025-03-07T00:01:00-08:00';

/** Per-test limit, so a hung browser cannot stall the run. */
const TEST_TIMEOUT = 60000;

/** Most Tab or Shift+Tab presses a keyboard walk may take. */
const MAX_FOCUS_PRESSES = 30;

/** The three record keys, sorted, that every stored entry must carry. */
const RECORD_KEYS = Object.freeze(['id', 'lastWatered', 'name']);

/** The three request paths the static server may see from one check. */
const SERVED_PATHS = Object.freeze(['/app.js', '/index.html', '/styles.css']);

/** How long the server log must gain no entry before C12 judges it. */
const SERVER_LOG_QUIET_MS = 5000;

/** Longest C12 waits for the server log to go quiet. */
const SERVER_LOG_SETTLE_CAP_MS = 15000;

/** How often C12 re-reads the server log while it waits. */
const SERVER_LOG_POLL_MS = 100;

// ===== Local helpers =====

/**
 * Projects notices onto what the checks compare. The notice's
 * data-notice-key is an implementation detail outside the specified markup,
 * so it is never asserted.
 * @param {!Array<{text: string, error: boolean}>} notices From readNotices.
 * @returns {!Array<{text: string, error: boolean}>} Text and error flag.
 */
function noticeView(notices) {
  return notices.map(({ text, error }) => ({ text, error }));
}

/**
 * Lists the row names in display order.
 * @param {!Array<{name: ?string}>} rows From readRows.
 * @returns {!Array<?string>} The names.
 */
function rowNames(rows) {
  return rows.map((row) => row.name);
}

/**
 * Lists the rows' visible dates in display order.
 * @param {!Array<{dateText: ?string}>} rows From readRows.
 * @returns {!Array<?string>} The <time> texts, such as "Mar 6, 2025".
 */
function rowDates(rows) {
  return rows.map((row) => row.dateText);
}

/**
 * Projects rows onto what a persistence comparison needs.
 * @param {!Array<{name: ?string, datetime: ?string, dateText: ?string}>}
 *     rows From readRows.
 * @returns {!Array<{name: ?string, datetime: ?string, dateText: ?string}>}
 *     Name, machine-readable date and visible date per row.
 */
function listView(rows) {
  return rows.map(({ name, datetime, dateText }) => ({
    name,
    datetime,
    dateText,
  }));
}

/**
 * Reads what the user can see, as Playwright's isVisible judges it: the
 * harness readers return DOM content and the hidden property, which a
 * stylesheet can contradict. `nameError` and `dateError` share their keys
 * with the readFields entries.
 * @param {!Object} page A loaded Playwright Page.
 * @returns {!Promise<{notices: !Array<boolean>, rows: !Array<boolean>,
 *     list: boolean, emptyState: boolean, nameError: boolean,
 *     dateError: boolean}>} One flag per notice and per row, in display
 *     order, and one each for the list, the empty state and the two field
 *     messages.
 */
async function readVisibility(page) {
  const notices = await page.locator('#notices > p.notice').all();
  const rows = await page.locator('#plant-list > li.plant').all();
  return {
    notices: await Promise.all(notices.map((notice) => notice.isVisible())),
    rows: await Promise.all(rows.map((row) => row.isVisible())),
    list: await page.locator('#plant-list').isVisible(),
    emptyState: await page.locator('#empty-state').isVisible(),
    nameError: await page.locator('#plant-name-error').isVisible(),
    dateError: await page.locator('#last-watered-error').isVisible(),
  };
}

/**
 * Parses the raw stored value, failing clearly when the key is absent.
 * @param {?string} raw From readStored.
 * @returns {*} The parsed JSON.
 */
function parseStored(raw) {
  assert.equal(typeof raw, 'string', 'the storage key holds no value');
  return JSON.parse(raw);
}

/**
 * Opens a fresh session for the check and its first page.
 * @param {!Object} ctx The check context from runCheck.
 * @param {{now: (string|undefined), block: (boolean|undefined)}=} options
 *     Session options: the fixed clock and whether storage is blocked.
 * @returns {!Promise<{session: !Object, page: !Object}>} The session and
 *     its loaded page.
 */
async function openFresh(ctx, options) {
  const session = await ctx.newSession(options);
  const page = await session.openPage();
  return { session, page };
}

/**
 * Presses one key repeatedly until focus reaches the target, logging every
 * stop.
 * @param {!Object} page A loaded Playwright Page.
 * @param {string} key 'Tab' or 'Shift+Tab'.
 * @param {string} target The descriptor to reach, as from activeElement.
 * @param {!Array<string>} log Receives the descriptor after each press.
 * @returns {!Promise<void>} Resolves once the target is focused; rejects
 *     after MAX_FOCUS_PRESSES presses without reaching it.
 */
async function pressUntil(page, key, target, log) {
  for (let presses = 0; presses < MAX_FOCUS_PRESSES; presses++) {
    if (await h.pressAndRecord(page, key, log) === target) {
      return;
    }
  }
  assert.fail(
      `${key} did not reach ${target} in ${MAX_FOCUS_PRESSES} presses; ` +
      `focus went ${log.join(' > ')}`);
}

// ===== C01-C07 =====

/**
 * C01: a first open shows the form, the empty state and no list or notice,
 * with the date field defaulting to and capped at today.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkFirstOpen(ctx) {
  const { page } = await openFresh(ctx);
  const fields = await h.readFields(page);
  ctx.observed.fields = fields;
  ctx.observed.emptyVisible = await page.locator('#empty-state').isVisible();
  ctx.observed.rows = await h.readRows(page);
  ctx.observed.notices = await h.readNotices(page);
  await ctx.screenshot(page);

  assert.equal(fields.formVisible, true, 'the form is visible');
  assert.equal(fields.emptyHidden, false, 'the empty state is not hidden');
  assert.equal(ctx.observed.emptyVisible, true, 'the empty state is shown');
  assert.equal(fields.emptyText, T.emptyState);
  assert.equal(fields.listHidden, true, 'the plant list is hidden');
  assert.deepEqual(ctx.observed.rows, []);
  assert.deepEqual(ctx.observed.notices, []);
  assert.equal(fields.dateValue, TODAY);
  assert.equal(fields.dateMax, TODAY);
}

/**
 * C02: adding "Monstera" with today's default date shows exactly one row
 * with today's date, then empties and focuses Name.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkAddOne(ctx) {
  const { page } = await openFresh(ctx);
  await h.addPlants(page, [{ name: 'Monstera' }]);
  const rows = await h.readRows(page);
  const fields = await h.readFields(page);
  const active = await h.activeElement(page);
  Object.assign(ctx.observed, { rows, fields, active });
  await ctx.screenshot(page);

  assert.equal(rows.length, 1, 'exactly one row');
  const [row] = rows;
  assert.deepEqual(
      {
        name: row.name,
        dateText: row.dateText,
        datetime: row.datetime,
        dateLine: row.dateLine,
        buttonText: row.buttonText,
        ariaLabel: row.ariaLabel,
      },
      {
        name: 'Monstera',
        dateText: 'Mar 6, 2025',
        datetime: TODAY,
        dateLine: 'Last watered Mar 6, 2025',
        buttonText: 'Water now',
        ariaLabel: 'Water now: Monstera',
      });
  assert.equal(fields.nameValue, '', 'Name is emptied');
  assert.equal(active, '#plant-name', 'Name has focus');
  assert.equal(fields.emptyHidden, true, 'the empty state is hidden');
}

/**
 * C03: three adds are listed and stored in the order they were added.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkInsertionOrder(ctx) {
  const { page } = await openFresh(ctx);
  await h.addPlants(
      page, [{ name: 'Monstera' }, { name: 'Fern' }, { name: 'Cactus' }]);
  const rows = await h.readRows(page);
  const raw = await h.readStored(page);
  Object.assign(ctx.observed, { rows, raw });
  await ctx.screenshot(page);

  const expected = ['Monstera', 'Fern', 'Cactus'];
  assert.deepEqual(rowNames(rows), expected);
  assert.deepEqual(parseStored(raw).map((entry) => entry.name), expected);
}

/**
 * C04: a past date entered in the field is shown and stored as entered,
 * and the field returns to today after the add.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkPastDate(ctx) {
  const { page } = await openFresh(ctx);
  await h.addPlants(page, [{ name: 'Pothos', date: '2025-03-05' }]);
  const rows = await h.readRows(page);
  const raw = await h.readStored(page);
  const fields = await h.readFields(page);
  Object.assign(ctx.observed, { rows, raw, fields });
  await ctx.screenshot(page);

  assert.deepEqual(rowNames(rows), ['Pothos']);
  assert.equal(rows[0].dateText, 'Mar 5, 2025');
  assert.equal(rows[0].datetime, '2025-03-05');
  assert.equal(parseStored(raw)[0].lastWatered, '2025-03-05');
  assert.equal(fields.dateValue, TODAY, 'the date field is back to today');
}

/**
 * C05: Water now sets the plant's date to today at once, with no reload,
 * and the new date is stored and survives a reload.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkWaterNow(ctx) {
  const { page } = await openFresh(ctx);
  await h.seedPlants(
      page, [{ id: 'p-a', name: 'Monstera', lastWatered: '2025-03-03' }]);
  const seeded = await h.readRows(page);
  await h.waterButton(page, 'Monstera').click();
  const pressed = await h.readRows(page);
  await ctx.screenshot(page, { suffix: 'pressed' });
  await page.reload();
  const reloaded = await h.readRows(page);
  const raw = await h.readStored(page);
  Object.assign(ctx.observed, { seeded, pressed, reloaded, raw });
  await ctx.screenshot(page);

  assert.deepEqual(rowDates(seeded), ['Mar 3, 2025']);
  assert.deepEqual(rowDates(pressed), ['Mar 6, 2025'], 'updated, no reload');
  assert.deepEqual(rowDates(reloaded), ['Mar 6, 2025'], 'after the reload');
  assert.deepEqual(
      parseStored(raw), [{ id: 'p-a', name: 'Monstera', lastWatered: TODAY }]);
}

/**
 * C06: pressing Water now on each plant in turn never moves a row or a
 * stored entry.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkStableOrder(ctx) {
  const { page } = await openFresh(ctx);
  await h.seedPlants(page, [
    { id: 'p-a', name: 'A', lastWatered: '2025-03-01' },
    { id: 'p-b', name: 'B', lastWatered: '2025-03-02' },
    { id: 'p-c', name: 'C', lastWatered: '2025-03-03' },
  ]);
  const snapshots = [];
  ctx.observed.snapshots = snapshots;
  for (const name of ['B', 'C', 'A']) {
    await h.waterButton(page, name).click();
    const rows = await h.readRows(page);
    const stored = parseStored(await h.readStored(page));
    snapshots.push({
      pressed: name,
      rowNames: rowNames(rows),
      rowDates: rowDates(rows),
      storedIds: stored.map((entry) => entry.id),
    });
  }
  await ctx.screenshot(page);

  for (const snapshot of snapshots) {
    const after = `after Water now on ${snapshot.pressed}`;
    assert.deepEqual(snapshot.rowNames, ['A', 'B', 'C'], after);
    assert.deepEqual(snapshot.storedIds, ['p-a', 'p-b', 'p-c'], after);
    const index = snapshot.rowNames.indexOf(snapshot.pressed);
    assert.equal(snapshot.rowDates[index], 'Mar 6, 2025', after);
  }
}

/**
 * C07: the list survives a reload, a second page and a browser relaunch on
 * the same profile, with the same names, dates and order. In served mode
 * every page uses the file's one server origin.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkPersistence(ctx) {
  const session = await ctx.newPersistentSession();
  const page = await session.openPage();
  await h.addPlants(page, [
    { name: 'Monstera' },
    { name: 'Fern', date: '2025-03-05' },
    { name: 'Cactus', date: '2025-02-28' },
  ]);
  const reference = listView(await h.readRows(page));
  ctx.observed.reference = reference;

  await page.reload();
  ctx.observed.reload = listView(await h.readRows(page));
  await ctx.screenshot(page, { suffix: 'reload' });

  const secondPage = await session.openPage();
  ctx.observed.secondPage = listView(await h.readRows(secondPage));
  await ctx.screenshot(secondPage, { suffix: 'second-page' });

  await session.relaunch();
  const relaunched = await session.openPage();
  ctx.observed.relaunch = listView(await h.readRows(relaunched));
  ctx.observed.urls = [page.url(), secondPage.url(), relaunched.url()];
  await ctx.screenshot(relaunched, { suffix: 'relaunch' });
  await ctx.screenshot(relaunched);

  assert.deepEqual(reference, [
    { name: 'Monstera', datetime: TODAY, dateText: 'Mar 6, 2025' },
    { name: 'Fern', datetime: '2025-03-05', dateText: 'Mar 5, 2025' },
    { name: 'Cactus', datetime: '2025-02-28', dateText: 'Feb 28, 2025' },
  ]);
  assert.deepEqual(ctx.observed.reload, reference, 'after the reload');
  assert.deepEqual(ctx.observed.secondPage, reference, 'on a second page');
  assert.deepEqual(ctx.observed.relaunch, reference, 'after the relaunch');
  assert.deepEqual(
      ctx.observed.urls, [ctx.url, ctx.url, ctx.url], 'one page URL');
}

// ===== C08-C11 =====

/**
 * C08: storage holds a JSON array whose entries carry exactly id, name and
 * lastWatered, with canonical dates and distinct generated ids.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkStoredShape(ctx) {
  const { page } = await openFresh(ctx);
  await h.addPlants(page, [
    { name: 'Monstera' },
    { name: 'Fern', date: '2025-03-05' },
    { name: 'Cactus', date: '2025-02-28' },
  ]);
  await h.waterButton(page, 'Fern').click();
  const raw = await h.readStored(page);
  ctx.observed.raw = raw;
  await ctx.screenshot(page);

  const parsed = parseStored(raw);
  ctx.observed.keySets = Array.isArray(parsed) ?
      parsed.map((entry) => Object.keys(entry).sort()) : null;
  assert.ok(Array.isArray(parsed), 'the stored value is a JSON array');
  assert.equal(parsed.length, 3);
  for (const entry of parsed) {
    assert.deepEqual(Object.keys(entry).sort(), RECORD_KEYS);
    assert.match(entry.lastWatered, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(entry.id, /^p-[0-9a-f]{32}$/);
  }
  const ids = parsed.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'the ids are distinct');
  assert.deepEqual(
      parsed.map(({ name, lastWatered }) => [name, lastWatered]), [
        ['Monstera', TODAY],
        ['Fern', TODAY],
        ['Cactus', '2025-02-28'],
      ]);
}

/**
 * The Name field as C09 asserts it: `error` names its readFields entry,
 * `input` is the input's activeElement descriptor and `errorId` is the id of
 * its message element.
 * @const {{error: string, input: string, errorId: string}}
 */
const NAME_FIELD = Object.freeze({
  error: 'nameError',
  input: '#plant-name',
  errorId: 'plant-name-error',
});

/**
 * The Last watered field, in NAME_FIELD's shape.
 * @const {{error: string, input: string, errorId: string}}
 */
const DATE_FIELD = Object.freeze({
  error: 'dateError',
  input: '#last-watered',
  errorId: 'last-watered-error',
});

/**
 * C09's refused submits, in the order they run in one session. A sub-case
 * without `date` leaves the date field at its default, today.
 * @const {!ReadonlyArray<{suffix: string, name: string,
 *     date: (string|undefined), field: !Object, other: !Object,
 *     message: string}>} `field` is the invalid field and `other` the
 *     valid one, each NAME_FIELD or DATE_FIELD.
 */
const REFUSED_SUBMITS = Object.freeze([
  {
    suffix: 'a',
    name: '',
    field: NAME_FIELD,
    other: DATE_FIELD,
    message: T.nameRequired,
  },
  {
    suffix: 'b',
    name: '   ',
    field: NAME_FIELD,
    other: DATE_FIELD,
    message: T.nameRequired,
  },
  {
    suffix: 'c',
    name: 'A'.repeat(81),
    field: NAME_FIELD,
    other: DATE_FIELD,
    message: T.nameTooLong,
  },
  {
    suffix: 'd',
    name: 'Monstera',
    date: '',
    field: DATE_FIELD,
    other: NAME_FIELD,
    message: T.dateRequired,
  },
  {
    suffix: 'e',
    name: 'Monstera',
    date: TOMORROW,
    field: DATE_FIELD,
    other: NAME_FIELD,
    message: T.dateInFuture,
  },
]);

/**
 * C09: every invalid submit shows its exact message tied to its field,
 * moves focus there, adds no row, writes nothing and keeps the values as
 * typed.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkRefusedSubmits(ctx) {
  const { page } = await openFresh(ctx);
  ctx.observed.subCases = {};
  for (const subCase of REFUSED_SUBMITS) {
    await page.fill('#plant-name', subCase.name);
    if (subCase.date !== undefined) {
      await page.fill('#last-watered', subCase.date);
    }
    await h.submitForm(page);
    const fields = await h.readFields(page);
    const outcome = {
      fields,
      rowCount: (await h.readRows(page)).length,
      raw: await h.readStored(page),
      active: await h.activeElement(page),
      visible: await readVisibility(page),
    };
    ctx.observed.subCases[subCase.suffix] = outcome;
    await ctx.screenshot(page, { suffix: subCase.suffix });

    const label = `sub-case ${subCase.suffix}`;
    const shown = fields[subCase.field.error];
    const other = fields[subCase.other.error];
    assert.equal(shown.text, subCase.message, label);
    assert.equal(shown.hidden, false, `${label}: the message is shown`);
    assert.equal(
        outcome.visible[subCase.field.error], true,
        `${label}: #${subCase.field.errorId} is visible`);
    assert.equal(shown.inputInvalid, 'true', label);
    assert.equal(shown.describedBy, subCase.field.errorId, label);
    assert.equal(other.inputInvalid, null, `${label}: other field valid`);
    assert.equal(other.describedBy, null, `${label}: other field valid`);
    assert.equal(other.hidden, true, `${label}: no other message`);
    assert.equal(
        outcome.visible[subCase.other.error], false,
        `${label}: #${subCase.other.errorId} is not visible`);
    assert.equal(outcome.rowCount, 0, `${label}: no row added`);
    assert.equal(outcome.raw, null, `${label}: nothing stored`);
    assert.equal(fields.nameValue, subCase.name, `${label}: Name kept`);
    assert.equal(
        fields.dateValue, subCase.date ?? TODAY, `${label}: date kept`);
    assert.equal(outcome.active, subCase.field.input, `${label}: focus`);
  }
  await ctx.screenshot(page);
}

/**
 * C10's seeded values: invalid JSON, a non-array and an array mixing two
 * valid entries with four invalid ones, with the rows each must show.
 * @const {!ReadonlyArray<{suffix: string, raw: string,
 *     rows: !Array<string>}>}
 */
const UNREADABLE_SEEDS = Object.freeze([
  { suffix: 'a', raw: '{not json', rows: [] },
  { suffix: 'b', raw: '{"plants":[]}', rows: [] },
  {
    suffix: 'c',
    raw: JSON.stringify([
      { id: 'p-1', name: 'Monstera', lastWatered: '2025-03-01' },
      { id: 'p-2', name: '', lastWatered: '2025-03-01' },
      { id: 'p-3', name: 'Fern', lastWatered: '2025-02-30' },
      42,
      { id: 'p-5', name: 'Cactus', lastWatered: '2025-03-02' },
      { id: 'p-6', name: 'Ivy' },
    ]),
    rows: ['Monstera', 'Cactus'],
  },
]);

/**
 * C10: corrupt or wrong-shape storage loads without an error, shows the
 * unreadable notice and only the valid entries, in order, and is left
 * exactly as found.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkUnreadableStorage(ctx) {
  ctx.observed.seeds = {};
  for (const seed of UNREADABLE_SEEDS) {
    const { page } = await openFresh(ctx);
    await h.seedRaw(page, seed.raw);
    const outcome = {
      notices: await h.readNotices(page),
      rows: await h.readRows(page),
      fields: await h.readFields(page),
      raw: await h.readStored(page),
      visible: await readVisibility(page),
    };
    ctx.observed.seeds[seed.suffix] = outcome;
    await ctx.screenshot(page, { suffix: seed.suffix });

    const label = `seed ${seed.suffix}`;
    const { visible } = outcome;
    assert.deepEqual(
        noticeView(outcome.notices),
        [{ text: T.storageUnreadable, error: false }], label);
    assert.deepEqual(
        visible.notices, [true], `${label}: the notice is visible`);
    assert.deepEqual(rowNames(outcome.rows), seed.rows, label);
    assert.deepEqual(
        visible.rows, seed.rows.map(() => true),
        `${label}: every row is visible`);
    assert.deepEqual(
        rowNames(outcome.rows).filter((name, index) => visible.rows[index]),
        seed.rows, `${label}: the visible rows, in order`);
    if (seed.rows.length === 0) {
      assert.equal(outcome.fields.emptyHidden, false, `${label}: empty`);
      assert.equal(outcome.fields.listHidden, true, `${label}: no list`);
      assert.equal(
          visible.emptyState, true, `${label}: #empty-state is visible`);
      assert.equal(visible.list, false, `${label}: #plant-list is not visible`);
    } else {
      assert.equal(visible.list, true, `${label}: #plant-list is visible`);
      assert.equal(
          visible.emptyState, false, `${label}: #empty-state is not visible`);
    }
    assert.equal(outcome.raw, seed.raw, `${label}: storage untouched`);
  }
}

/**
 * C11: with storage blocked the page opens with the unavailable notice,
 * adding and Water now work for the session, and a reload starts empty.
 * Storage is never read from the test here, because every read throws.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkBlockedStorage(ctx) {
  const { page } = await openFresh(ctx, { block: true });
  const unavailable = [{ text: T.storageUnavailable, error: false }];
  const visible = {};
  ctx.observed.visible = visible;
  ctx.observed.onOpen = await h.readNotices(page);
  visible.onOpen = await readVisibility(page);
  await h.addPlants(page, [
    { name: 'Monstera' },
    { name: 'Fern', date: '2025-03-05' },
  ]);
  ctx.observed.afterAdds = await h.readRows(page);
  visible.afterAdds = await readVisibility(page);
  await h.waterButton(page, 'Fern').click();
  ctx.observed.afterPress = await h.readRows(page);
  visible.afterPress = await readVisibility(page);
  await ctx.screenshot(page);
  await page.reload();
  ctx.observed.afterReload = {
    notices: await h.readNotices(page),
    rows: await h.readRows(page),
    fields: await h.readFields(page),
  };
  visible.afterReload = await readVisibility(page);
  await ctx.screenshot(page, { suffix: 'reload' });

  assert.deepEqual(noticeView(ctx.observed.onOpen), unavailable, 'on open');
  assert.deepEqual(
      visible.onOpen.notices, [true], 'the notice is visible on open');
  assert.deepEqual(rowNames(ctx.observed.afterAdds), ['Monstera', 'Fern']);
  assert.deepEqual(
      rowDates(ctx.observed.afterAdds), ['Mar 6, 2025', 'Mar 5, 2025']);
  assert.deepEqual(
      visible.afterAdds.rows, [true, true],
      'both rows are visible after the adds');
  assert.deepEqual(rowNames(ctx.observed.afterPress), ['Monstera', 'Fern']);
  assert.equal(ctx.observed.afterPress[1].dateText, 'Mar 6, 2025');
  assert.deepEqual(
      visible.afterPress.rows, [true, true],
      'both rows are visible after Water now');
  const reloaded = ctx.observed.afterReload;
  assert.deepEqual(noticeView(reloaded.notices), unavailable, 'on reload');
  assert.deepEqual(
      visible.afterReload.notices, [true], 'the notice is visible on reload');
  assert.deepEqual(reloaded.rows, [], 'nothing was kept');
  assert.equal(reloaded.fields.emptyHidden, false, 'the empty state shows');
  assert.equal(reloaded.fields.listHidden, true, 'the list is hidden');
  assert.equal(
      visible.afterReload.emptyState, true,
      '#empty-state is visible on reload');
  assert.equal(
      visible.afterReload.list, false, '#plant-list is not visible on reload');
}


// ===== C12-C14 =====

/**
 * Tells whether a logged URL is a data: URL, which is no network request.
 * @param {string} url A request URL.
 * @returns {boolean} True for a data: URL.
 */
function isDataUrl(url) {
  return url.startsWith('data:');
}

/**
 * Lists the distinct non-data: URLs logged in one phase.
 * @param {!Array<{url: string, phase: string}>} network A session's log.
 * @param {string} phase 'load', 'interactions' or 'reload'.
 * @returns {!Array<string>} The URLs, sorted.
 */
function phaseUrls(network, phase) {
  const urls = network
      .filter((entry) => entry.phase === phase && !isDataUrl(entry.url))
      .map((entry) => entry.url);
  return [...new Set(urls)].sort();
}

/**
 * Asserts the network contract: nothing but the page's own three files and
 * data: URLs, all three files on load and on reload, nothing during the
 * interactions, and in served mode no /favicon.ico at the server, which
 * Playwright's own events never show.
 * @param {!Array<{url: string, phase: string}>} network The session's log.
 * @param {!Array<string>} allowed The three file URLs for the run.
 * @param {?Array<string>} servedPaths The server's request paths since the
 *     check began, or null in file mode.
 */
function assertNetworkContract(network, allowed, servedPaths) {
  const strays = network
      .map((entry) => entry.url)
      .filter((url) => !isDataUrl(url) && !allowed.includes(url));
  assert.deepEqual(strays, [], 'no request beyond the page\'s own files');
  const expected = [...allowed].sort();
  assert.deepEqual(phaseUrls(network, 'load'), expected, 'on load');
  assert.deepEqual(phaseUrls(network, 'interactions'), [], 'interactions');
  assert.deepEqual(phaseUrls(network, 'reload'), expected, 'on reload');
  if (servedPaths !== null) {
    assert.ok(
        !servedPaths.includes('/favicon.ico'), 'the server saw /favicon.ico');
    assert.deepEqual([...new Set(servedPaths)].sort(), SERVED_PATHS);
  }
}

/**
 * Waits until the static server's request log has gained no entry for
 * SERVER_LOG_QUIET_MS, re-reading it every SERVER_LOG_POLL_MS, and stops
 * after SERVER_LOG_SETTLE_CAP_MS so a page that keeps requesting cannot hang
 * the check.
 * @param {!Array<string>} requests The server's live request log.
 * @returns {!Promise<{settled: boolean, waitedMs: number,
 *     lateEntries: number, lastArrivalMs: ?number}>} Whether the log went
 *     quiet within the cap, how long the wait took, how many entries
 *     arrived during it, and when the last of them arrived after the wait
 *     began (null when none did).
 */
async function settleServerLog(requests) {
  const start = performance.now();
  const initial = requests.length;
  let seen = initial;
  let quietSince = start;
  let lastArrivalMs = null;
  let now = start;
  while (now - quietSince < SERVER_LOG_QUIET_MS) {
    if (now - start >= SERVER_LOG_SETTLE_CAP_MS) {
      break;
    }
    await delay(SERVER_LOG_POLL_MS);
    now = performance.now();
    if (requests.length !== seen) {
      seen = requests.length;
      quietSince = now;
      lastArrivalMs = Math.round(now - start);
    }
  }
  return {
    settled: now - quietSince >= SERVER_LOG_QUIET_MS,
    waitedMs: Math.round(now - start),
    lateEntries: seen - initial,
    lastArrivalMs,
  };
}

/**
 * C12: from navigation through an add, a Water now and a reload, the page
 * requests only its own three files. network.json is written before the
 * outcome is raised, so the log exists even when the check fails.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkNetwork(ctx) {
  const served = ctx.run.mode === 'served';
  const session = await ctx.newSession();
  const serverStart = served ? ctx.server.requests.length : 0;
  session.phase = 'load';
  const page = await session.openPage();
  await page.waitForLoadState('networkidle');
  session.phase = 'interactions';
  await h.addPlants(page, [{ name: 'Monstera' }]);
  await h.waterButton(page, 'Monstera').click();
  session.phase = 'reload';
  await page.reload();
  await page.waitForLoadState('networkidle');
  await ctx.screenshot(page);

  // Chromium fetches /favicon.ico asynchronously, only after consulting its
  // favicon database, so on a busy host the request can reach the server
  // after networkidle, and Playwright never reports it. The server log is
  // therefore judged only once it has gone quiet; a page whose requests
  // never stop fails.
  const settle = served ? await settleServerLog(ctx.server.requests) : null;
  const allowed = h.expectedFiles(ctx.run, ctx.server);
  const servedPaths = served ? ctx.server.requests.slice(serverStart) : null;
  Object.assign(ctx.observed, {
    allowed,
    playwright: session.network,
    server: servedPaths,
    serverSettle: settle,
  });
  let failure = null;
  try {
    assert.ok(
        settle === null || settle.settled,
        `the server log was still growing after ${settle?.waitedMs} ms`);
    assertNetworkContract(session.network, allowed, servedPaths);
  } catch (err) {
    failure = err;
  }
  h.writeNetworkLog(ctx.run, {
    mode: ctx.run.mode,
    pageUrl: ctx.url,
    playwright: session.network,
    server: servedPaths,
    serverSettle: settle,
    pass: failure === null,
  });
  if (failure !== null) {
    throw failure;
  }
}

/**
 * Builds C13's layout in one new session: an 80-character name with no
 * spaces, a second plant and the Name message, then reads the rows and the
 * long name's rendered state, measures the layout and takes a full-page
 * screenshot.
 * @param {!Object} ctx The check context from runCheck.
 * @param {{block: (boolean|undefined)}} options Session options.
 * @param {string|undefined} suffix The screenshot suffix; none for
 *     <check>.png.
 * @returns {!Promise<!Object>} `rows`, every row from readRows;
 *     `longNameVisible`, the rendered visibility of the first row's
 *     .plant__name; `longNameLayout`, one entry per element matched, so
 *     none when it is absent, holding that element's scrollWidth,
 *     clientWidth, scrollHeight and clientHeight, its `rect` (left, right,
 *     top and bottom from getBoundingClientRect), the page's `innerWidth`
 *     and `clippedBy`, a 'tag#id.class' descriptor for each ancestor up to
 *     and including body whose overflow on an axis is not visible and whose
 *     box does not contain the name's rect on that axis; then the overflow
 *     measurement, the Name message and the notices, with the rendered
 *     visibility of each.
 */
async function measureLayout(ctx, options, suffix) {
  const { page } = await openFresh(ctx, options);
  await h.addPlants(page, [{ name: 'W'.repeat(80) }, { name: 'Fern' }]);
  // Name is empty after the adds, so this submit shows the Name message.
  await h.submitForm(page);
  const longName =
      page.locator('#plant-list > li.plant').first().locator('.plant__name');
  const outcome = {
    rows: await h.readRows(page),
    longNameVisible: await longName.isVisible(),
    // evaluateAll does not wait for a match, so an absent name reads as [].
    longNameLayout: await longName.evaluateAll(
        (names) => names.map((name) => {
          const rect = name.getBoundingClientRect();
          // Any overflow but visible (hidden, clip, auto, scroll) hides what
          // lies outside the box on that axis. 0.5 px absorbs sub-pixel
          // rounding of the two rects.
          const slack = 0.5;
          const clippedBy = [];
          let node = name.parentElement;
          while (node !== null) {
            const style = getComputedStyle(node);
            const box = node.getBoundingClientRect();
            const outsideX = rect.left < box.left - slack ||
                rect.right > box.right + slack;
            const outsideY = rect.top < box.top - slack ||
                rect.bottom > box.bottom + slack;
            if ((style.overflowX !== 'visible' && outsideX) ||
                (style.overflowY !== 'visible' && outsideY)) {
              const id = node.id ? `#${node.id}` : '';
              const classes = Array.from(node.classList, (c) => `.${c}`);
              clippedBy.push(
                  `${node.tagName.toLowerCase()}${id}${classes.join('')}`);
            }
            node = node === document.body ? null : node.parentElement;
          }
          return {
            scrollWidth: name.scrollWidth,
            clientWidth: name.clientWidth,
            scrollHeight: name.scrollHeight,
            clientHeight: name.clientHeight,
            rect: {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            },
            innerWidth: window.innerWidth,
            clippedBy,
          };
        })),
    overflow: await h.measureOverflow(page),
    nameError: (await h.readFields(page)).nameError,
    nameErrorVisible: await page.locator('#plant-name-error').isVisible(),
    notices: await h.readNotices(page),
    noticeVisible:
        await page.locator('#notices > p.notice').first().isVisible(),
  };
  await ctx.screenshot(page, { suffix, fullPage: true });
  return outcome;
}

/**
 * C13: with a long unbroken name, the Name message and, in a blocked
 * context, the unavailable notice, nothing overflows the viewport width.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkNoOverflow(ctx) {
  ctx.observed.plain = await measureLayout(ctx, {}, undefined);
  ctx.observed.blocked = await measureLayout(ctx, { block: true }, 'blocked');

  for (const variant of ['plain', 'blocked']) {
    const { rows, longNameVisible, longNameLayout } = ctx.observed[variant];
    // The stress condition holds only with the whole long name on screen.
    assert.deepEqual(
        rowNames(rows), ['W'.repeat(80), 'Fern'], `${variant}: row names`);
    assert.equal(longNameVisible, true, `${variant}: long name shown`);
    assert.equal(
        longNameLayout.length, 1, `${variant}: one long-name element`);
    const [layout] = longNameLayout;
    assert.ok(
        layout.scrollWidth <= layout.clientWidth &&
        layout.scrollHeight <= layout.clientHeight,
        `${variant}: long name clipped, content ${layout.scrollWidth}x` +
        `${layout.scrollHeight} exceeds box ${layout.clientWidth}x` +
        `${layout.clientHeight}`);
    const { rect, innerWidth, clippedBy } = layout;
    assert.ok(
        rect.left >= 0 && rect.right <= innerWidth,
        `${variant}: long name spans ${rect.left} to ${rect.right}, ` +
        `outside 0 to ${innerWidth}`);
    assert.deepEqual(
        clippedBy, [],
        `${variant}: long name at ${JSON.stringify(rect)} clipped by ` +
        `${clippedBy.join(', ')}`);
    const { overflow, nameError, nameErrorVisible } = ctx.observed[variant];
    assert.ok(
        overflow.scrollWidth <= overflow.clientWidth,
        `${variant}: scrollWidth ${overflow.scrollWidth} exceeds ` +
        `clientWidth ${overflow.clientWidth}`);
    assert.deepEqual(overflow.offenders, [], `${variant}: outside the width`);
    assert.equal(nameError.text, T.nameRequired, variant);
    assert.equal(nameErrorVisible, true, `${variant}: Name message shown`);
  }
  const { notices, noticeVisible } = ctx.observed.blocked;
  assert.deepEqual(
      noticeView(notices), [{ text: T.storageUnavailable, error: false }]);
  assert.equal(noticeVisible, true, 'the notice is shown');
}

/**
 * Activates a plant's focused Water now button with one key, holding a
 * handle to the button first so its replacement can be proven, and reads
 * the outcome. Uses the keyboard only; nothing here moves focus.
 * @param {!Object} page A loaded Playwright Page.
 * @param {string} name The plant name.
 * @param {string} key 'Enter' or 'Space'.
 * @returns {!Promise<{name: string, key: string, active: string,
 *     oldButtonConnected: boolean, row: ?Object,
 *     outline: {outlineStyle: string, outlineWidth: string}}>} The plant's
 *     row and the focused element after the key.
 */
async function activateByKey(page, name, key) {
  const handle = await h.waterButton(page, name).elementHandle();
  try {
    await page.keyboard.press(key);
    const oldButtonConnected =
        await handle.evaluate((button) => button.isConnected);
    const rows = await h.readRows(page);
    return {
      name,
      key,
      active: await h.activeElement(page),
      oldButtonConnected,
      row: rows.find((row) => row.name === name) ?? null,
      outline: await h.focusOutline(page),
    };
  } finally {
    await handle.dispose();
  }
}

/**
 * Asserts one keyboard activation's outcome: the plant was watered, its
 * button was re-rendered and the new button holds a visible 3px focus ring.
 * @param {!Object} activation From activateByKey.
 * @param {string} id The plant's id.
 */
function assertActivation(activation, id) {
  const label = `after ${activation.key} on ${activation.name}`;
  assert.equal(activation.row?.dateText, 'Mar 6, 2025', label);
  assert.equal(activation.active, `water:${id}`, `${label}: focus`);
  assert.equal(
      activation.oldButtonConnected, false, `${label}: button re-rendered`);
  assert.deepEqual(
      activation.outline, { outlineStyle: 'solid', outlineWidth: '3px' },
      `${label}: focus outline`);
}

/**
 * C14: the keyboard alone moves through every control in document order,
 * activates each Water now with Enter or Space, restores focus to the
 * re-rendered button, walks back to Name and adds a plant. It makes no
 * click, fill or programmatic focus call.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkKeyboard(ctx) {
  const { page } = await openFresh(ctx);
  await h.seedPlants(page, [
    { id: 'p-a', name: 'A', lastWatered: '2025-03-03' },
    { id: 'p-b', name: 'B', lastWatered: '2025-03-03' },
    { id: 'p-c', name: 'C', lastWatered: '2025-03-03' },
  ]);
  const nameMatches = {};
  for (const name of ['A', 'B', 'C']) {
    nameMatches[name] = await h.waterButton(page, name).count();
  }
  const forward = [];
  const reverse = [];
  const activations = [];
  Object.assign(ctx.observed, { nameMatches, forward, reverse, activations });
  assert.deepEqual(
      nameMatches, { A: 1, B: 1, C: 1 }, 'exact "Water now: <name>" names');

  // (a) Tab from the top of the document to A's button, (b) Enter.
  await pressUntil(page, 'Tab', 'water:p-a', forward);
  activations.push(await activateByKey(page, 'A', 'Enter'));
  assertActivation(activations[0], 'p-a');
  // (c) One Tab to B's button, Space.
  assert.equal(await h.pressAndRecord(page, 'Tab', forward), 'water:p-b');
  activations.push(await activateByKey(page, 'B', 'Space'));
  assertActivation(activations[1], 'p-b');
  // (d) One Tab to C's button, Enter.
  assert.equal(await h.pressAndRecord(page, 'Tab', forward), 'water:p-c');
  activations.push(await activateByKey(page, 'C', 'Enter'));
  assertActivation(activations[2], 'p-c');
  assert.deepEqual(h.distinct(forward), [
    '#plant-name',
    '#last-watered',
    'button:Add plant',
    'water:p-a',
    'water:p-b',
    'water:p-c',
  ]);

  // (e) Shift+Tab back to Name.
  await pressUntil(page, 'Shift+Tab', '#plant-name', reverse);
  assert.deepEqual(h.distinct(reverse), [
    'water:p-b',
    'water:p-a',
    'button:Add plant',
    '#last-watered',
    '#plant-name',
  ]);

  // (f) Type a name and submit with Enter.
  ctx.observed.beforeTyping = await h.activeElement(page);
  assert.equal(ctx.observed.beforeTyping, '#plant-name');
  await page.keyboard.type('Ivy');
  await page.keyboard.press('Enter');
  const rows = await h.readRows(page);
  const fields = await h.readFields(page);
  const active = await h.activeElement(page);
  Object.assign(ctx.observed, { rows, fields, active });
  await ctx.screenshot(page);

  assert.deepEqual(rowNames(rows), ['A', 'B', 'C', 'Ivy']);
  assert.deepEqual(
      rowDates(rows),
      ['Mar 6, 2025', 'Mar 6, 2025', 'Mar 6, 2025', 'Mar 6, 2025']);
  assert.equal(fields.nameValue, '', 'Name is emptied');
  assert.equal(active, '#plant-name', 'Name has focus');
}


// ===== S1-S4 =====

/**
 * S1: when a write fails, the change stays on screen with the save-failed
 * notice, storage keeps its previous value, and a reload shows that value.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkWriteFailure(ctx) {
  const { page } = await openFresh(ctx);
  const seed = await h.seedPlants(
      page, [{ id: 'p-a', name: 'Monstera', lastWatered: '2025-03-03' }]);
  await h.failWrites(page);
  await h.addPlants(page, [{ name: 'Fern' }]);
  const failed = {
    rows: await h.readRows(page),
    notices: await h.readNotices(page),
    raw: await h.readStored(page),
    visible: await readVisibility(page),
  };
  Object.assign(ctx.observed, { seed, failed });
  await ctx.screenshot(page);
  await page.reload();
  ctx.observed.reloaded = {
    rows: await h.readRows(page),
    notices: await h.readNotices(page),
    visible: await readVisibility(page),
  };
  await ctx.screenshot(page, { suffix: 'reload' });

  assert.deepEqual(rowNames(failed.rows), ['Monstera', 'Fern']);
  assert.deepEqual(failed.visible.rows, [true, true], 'both rows are visible');
  assert.deepEqual(
      noticeView(failed.notices), [{ text: T.saveFailed, error: true }]);
  assert.deepEqual(
      failed.visible.notices, [true], 'the save-failed notice is visible');
  assert.equal(failed.raw, seed, 'storage keeps the seeded value');
  assert.deepEqual(rowNames(ctx.observed.reloaded.rows), ['Monstera']);
  assert.deepEqual(
      ctx.observed.reloaded.visible.rows, [true],
      'the Monstera row is visible on reload');
  assert.deepEqual(ctx.observed.reloaded.notices, [], 'no notice on reload');
}

/**
 * S2 (a): a page that was in the background past midnight takes the new
 * date when the window regains focus, for the field, a new plant and Water
 * now alike.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<!Object>} The observed values.
 */
async function midnightOnWindowFocus(ctx) {
  const { session, page } = await openFresh(ctx, { now: BEFORE_MIDNIGHT });
  await h.seedPlants(
      page, [{ id: 'p-a', name: 'Monstera', lastWatered: '2025-03-03' }]);
  const beforeMidnight = await h.readFields(page);
  await h.setClock(session, AFTER_MIDNIGHT);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const afterFocus = await h.readFields(page);
  await h.addPlants(page, [{ name: 'Ivy' }]);
  await h.waterButton(page, 'Monstera').click();
  const rows = await h.readRows(page);
  await ctx.screenshot(page, { suffix: 'a' });
  return { beforeMidnight, afterFocus, rows };
}

/**
 * S2 (b): a page that stayed in the foreground past midnight, with no
 * window focus or visibilitychange event, offers the new date as soon as
 * Tab reaches the date field.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<!Object>} The observed values.
 */
async function midnightOnFieldFocus(ctx) {
  const { session, page } = await openFresh(ctx, { now: BEFORE_MIDNIGHT });
  const beforeMidnight = await h.readFields(page);
  await h.setClock(session, AFTER_MIDNIGHT);
  const focusLog = [];
  await pressUntil(page, 'Tab', '#last-watered', focusLog);
  const focused = await h.readFields(page);
  await ctx.screenshot(page, { suffix: 'b' });
  return { beforeMidnight, focusLog, focused };
}

/**
 * S2 (c): a pointer press on an edited date field after midnight moves its
 * max to the new date and keeps the user's value.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<!Object>} The observed values.
 */
async function midnightOnEditedField(ctx) {
  const { session, page } = await openFresh(ctx, { now: BEFORE_MIDNIGHT });
  await page.fill('#last-watered', '2025-03-05');
  const edited = await h.readFields(page);
  await h.setClock(session, AFTER_MIDNIGHT);
  await page.click('#last-watered');
  const clicked = await h.readFields(page);
  await ctx.screenshot(page, { suffix: 'c' });
  return { edited, clicked };
}

/**
 * S2: a page left open past midnight validates against, records and offers
 * the new date, in three separate sessions.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkPastMidnight(ctx) {
  const a = await midnightOnWindowFocus(ctx);
  ctx.observed.a = a;
  assert.deepEqual(
      [a.beforeMidnight.dateValue, a.beforeMidnight.dateMax], [TODAY, TODAY],
      '(a) before midnight');
  assert.deepEqual(
      [a.afterFocus.dateValue, a.afterFocus.dateMax], [TOMORROW, TOMORROW],
      '(a) after the window focus');
  assert.deepEqual(rowNames(a.rows), ['Monstera', 'Ivy']);
  assert.deepEqual(rowDates(a.rows), ['Mar 7, 2025', 'Mar 7, 2025'], '(a)');

  const b = await midnightOnFieldFocus(ctx);
  ctx.observed.b = b;
  assert.deepEqual(
      [b.beforeMidnight.dateValue, b.beforeMidnight.dateMax], [TODAY, TODAY],
      '(b) before midnight');
  assert.deepEqual(h.distinct(b.focusLog), ['#plant-name', '#last-watered']);
  assert.deepEqual(
      [b.focused.dateValue, b.focused.dateMax], [TOMORROW, TOMORROW],
      '(b) with the date field focused');

  const c = await midnightOnEditedField(ctx);
  ctx.observed.c = c;
  assert.deepEqual(
      [c.edited.dateValue, c.edited.dateMax], ['2025-03-05', TODAY],
      '(c) before midnight');
  assert.equal(c.clicked.dateMax, TOMORROW, '(c) max moves to the new date');
  assert.equal(c.clicked.dateValue, '2025-03-05', '(c) the edit is kept');
}

/**
 * S3: two plants with the same name stay separate rows with their own ids,
 * and Water now changes only the one pressed.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkDuplicateNames(ctx) {
  const { page } = await openFresh(ctx);
  await h.addPlants(page, [
    { name: 'Fern', date: '2025-03-05' },
    { name: 'Fern', date: '2025-03-05' },
  ]);
  ctx.observed.sameNameButtons = await h.waterButton(page, 'Fern').count();
  // Both buttons are named "Water now: Fern", so the second is taken by
  // position.
  await page.locator('#plant-list button.plant__water').nth(1).click();
  const rows = await h.readRows(page);
  const raw = await h.readStored(page);
  Object.assign(ctx.observed, { rows, raw });
  await ctx.screenshot(page);

  const stored = parseStored(raw);
  const ids = stored.map((entry) => entry.id);
  assert.equal(ctx.observed.sameNameButtons, 2);
  assert.deepEqual(rowNames(rows), ['Fern', 'Fern']);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, 'each Fern has its own id');
  assert.deepEqual(rows.map((row) => row.id), ids, 'rows match storage');
  assert.deepEqual(rowDates(rows), ['Mar 5, 2025', 'Mar 6, 2025']);
  assert.deepEqual(
      stored.map((entry) => entry.lastWatered), ['2025-03-05', TODAY]);
}

/**
 * S4: Water now on a plant already watered today keeps its date and place
 * and shows no notice or field message.
 * @param {!Object} ctx The check context from runCheck.
 * @returns {!Promise<void>} Resolves when every assertion holds.
 */
async function checkWaterToday(ctx) {
  const { page } = await openFresh(ctx);
  await h.addPlants(page, [{ name: 'Monstera' }]);
  const added = await h.readRows(page);
  await h.waterButton(page, 'Monstera').click();
  const rows = await h.readRows(page);
  const notices = await h.readNotices(page);
  const fields = await h.readFields(page);
  Object.assign(ctx.observed, { added, rows, notices, fields });
  await ctx.screenshot(page);

  assert.equal(rows.length, 1, 'still one row');
  assert.equal(rows[0].id, added[0].id, 'the same plant at index 0');
  assert.equal(rows[0].name, 'Monstera');
  assert.equal(rows[0].dateText, 'Mar 6, 2025');
  assert.deepEqual(notices, [], 'no notice');
  for (const error of [fields.nameError, fields.dateError]) {
    assert.equal(error.hidden, true, 'no field message');
    assert.equal(error.text, '', 'no field message');
  }
}

// ===== Suite =====

/**
 * Every check, in run order. Each test name begins with the check id. A
 * check with `ownBrowser` runs in a browser launched for it alone; see
 * runInMatrix.
 * @const {!ReadonlyArray<{id: string, title: string,
 *     body: function(!Object): !Promise<void>,
 *     ownBrowser: (boolean|undefined)}>}
 */
const CHECKS = Object.freeze([
  {
    id: 'C01',
    title: 'first open shows the form, the empty state and today',
    body: checkFirstOpen,
  },
  {
    id: 'C02',
    title: 'adding a plant shows one row and clears Name',
    body: checkAddOne,
  },
  {
    id: 'C03',
    title: 'plants are listed and stored in insertion order',
    body: checkInsertionOrder,
  },
  {
    id: 'C04',
    title: 'a past date is shown and stored, then the field resets',
    body: checkPastDate,
  },
  {
    id: 'C05',
    title: 'Water now sets today without a reload and persists',
    body: checkWaterNow,
  },
  {
    id: 'C06',
    title: 'Water now never reorders rows or stored entries',
    body: checkStableOrder,
  },
  {
    id: 'C07',
    title: 'plants survive a reload, a second page and a relaunch',
    body: checkPersistence,
  },
  {
    id: 'C08',
    title: 'storage holds a JSON array of three-field records',
    body: checkStoredShape,
  },
  {
    id: 'C09',
    title: 'invalid input shows its message and adds nothing',
    body: checkRefusedSubmits,
  },
  {
    id: 'C10',
    title: 'corrupt or wrong-shape storage shows the unreadable notice',
    body: checkUnreadableStorage,
  },
  {
    id: 'C11',
    title: 'blocked storage works for the session with a notice',
    body: checkBlockedStorage,
  },
  {
    id: 'C12',
    title: 'the page requests only its own three files',
    body: checkNetwork,
    ownBrowser: true,
  },
  {
    id: 'C13',
    title: 'nothing overflows the viewport width',
    body: checkNoOverflow,
  },
  {
    id: 'C14',
    title: 'the keyboard alone reaches and activates every control',
    body: checkKeyboard,
  },
  {
    id: 'S1',
    title: 'a failed write keeps the change on screen only',
    body: checkWriteFailure,
  },
  {
    id: 'S2',
    title: 'a page left open past midnight uses the new date',
    body: checkPastMidnight,
  },
  {
    id: 'S3',
    title: 'duplicate names stay separate rows with their own ids',
    body: checkDuplicateNames,
  },
  {
    id: 'S4',
    title: 'Water now on a plant watered today changes nothing',
    body: checkWaterToday,
  },
]);

// One static server for the whole file, so the served origin stays fixed
// across every check, including C07's relaunch, and one shared browser for
// every check not flagged `ownBrowser`.
let browser;
let browserVersion = null;
let server;

/**
 * Runs one check in one run through harness.runCheck. A check flagged
 * `ownBrowser` gets a browser of its own, closed afterwards, while still
 * using the file's one server and origin. Chromium remembers, across every
 * context of a browser, that an origin's /favicon.ico failed and never
 * requests it again, so in the shared browser any earlier served check
 * would hide that request from C12.
 * @param {{id: string, body: function(!Object): !Promise<void>,
 *     ownBrowser: (boolean|undefined)}} check The check.
 * @param {!Object} run The run, from h.RUNS.
 * @returns {!Promise<void>} Resolves when the check passes.
 */
async function runInMatrix(check, run) {
  if (!check.ownBrowser) {
    await h.runCheck({ check: check.id, run, browser, server }, check.body);
    return;
  }
  const ownBrowser = await h.launchBrowser();
  try {
    await h.runCheck(
        { check: check.id, run, browser: ownBrowser, server }, check.body);
  } finally {
    await ownBrowser.close();
  }
}

before(async () => {
  h.resetEvidence();
  browser = await h.launchBrowser();
  browserVersion = browser.version();
  server = await h.startServer();
}, { timeout: TEST_TIMEOUT });

// Runs even when checks fail, so results.json is always written.
after(async () => {
  const closing = await Promise.allSettled([
    browser ? browser.close() : undefined,
    server ? server.close() : undefined,
  ]);
  h.writeResults({ chromium: browserVersion });
  const failed = closing.find((outcome) => outcome.status === 'rejected');
  if (failed) {
    throw failed.reason;
  }
}, { timeout: TEST_TIMEOUT });

for (const run of h.RUNS) {
  describe(run.name, () => {
    for (const check of CHECKS) {
      test(`${check.id} ${check.title}`, { timeout: TEST_TIMEOUT }, () =>
        runInMatrix(check, run));
    }
  });
}

