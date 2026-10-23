/**
 * @fileoverview Playwright harness for the browser checks in
 * criteria.test.js: the run matrix, Chromium launch, per-run contexts with a
 * fixed clock and time zone, storage seeding and faults, UI drivers and
 * readers, overflow and keyboard probes, and the evidence written to
 * tests/evidence/. It is a helper module, not a test file, so the
 * "browser/*.test.js" glob never runs it directly.
 *
 * Every check is wrapped in runCheck, which fails it on any page error or
 * console error or warning, guarantees a <check>.png per run, records one
 * results entry and closes every context it opened.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { startStaticServer } = require('../support/static-server.js');

/**
 * Loads the Playwright library API, turning a missing install into an
 * instruction.
 * @returns {!Object} The `playwright` module.
 */
function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      throw new Error(
          'Playwright is not installed: run `npm ci --prefix tests`, then ' +
          '`npx --prefix tests playwright install chromium`.',
          { cause: err });
    }
    throw err;
  }
}

const { chromium } = loadPlaywright();

// ===== Constants and paths =====

/**
 * The repository root, which holds index.html, styles.css and app.js.
 * Resolved from this file, so the working directory never matters.
 * @const {string}
 */
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Where screenshots, network logs and results.json are written; git-ignored
 * by tests/.gitignore.
 * @const {string}
 */
const EVIDENCE_DIR = path.resolve(__dirname, '..', 'evidence');

/**
 * The app's one storage key.
 * @const {string}
 */
const STORAGE_KEY = 'plant-parent.plants.v1';

/**
 * The time zone every context runs in.
 * @const {string}
 */
const TIMEZONE = 'America/Los_Angeles';

/**
 * The fixed browser clock. In Los Angeles it is local 2025-03-06 while the
 * UTC date is already 2025-03-07, so any UTC slip shows as "Mar 7, 2025".
 * @const {string}
 */
const DEFAULT_NOW = '2025-03-06T20:00:00-08:00';

/**
 * The local calendar date at DEFAULT_NOW.
 * @const {string}
 */
const TODAY = '2025-03-06';

/**
 * The run matrix: both run modes at both widths, in this order.
 * @const {!ReadonlyArray<{name: string, mode: string,
 *     viewport: {width: number, height: number}}>}
 */
const RUNS = Object.freeze([
  Object.freeze({
    name: 'file-360',
    mode: 'file',
    viewport: Object.freeze({ width: 360, height: 740 }),
  }),
  Object.freeze({
    name: 'file-1280',
    mode: 'file',
    viewport: Object.freeze({ width: 1280, height: 800 }),
  }),
  Object.freeze({
    name: 'served-360',
    mode: 'served',
    viewport: Object.freeze({ width: 360, height: 740 }),
  }),
  Object.freeze({
    name: 'served-1280',
    mode: 'served',
    viewport: Object.freeze({ width: 1280, height: 800 }),
  }),
]);

/**
 * The page texts the checks expect, written out literally. This is a
 * test-side oracle and is deliberately not read from app.js, so a changed
 * message in the app fails the checks instead of moving the oracle with it.
 * @const {!Readonly<!Object<string, string>>}
 */
const TEXT = Object.freeze({
  nameRequired: 'Enter a plant name',
  nameTooLong: 'Name must be 80 characters or fewer',
  dateRequired: 'Enter a date',
  dateInFuture: 'Date cannot be in the future',
  storageUnavailable:
      'Storage is unavailable, so plants will not be kept after this page ' +
      'is closed.',
  storageUnreadable: 'Some saved data could not be read.',
  saveFailed:
      'Could not save your last change. It will be lost when this page is ' +
      'closed.',
  emptyState: 'No plants yet. Add your first plant above.',
  waterNow: 'Water now',
  waterNowPrefix: 'Water now: ',
  addPlant: 'Add plant',
  lastWateredPrefix: 'Last watered ',
});

/** The page's own files, the only requests the network contract allows. */
const APP_FILES = Object.freeze(['index.html', 'styles.css', 'app.js']);

// ===== Browser, server, URLs =====

/**
 * Launches headless Chromium. The test file calls it once.
 * @returns {!Promise<!Object>} The Playwright Browser.
 */
function launchBrowser() {
  return chromium.launch();
}

/**
 * Starts the static server on the repository root. Called once per test
 * file, so the bound port, and with it the served origin, stays fixed for
 * the whole file; C07's relaunch relies on that.
 * @returns {!Promise<{url: string, requests: !Array<string>,
 *     close: function(): !Promise<void>}>} The running server.
 */
function startServer() {
  return startStaticServer({ root: ROOT });
}

/**
 * Builds the URL of one of the page's own files for a run.
 * @param {{mode: string}} run The run.
 * @param {?{url: string}|undefined} server The static server; required in
 *     served mode.
 * @param {string} name A file name directly in the repository root.
 * @returns {string} A file: URL in file mode, or the server's URL.
 */
function fileUrl(run, server, name) {
  if (run.mode === 'file') {
    return pathToFileURL(path.join(ROOT, name)).href;
  }
  if (run.mode === 'served') {
    if (!server || typeof server.url !== 'string') {
      throw new TypeError(`Run ${run.name} is served but has no server`);
    }
    return `${server.url}/${name}`;
  }
  throw new TypeError(`Unknown run mode: ${run.mode}`);
}

/**
 * The page URL a run opens.
 * @param {{name: string, mode: string}} run The run.
 * @param {?{url: string}=} server The static server; required in served
 *     mode.
 * @returns {string} The file: URL of index.html, or `<server>/index.html`.
 */
function pageUrl(run, server) {
  return fileUrl(run, server, 'index.html');
}

/**
 * The three request URLs the network contract allows for a run, in load
 * order.
 * @param {{name: string, mode: string}} run The run.
 * @param {?{url: string}=} server The static server; required in served
 *     mode.
 * @returns {!Array<string>} The URLs of index.html, styles.css and app.js.
 */
function expectedFiles(run, server) {
  return APP_FILES.map((name) => fileUrl(run, server, name));
}

// ===== Sessions, clock, failure listeners, network log =====

/**
 * Records every uncaught page error and every console error or warning;
 * any entry fails the check.
 * @param {!Object} page A Playwright Page.
 * @param {!Array<{type: string, text: string}>} failures Receives one entry
 *     per failure.
 */
function attachFailureListeners(page, failures) {
  page.on('pageerror', (err) => {
    failures.push({ type: 'pageerror', text: err.message });
  });
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      failures.push({ type, text: msg.text() });
    }
  });
}

/**
 * Logs every request the context makes, tagged with the session's current
 * phase label at the moment it is issued.
 * @param {!Object} context A Playwright BrowserContext.
 * @param {{network: !Array<!Object>, phase: string}} session The session
 *     whose log and phase are used.
 */
function attachNetworkLog(context, session) {
  context.on('request', (request) => {
    session.network.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      phase: session.phase,
    });
  });
}

/**
 * Opens a page in the session's current context with the failure listeners
 * attached, and navigates it to the session URL. `goto` waits for `load`,
 * by which time the deferred app.js has run.
 * @param {{context: !Object, url: string, failures: !Array<!Object>,
 *     pages: !Array<!Object>}} session The session.
 * @returns {!Promise<!Object>} The loaded Playwright Page.
 */
async function openSessionPage(session) {
  const page = await session.context.newPage();
  attachFailureListeners(page, session.failures);
  session.pages.push(page);
  await page.goto(session.url);
  return page;
}

/**
 * Creates a fresh, isolated context for one check, with the run's viewport,
 * the fixed time zone and clock and, optionally, blocked storage, all in
 * place before any page opens. A fresh context starts with empty storage.
 * @param {!Object} browser A Playwright Browser.
 * @param {{name: string, mode: string,
 *     viewport: {width: number, height: number}}} run The run.
 * @param {string} url The page URL to open.
 * @param {{now: (string|undefined), block: (boolean|undefined)}=} options
 *     `now` is the fixed clock as an ISO string, DEFAULT_NOW by default;
 *     `block` makes every read of window.localStorage throw.
 * @returns {!Promise<!Object>} The session: `context`, `run`, `url`,
 *     `failures`, `network`, `pages`, the mutable `phase` label ('load' by
 *     default) that tags each logged request, `openPage()` and an
 *     idempotent `close()`.
 */
async function createSession(
    browser, run, url, { now = DEFAULT_NOW, block = false } = {}) {
  const context = await browser.newContext({
    viewport: run.viewport,
    timezoneId: TIMEZONE,
  });
  let closed = false;
  const session = {
    context,
    run,
    url,
    failures: [],
    network: [],
    pages: [],
    phase: 'load',
    persistent: false,
    openPage: () => openSessionPage(session),
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await context.close();
    },
  };
  try {
    await context.clock.setFixedTime(new Date(now));
    if (block) {
      await blockStorage(context);
    }
    attachNetworkLog(context, session);
  } catch (err) {
    await session.close();
    throw err;
  }
  return session;
}

/**
 * Launches Chromium on a persistent profile with the run's viewport, the
 * fixed time zone and clock, and the session's network log.
 * @param {string} profileDir The profile directory.
 * @param {{viewport: {width: number, height: number}}} run The run.
 * @param {string} now The fixed clock as an ISO string.
 * @param {!Object} session The session whose network log is attached.
 * @returns {!Promise<!Object>} The persistent BrowserContext.
 */
async function launchPersistent(profileDir, run, now, session) {
  const context = await chromium.launchPersistentContext(profileDir, {
    viewport: run.viewport,
    timezoneId: TIMEZONE,
  });
  try {
    await context.clock.setFixedTime(new Date(now));
    attachNetworkLog(context, session);
  } catch (err) {
    await context.close();
    throw err;
  }
  return context;
}

/**
 * Creates a session on a persistent Chromium profile in a fresh temporary
 * directory, so storage survives closing and relaunching the browser (C07).
 * Pages are always opened with `openPage()`, never the launch's default
 * about:blank page, so the clock and listeners certainly apply.
 * @param {{name: string, mode: string,
 *     viewport: {width: number, height: number}}} run The run.
 * @param {string} url The page URL to open.
 * @param {{now: (string|undefined)}=} options `now` is the fixed clock as
 *     an ISO string, DEFAULT_NOW by default; it is re-applied on relaunch.
 * @returns {!Promise<!Object>} The session: the same shape as
 *     createSession's, plus `profileDir` and `relaunch()`, which closes the
 *     browser gracefully (flushing storage to disk) and launches it again on
 *     the same profile with the same options. `context` always points at
 *     the current context. `close()` is idempotent and removes the profile.
 */
async function createPersistentSession(run, url, { now = DEFAULT_NOW } = {}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plant-parent-'));
  let closed = false;
  const session = {
    context: null,
    run,
    url,
    profileDir,
    failures: [],
    network: [],
    pages: [],
    phase: 'load',
    persistent: true,
    openPage: () => openSessionPage(session),
    relaunch: async () => {
      const previous = session.context;
      session.context = null;
      if (previous) {
        await previous.close();
      }
      session.context = await launchPersistent(profileDir, run, now, session);
    },
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        if (session.context) {
          await session.context.close();
        }
      } finally {
        session.context = null;
        fs.rmSync(profileDir, { recursive: true, force: true });
      }
    },
  };
  try {
    session.context = await launchPersistent(profileDir, run, now, session);
  } catch (err) {
    await session.close();
    throw err;
  }
  return session;
}

/**
 * Moves the session's fixed browser clock. It dispatches no event, so no
 * `focus` or `visibilitychange` fires (S2).
 * @param {{context: !Object}} session The session.
 * @param {string} iso The new time as an ISO string.
 * @returns {!Promise<void>} Resolves once the clock has moved.
 */
function setClock(session, iso) {
  return session.context.clock.setFixedTime(new Date(iso));
}

// ===== Storage fixtures and faults =====

/**
 * Writes a raw string to the storage key on the already-open page, then
 * reloads, so the app loads it as saved data.
 * @param {!Object} page A loaded Playwright Page.
 * @param {string} raw The exact value to store.
 * @returns {!Promise<void>} Resolves once the reloaded page has loaded.
 */
async function seedRaw(page, raw) {
  await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      [STORAGE_KEY, raw]);
  await page.reload();
}

/**
 * Seeds plant records as JSON and reloads.
 * @param {!Object} page A loaded Playwright Page.
 * @param {*} records The value to store, usually an array of records.
 * @returns {!Promise<string>} The exact string stored, for raw comparisons.
 */
async function seedPlants(page, records) {
  const raw = JSON.stringify(records);
  await seedRaw(page, raw);
  return raw;
}

/**
 * Reads the raw stored value. Never call it in a blocked-storage context.
 * @param {!Object} page A loaded Playwright Page.
 * @returns {!Promise<?string>} The stored string, or null when the key is
 *     absent.
 */
function readStored(page) {
  return page.evaluate(
      (key) => window.localStorage.getItem(key), STORAGE_KEY);
}

/**
 * Makes every read of window.localStorage throw a SecurityError in every
 * page of the context, before any page script runs, as a browser that
 * blocks site data does.
 * @param {!Object} context A Playwright BrowserContext with no page yet.
 * @returns {!Promise<void>} Resolves once the init script is registered.
 */
async function blockStorage(context) {
  await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied', 'SecurityError');
      },
    });
  });
}

/**
 * Makes every storage write in the current document throw a
 * QuotaExceededError. It lasts only for this document, so a reload restores
 * working writes (S1).
 * @param {!Object} page A loaded Playwright Page.
 * @returns {!Promise<void>} Resolves once writes fail.
 */
async function failWrites(page) {
  await page.evaluate(() => {
    Storage.prototype.setItem = function() {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
  });
}

// ===== UI drivers and readers =====

/** Selector for the rendered plant rows, in list order. */
const ROW_SELECTOR = '#plant-list > li.plant';

/**
 * The Add plant button, found by its exact accessible name.
 * @param {!Object} page A Playwright Page.
 * @returns {!Object} A Playwright Locator.
 */
function addPlantButton(page) {
  return page.getByRole('button', { name: TEXT.addPlant, exact: true });
}

/**
 * Adds plants through the form, one at a time. Each add must append
 * exactly one row, so a refused add fails here rather than in a later
 * assertion.
 * @param {!Object} page A loaded Playwright Page.
 * @param {!Array<{name: string, date: (string|undefined)}>} items The
 *     plants. `date` is filled as `YYYY-MM-DD` (or '') when given, which
 *     marks the date as edited; otherwise the field keeps today's default.
 * @returns {!Promise<void>} Resolves once every plant is listed.
 */
async function addPlants(page, items) {
  const rows = page.locator(ROW_SELECTOR);
  for (const { name, date } of items) {
    const before = await rows.count();
    await page.fill('#plant-name', name);
    if (date !== undefined) {
      await page.fill('#last-watered', date);
    }
    await addPlantButton(page).click();
    const after = await rows.count();
    if (after !== before + 1) {
      const fields = await readFields(page);
      assert.fail(
          `Adding ${JSON.stringify(name)} with date ` +
          `${JSON.stringify(date)} changed the row count from ${before} ` +
          `to ${after}; name error ${JSON.stringify(fields.nameError.text)},` +
          ` date error ${JSON.stringify(fields.dateError.text)}`);
    }
  }
}

/**
 * Clicks Add plant with no expectation about the outcome, for refused
 * submits.
 * @param {!Object} page A loaded Playwright Page.
 * @returns {!Promise<void>} Resolves once the click is done.
 */
async function submitForm(page) {
  await addPlantButton(page).click();
}

/**
 * Reads every rendered row in DOM order. A missing part reads as null.
 * @param {!Object} page A loaded Playwright Page.
 * @returns {!Promise<!Array<{id: ?string, name: ?string, dateLine: ?string,
 *     dateText: ?string, datetime: ?string, buttonText: ?string,
 *     ariaLabel: ?string}>>} One entry per row. `id` is the button's
 *     data-plant-id; `dateLine` is the whitespace-normalised date line, such
 *     as "Last watered Mar 6, 2025"; `dateText` and `datetime` come from its
 *     <time> element.
 */
function readRows(page) {
  return page.locator(ROW_SELECTOR).evaluateAll((rows) => rows.map((row) => {
    const name = row.querySelector('.plant__name');
    const date = row.querySelector('.plant__date');
    const time = row.querySelector('.plant__date time');
    const button = row.querySelector('button.plant__water');
    return {
      id: button ? button.getAttribute('data-plant-id') : null,
      name: name ? name.textContent : null,
      dateLine: date ? date.textContent.replace(/\s+/g, ' ').trim() : null,
      dateText: time ? time.textContent : null,
      datetime: time ? time.getAttribute('datetime') : null,
      buttonText: button ? button.textContent.trim() : null,
      ariaLabel: button ? button.getAttribute('aria-label') : null,
    };
  }));
}

/**
 * Reads the notices in the status region, in display order.
 * @param {!Object} page A loaded Playwright Page.
 * @returns {!Promise<!Array<{text: string, error: boolean, key: ?string}>>}
 *     `error` is whether the notice carries the notice--error class; `key`
 *     is its data-notice-key, or null where the app sets none.
 */
function readNotices(page) {
  return page.locator('#notices > p.notice').evaluateAll(
      (notices) => notices.map((notice) => ({
        text: notice.textContent,
        error: notice.classList.contains('notice--error'),
        key: notice.dataset.noticeKey ?? null,
      })));
}

/**
 * Reads the form fields, their inline messages and the list and empty-state
 * visibility.
 * @param {!Object} page A loaded Playwright Page.
 * @returns {!Promise<{nameValue: string, dateValue: string, dateMax: string,
 *     nameError: !Object, dateError: !Object, formVisible: boolean,
 *     listHidden: boolean, emptyHidden: boolean, emptyText: string}>} Each
 *     error is `{text, hidden, inputInvalid, describedBy}`, the last two
 *     being the input's aria-invalid and aria-describedby attributes or
 *     null. `listHidden` and `emptyHidden` are the elements' `hidden`
 *     properties; `formVisible` is the form's rendered visibility.
 */
function readFields(page) {
  return page.evaluate(() => {
    const byId = (id) => document.getElementById(id);
    const errorOf = (input, element) => ({
      text: element.textContent,
      hidden: element.hidden,
      inputInvalid: input.getAttribute('aria-invalid'),
      describedBy: input.getAttribute('aria-describedby'),
    });
    const nameInput = byId('plant-name');
    const dateInput = byId('last-watered');
    const emptyState = byId('empty-state');
    return {
      nameValue: nameInput.value,
      dateValue: dateInput.value,
      dateMax: dateInput.max,
      nameError: errorOf(nameInput, byId('plant-name-error')),
      dateError: errorOf(dateInput, byId('last-watered-error')),
      formVisible: byId('add-plant-form').checkVisibility(),
      listHidden: byId('plant-list').hidden,
      emptyHidden: emptyState.hidden,
      emptyText: emptyState.textContent,
    };
  });
}

/**
 * A plant's Water now button, found by its exact accessible name.
 * @param {!Object} page A Playwright Page.
 * @param {string} name The plant name.
 * @returns {!Object} A Playwright Locator for "Water now: <name>".
 */
function waterButton(page, name) {
  return page.getByRole(
      'button', { name: TEXT.waterNowPrefix + name, exact: true });
}

// ===== Overflow, keyboard, focus outline =====

/**
 * Measures horizontal overflow: the document's scroll width against its
 * client width, and every row, button, input, notice and field message
 * against the viewport. Hidden elements have zero rects at 0 and pass.
 * @param {!Object} page A loaded Playwright Page.
 * @returns {!Promise<{scrollWidth: number, clientWidth: number,
 *     innerWidth: number, offenders: !Array<{element: string,
 *     rect: !Object}>}>} The check passes when `scrollWidth <= clientWidth`
 *     and `offenders` is empty.
 */
function measureOverflow(page) {
  return page.evaluate(() => {
    const describe = (element) => {
      const tag = element.tagName.toLowerCase();
      if (element.id) {
        return `${tag}#${element.id}`;
      }
      const classes = Array.from(element.classList).join('.');
      return classes ? `${tag}.${classes}` : tag;
    };
    const selector = '.plant, button, input, .notice, .field-error';
    const offenders = [];
    for (const element of document.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect();
      if (rect.left < 0 || rect.right > window.innerWidth) {
        offenders.push({
          element: describe(element),
          rect: {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
        });
      }
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      innerWidth: window.innerWidth,
      offenders,
    };
  });
}

/**
 * Describes the focused element stably.
 * @param {!Object} page A loaded Playwright Page.
 * @returns {!Promise<string>} '#<id>' for an element with an id,
 *     'water:<data-plant-id>' for a Water now button, 'button:<text>' for
 *     another button (such as 'button:Add plant'), and 'body' otherwise.
 */
function activeElement(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element) {
      return 'body';
    }
    if (element.id) {
      return `#${element.id}`;
    }
    if (element.matches('button[data-plant-id]')) {
      return `water:${element.getAttribute('data-plant-id')}`;
    }
    if (element.tagName === 'BUTTON') {
      return `button:${element.textContent.trim()}`;
    }
    return 'body';
  });
}

/**
 * Presses one key and records where focus lands.
 * @param {!Object} page A loaded Playwright Page.
 * @param {string} key A Playwright key, such as 'Tab', 'Shift+Tab', 'Enter'
 *     or 'Space'.
 * @param {!Array<string>} log Receives the focused element's descriptor.
 * @returns {!Promise<string>} The descriptor, as from activeElement.
 */
async function pressAndRecord(page, key, log) {
  await page.keyboard.press(key);
  const active = await activeElement(page);
  log.push(active);
  return active;
}

/**
 * Collapses consecutive duplicates. Chromium stops several times inside a
 * date input, so checks compare the order of distinct elements, never press
 * counts.
 * @param {!Array<T>} list The sequence.
 * @returns {!Array<T>} The sequence with each run of equal items kept once.
 * @template T
 */
function distinct(list) {
  return list.filter((item, index) => index === 0 || item !== list[index - 1]);
}

/**
 * Reads the focused element's computed outline.
 * @param {!Object} page A loaded Playwright Page.
 * @returns {!Promise<{outlineStyle: string, outlineWidth: string}>} The
 *     computed `outline-style` and `outline-width`.
 */
function focusOutline(page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
}

// ===== Evidence and results =====

/**
 * Every recorded check result, in completion order; writeResults writes it.
 * @const {!Array<{check: string, run: string, observed: !Object,
 *     pass: boolean, error: ?string}>}
 */
const results = [];

/**
 * Empties tests/evidence/ and the in-memory results, so the evidence
 * reflects only the current run. The test file calls it once, first.
 * @returns {string} The evidence directory.
 */
function resetEvidence() {
  fs.rmSync(EVIDENCE_DIR, { recursive: true, force: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  results.length = 0;
  return EVIDENCE_DIR;
}

/**
 * Creates a run's evidence folder if needed.
 * @param {{name: string}} run The run.
 * @returns {string} The absolute path of tests/evidence/<run>/.
 */
function runDir(run) {
  const dir = path.join(EVIDENCE_DIR, run.name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Saves a screenshot as tests/evidence/<run>/<check>.png, or
 * <check>-<suffix>.png for a sub-case.
 * @param {!Object} page A Playwright Page.
 * @param {{name: string}} run The run.
 * @param {string} check The check id, such as 'C01'.
 * @param {{suffix: (string|undefined), fullPage: (boolean|undefined)}=}
 *     options `suffix` names a sub-case; `fullPage` captures the whole page
 *     instead of the viewport.
 * @returns {!Promise<string>} The screenshot's absolute path.
 */
async function takeScreenshot(
    page, run, check, { suffix, fullPage = false } = {}) {
  const name = suffix ? `${check}-${suffix}.png` : `${check}.png`;
  const file = path.join(runDir(run), name);
  await page.screenshot({ path: file, fullPage });
  return file;
}

/**
 * Writes a run's network log as tests/evidence/<run>/network.json.
 * @param {{name: string}} run The run.
 * @param {*} data Any JSON-serialisable value.
 * @returns {string} The file's absolute path.
 */
function writeNetworkLog(run, data) {
  const file = path.join(runDir(run), 'network.json');
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

/**
 * Records one check's outcome for one run.
 * @param {{check: string, run: {name: string}, observed: !Object,
 *     pass: boolean, error: (?string|undefined)}} result The outcome;
 *     `error` is the failure message, absent or null on a pass.
 * @returns {{check: string, run: string, observed: !Object, pass: boolean,
 *     error: ?string}} The entry added to `results`.
 */
function recordResult({ check, run, observed, pass, error }) {
  const entry = { check, run: run.name, observed, pass, error: error ?? null };
  results.push(entry);
  return entry;
}

/**
 * Writes tests/evidence/results.json from the recorded results. Its
 * timestamp is Node's real clock; only the browser's clock is fixed.
 * @param {!Object=} meta Extra top-level fields, such as `{chromium}`.
 * @returns {string} The file's absolute path.
 */
function writeResults(meta = {}) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, 'results.json');
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    ...meta,
    results,
  };
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

/**
 * Finds the page the fallback screenshot should show: the page last passed
 * to ctx.screenshot while it is still open, otherwise the most recently
 * opened page still open, newest session first.
 * @param {{lastPage: ?Object, sessions: !Array<{pages: !Array<!Object>}>}}
 *     ctx The check context.
 * @returns {?Object} An open Playwright Page, or null when none is open.
 */
function lastOpenPage(ctx) {
  if (ctx.lastPage && !ctx.lastPage.isClosed()) {
    return ctx.lastPage;
  }
  for (const session of [...ctx.sessions].reverse()) {
    const page = [...session.pages].reverse().find((p) => !p.isClosed());
    if (page) {
      return page;
    }
  }
  return null;
}

/**
 * Writes <check>.png from the last open page unless the check already wrote
 * it. The fallback captures the full page, so rows below the fold are part
 * of the evidence.
 * @param {!Object} ctx The check context.
 * @returns {!Promise<void>} Resolves once <check>.png exists; rejects when
 *     no page is open to capture.
 */
async function ensureCheckScreenshot(ctx) {
  if (ctx.mainScreenshot) {
    return;
  }
  const page = lastOpenPage(ctx);
  if (page === null) {
    throw new Error(
        `${ctx.check} ${ctx.run.name}: no open page for ${ctx.check}.png`);
  }
  await takeScreenshot(page, ctx.run, ctx.check, { fullPage: true });
  ctx.mainScreenshot = true;
}

/**
 * Lists every page error and console error or warning from a check's
 * sessions.
 * @param {{sessions: !Array<{failures: !Array<!Object>}>}} ctx The check
 *     context.
 * @returns {!Array<{type: string, text: string}>} The failures, session by
 *     session.
 */
function collectFailures(ctx) {
  return ctx.sessions.flatMap((session) => session.failures);
}

/**
 * Closes every session a check opened, attempting each even when one fails.
 * Persistent sessions also remove their profile directory.
 * @param {{sessions: !Array<{close: function(): !Promise<void>}>}} ctx The
 *     check context.
 * @returns {!Promise<?Error>} The first close error, or null.
 */
async function closeSessions(ctx) {
  let firstError = null;
  for (const session of ctx.sessions) {
    try {
      await session.close();
    } catch (err) {
      firstError = firstError ?? err;
    }
  }
  return firstError;
}

/**
 * Runs one check for one run. The body gets a context whose sessions are
 * tracked and closed afterwards. The check fails on any thrown error, on any
 * page error or console error or warning in its sessions, when no
 * <check>.png can be written, or when a session fails to close (which would
 * leave a browser or profile behind). Either way one results entry is
 * recorded, after the sessions are closed.
 * @param {{check: string, run: {name: string, mode: string,
 *     viewport: {width: number, height: number}}, browser: !Object,
 *     server: ?Object}} spec The check id, the run, the shared browser and
 *     the shared static server.
 * @param {function(!Object): !Promise<void>} body The check. Its argument
 *     holds `check`, `run`, `url`, `server`, `observed` (the evidence object
 *     recorded in results.json), `sessions`, `newSession(options)`,
 *     `newPersistentSession(options)` and `screenshot(page, options)`.
 * @returns {!Promise<void>} Resolves when the check passes; rejects with
 *     the check's error otherwise.
 */
async function runCheck({ check, run, browser, server }, body) {
  const ctx = {
    check,
    run,
    url: pageUrl(run, server),
    server,
    observed: {},
    sessions: [],
    lastPage: null,
    mainScreenshot: false,
    newSession: async (options) => {
      const session = await createSession(browser, run, ctx.url, options);
      ctx.sessions.push(session);
      return session;
    },
    newPersistentSession: async (options) => {
      const session = await createPersistentSession(run, ctx.url, options);
      ctx.sessions.push(session);
      return session;
    },
    screenshot: async (page, options = {}) => {
      ctx.lastPage = page;
      const file = await takeScreenshot(page, run, check, options);
      if (!options.suffix) {
        ctx.mainScreenshot = true;
      }
      return file;
    },
  };
  let failure = null;
  try {
    await body(ctx);
    ctx.observed.failures = collectFailures(ctx);
    assert.deepEqual(
        ctx.observed.failures, [],
        `${check} ${run.name}: the page reported errors or warnings`);
    await ensureCheckScreenshot(ctx);
  } catch (err) {
    failure = err;
    ctx.observed.failures = collectFailures(ctx);
    try {
      await ensureCheckScreenshot(ctx);
    } catch {
      // Best effort: the check's own error is the one to report.
    }
  } finally {
    const closeError = await closeSessions(ctx);
    failure = failure ?? closeError;
  }
  if (failure !== null) {
    recordResult({
      check,
      run,
      observed: ctx.observed,
      pass: false,
      error: failure instanceof Error ? failure.message : String(failure),
    });
    throw failure;
  }
  recordResult({ check, run, observed: ctx.observed, pass: true });
}

module.exports = {
  ROOT,
  EVIDENCE_DIR,
  STORAGE_KEY,
  TIMEZONE,
  DEFAULT_NOW,
  TODAY,
  RUNS,
  TEXT,
  launchBrowser,
  startServer,
  pageUrl,
  expectedFiles,
  attachFailureListeners,
  createSession,
  createPersistentSession,
  setClock,
  seedRaw,
  seedPlants,
  readStored,
  blockStorage,
  failWrites,
  addPlants,
  submitForm,
  readRows,
  readNotices,
  readFields,
  waterButton,
  measureOverflow,
  activeElement,
  pressAndRecord,
  distinct,
  focusOutline,
  resetEvidence,
  runDir,
  takeScreenshot,
  writeNetworkLog,
  results,
  recordResult,
  writeResults,
  runCheck,
};
