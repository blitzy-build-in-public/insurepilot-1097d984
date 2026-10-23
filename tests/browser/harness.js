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

/**
 * Options for every Chromium launch, regular and persistent. The 'chromium'
 * channel runs Playwright's full Chromium build in its new headless mode
 * rather than the default chromium-headless-shell. The shell never fetches
 * /favicon.ico, so served-mode C12 could not observe the request the inline
 * data: icon exists to prevent; the full build requests it when that icon
 * is missing. The full build also creates a singleton socket under TMPDIR,
 * and a Unix socket path is limited to about 107 bytes, so a TMPDIR longer
 * than about 60 characters aborts the launch with "Socket path too long".
 * @const {!Readonly<{channel: string}>}
 */
const LAUNCH_OPTIONS = Object.freeze({ channel: 'chromium' });

// ===== Browser, server, URLs =====

/**
 * Launches headless Chromium with LAUNCH_OPTIONS. The test file launches one
 * shared browser in its `before` hook and one dedicated browser per run of a
 * check flagged `ownBrowser` (C12), so earlier served checks cannot hide
 * C12's /favicon.ico request.
 * @returns {!Promise<!Object>} The Playwright Browser.
 */
function launchBrowser() {
  return chromium.launch(LAUNCH_OPTIONS);
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
 * Names a value in an error message without serialising it: a string is
 * shown quoted, anything else by its type.
 * @param {*} value The value.
 * @returns {string} The description.
 */
function describeValue(value) {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  return value === null ? 'null' : typeof value;
}

/**
 * Finds the RUNS entry a run spec names and checks the spec agrees with it
 * in mode and in both viewport dimensions, so no evidence can carry one
 * run's label while the page ran in another mode or size.
 * @param {*} run The run spec, normally an entry of RUNS.
 * @returns {{name: string, mode: string,
 *     viewport: {width: number, height: number}}} The frozen RUNS entry,
 *     whose viewport is the one every context uses.
 * @throws {TypeError} When `run` is not an object, its `name` is not a
 *     RUNS name, or its `mode` or `viewport` differs from that entry's.
 */
function canonicalRun(run) {
  if (run === null || typeof run !== 'object') {
    throw new TypeError(
        `A run must be a RUNS entry, not ${describeValue(run)}`);
  }
  const entry = RUNS.find((candidate) => candidate.name === run.name);
  if (entry === undefined) {
    throw new TypeError(
        `Unknown run name ${describeValue(run.name)}; expected one of ` +
        `${RUNS.map((candidate) => candidate.name).join(', ')}`);
  }
  if (run.mode !== entry.mode) {
    throw new TypeError(
        `Run ${entry.name} must have mode '${entry.mode}', not ` +
        `${describeValue(run.mode)}`);
  }
  const { width, height } = entry.viewport;
  const viewport = run.viewport;
  if (viewport === null || typeof viewport !== 'object' ||
      viewport.width !== width || viewport.height !== height) {
    throw new TypeError(
        `Run ${entry.name} must have viewport ${width}x${height}`);
  }
  return entry;
}

/**
 * The hostnames, as URL parses them, of the loopback addresses a served
 * run may use: startStaticServer's default 127.0.0.1, and ::1, which it
 * reports bracketed.
 * @const {!ReadonlyArray<string>}
 */
const LOOPBACK_HOSTNAMES = Object.freeze(['127.0.0.1', '[::1]']);

/**
 * Checks that a served base is a static-server origin on this machine,
 * exactly as startStaticServer reports it: `http://<loopback>:<port>` with
 * no credentials, path, trailing slash, query or fragment.
 * @param {*} base The server's `url`.
 * @returns {string} The base, unchanged.
 * @throws {TypeError} When `base` is not such an origin.
 */
function servedOrigin(base) {
  const parsed =
      typeof base === 'string' && URL.canParse(base) ? new URL(base) : null;
  if (parsed === null || parsed.protocol !== 'http:' ||
      !LOOPBACK_HOSTNAMES.includes(parsed.hostname) || parsed.port === '' ||
      parsed.username !== '' || parsed.password !== '' ||
      parsed.origin !== base) {
    throw new TypeError(
        'A served base must be http://127.0.0.1:<port> or ' +
        'http://[::1]:<port> with nothing after the port, not ' +
        `${describeValue(base)}`);
  }
  return base;
}

/**
 * Builds the URL of one of the page's own files for a run.
 * @param {{name: string, mode: string,
 *     viewport: {width: number, height: number}}} run The run: an entry of
 *     RUNS, or a spec equal to one.
 * @param {?{url: string}|undefined} server The static server; required in
 *     served mode, where its `url` must pass servedOrigin. Ignored in file
 *     mode.
 * @param {string} name One of APP_FILES.
 * @returns {string} A file: URL in file mode, or `<server url>/<name>`.
 * @throws {TypeError} When the run is invalid, `name` is not one of the
 *     page's own files, or a served run has no valid server.
 */
function fileUrl(run, server, name) {
  const entry = canonicalRun(run);
  if (!APP_FILES.includes(name)) {
    throw new TypeError(
        `Not one of the page's own files: ${describeValue(name)}`);
  }
  if (entry.mode === 'file') {
    return pathToFileURL(path.join(ROOT, name)).href;
  }
  if (!server || typeof server.url !== 'string') {
    throw new TypeError(`Run ${entry.name} is served but has no server`);
  }
  return `${servedOrigin(server.url)}/${name}`;
}

/**
 * The page URL a run opens.
 * @param {{name: string, mode: string,
 *     viewport: {width: number, height: number}}} run The run: an entry of
 *     RUNS, or a spec equal to one.
 * @param {?{url: string}=} server The static server; required in served
 *     mode, where its `url` must pass servedOrigin.
 * @returns {string} The file: URL of index.html, or `<server>/index.html`.
 * @throws {TypeError} When the run or a served run's server is invalid.
 */
function pageUrl(run, server) {
  return fileUrl(run, server, 'index.html');
}

/**
 * The three request URLs the network contract allows for a run, in load
 * order.
 * @param {{name: string, mode: string,
 *     viewport: {width: number, height: number}}} run The run: an entry of
 *     RUNS, or a spec equal to one.
 * @param {?{url: string}=} server The static server; required in served
 *     mode, where its `url` must pass servedOrigin.
 * @returns {!Array<string>} The URLs of index.html, styles.css and app.js.
 * @throws {TypeError} When the run or a served run's server is invalid.
 */
function expectedFiles(run, server) {
  return APP_FILES.map((name) => fileUrl(run, server, name));
}

/**
 * Checks a session's run and page URL before anything is allocated for
 * it. The run must be a RUNS spec, and the URL exactly the page that run
 * opens: index.html's file: URL in file mode, or `<origin>/index.html` on
 * a loopback static-server origin that passes servedOrigin in served mode.
 * @param {*} run The run spec.
 * @param {*} url The page URL.
 * @returns {{name: string, mode: string,
 *     viewport: {width: number, height: number}}} The frozen RUNS entry.
 * @throws {TypeError} When the run is invalid or the URL is not its page.
 */
function sessionRun(run, url) {
  const entry = canonicalRun(run);
  if (typeof url !== 'string' || !URL.canParse(url)) {
    throw new TypeError(
        `Run ${entry.name}: page URL ${describeValue(url)} is not a URL`);
  }
  const server =
      entry.mode === 'served' ? { url: new URL(url).origin } : null;
  const expected = pageUrl(entry, server);
  if (url !== expected) {
    throw new TypeError(
        `Run ${entry.name} must open ${expected}, not ${describeValue(url)}`);
  }
  return entry;
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
 * Contexts whose Playwright `close` event has fired, which happens only once
 * the browser has really shut the context down or has exited.
 * @type {!WeakSet<!Object>}
 */
const closedContexts = new WeakSet();

/**
 * Starts tracking a new context's `close` event, so closeContext can confirm
 * its shutdown. Called as soon as the context exists.
 * @param {!Object} context A Playwright BrowserContext.
 */
function watchContextClose(context) {
  context.once('close', () => {
    closedContexts.add(context);
  });
}

/**
 * Closes a context and confirms that it really closed. After a close attempt
 * has failed part-way, Playwright's `context.close()` resolves at once
 * without closing anything, so a resolved close counts only when the
 * context's `close` event has fired as well.
 * @param {!Object} context A Playwright BrowserContext that was passed to
 *     watchContextClose when it was created.
 * @returns {!Promise<void>} Resolves once the context is closed; rejects
 *     when the close fails or is unconfirmed, and the caller keeps the
 *     context.
 */
async function closeContext(context) {
  await context.close();
  if (!closedContexts.has(context)) {
    throw new Error(
        'The browser context did not confirm that it closed, so it may ' +
        'still be running');
  }
}

/**
 * Creates a fresh, isolated context for one check, with the run's viewport,
 * the fixed time zone and clock and, optionally, blocked storage, all in
 * place before any page opens. A fresh context starts with empty storage.
 * @param {!Object} browser A Playwright Browser.
 * @param {{name: string, mode: string,
 *     viewport: {width: number, height: number}}} run The run: an entry of
 *     RUNS, or a spec equal to one in name, mode and viewport, whose
 *     viewport the context gets. Any other value rejects with a TypeError
 *     before a context opens.
 * @param {string} url The page URL to open: exactly the run's pageUrl,
 *     index.html's file: URL in file mode or `<loopback origin>/index.html`
 *     in served mode. Any other value rejects with a TypeError before a
 *     context opens.
 * @param {{now: (string|undefined), block: (boolean|undefined)}=} options
 *     `now` is the fixed clock as an ISO string, DEFAULT_NOW by default;
 *     `block` makes every read of window.localStorage throw.
 * @returns {!Promise<!Object>} The session: `context`, `run`, `url`,
 *     `failures`, `network`, `pages`, the mutable `phase` label ('load' by
 *     default) that tags each logged request, `openPage()` and `close()`.
 *     Concurrent close() calls share one attempt, which resolves once the
 *     context is confirmed closed, after which close() resolves at once. A
 *     failed attempt rejects and keeps the context for the next close().
 */
async function createSession(
    browser, run, url, { now = DEFAULT_NOW, block = false } = {}) {
  const { viewport } = sessionRun(run, url);
  const context = await browser.newContext({
    viewport,
    timezoneId: TIMEZONE,
  });
  watchContextClose(context);
  let closing = null;
  const session = {
    context,
    run,
    url,
    failures: [],
    network: [],
    pages: [],
    phase: 'load',
    persistent: false,
    /**
     * Opens a page in this session's context and loads the session URL.
     * @returns {!Promise<!Object>} The loaded Playwright Page.
     */
    openPage: () => openSessionPage(session),
    /**
     * Closes the context, sharing one attempt among concurrent calls.
     * @returns {!Promise<void>} Resolves once the context is confirmed
     *     closed, and at once on every later call; rejects when the attempt
     *     fails, keeping the context for the next call to retry.
     */
    close: () => {
      // Concurrent calls share one attempt. A failed attempt is cleared so
      // the next call retries; a successful one is returned to every later
      // call, which therefore does nothing.
      closing = closing ?? closeContext(context).catch((err) => {
        closing = null;
        throw err;
      });
      return closing;
    },
  };
  try {
    await context.clock.setFixedTime(new Date(now));
    if (block) {
      await blockStorage(context);
    }
    attachNetworkLog(context, session);
  } catch (err) {
    // The setup error is the one reported, so a failed close cannot mask
    // it; the context then stays with the shared browser until that closes.
    await Promise.allSettled([session.close()]);
    throw err;
  }
  return session;
}

/**
 * Launches Chromium on a persistent profile with the run's viewport, the
 * fixed time zone and clock, and the session's network log.
 * @param {string} profileDir The profile directory.
 * @param {{name: string, mode: string,
 *     viewport: {width: number, height: number}}} run The run: an entry of
 *     RUNS, or a spec equal to one, whose viewport the browser gets. Any
 *     other value rejects with a TypeError before Chromium launches.
 * @param {string} now The fixed clock as an ISO string.
 * @param {!Object} session The session whose network log is attached.
 * @returns {!Promise<!Object>} The persistent BrowserContext. A setup
 *     failure rejects with its own error; a context that then fails to
 *     close is left in `session.context` for the session's close() to retry.
 */
async function launchPersistent(profileDir, run, now, session) {
  const context = await chromium.launchPersistentContext(profileDir, {
    ...LAUNCH_OPTIONS,
    viewport: canonicalRun(run).viewport,
    timezoneId: TIMEZONE,
  });
  watchContextClose(context);
  try {
    await context.clock.setFixedTime(new Date(now));
    attachNetworkLog(context, session);
  } catch (err) {
    // The setup error is the one reported. A context that fails to close
    // passes to the session, whose close() retries it before removing the
    // profile.
    try {
      await closeContext(context);
    } catch {
      session.context = context;
    }
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
 *     viewport: {width: number, height: number}}} run The run: an entry of
 *     RUNS, or a spec equal to one in name, mode and viewport, whose
 *     viewport the browser gets. Any other value rejects with a TypeError
 *     before the profile directory is created.
 * @param {string} url The page URL to open: exactly the run's pageUrl,
 *     index.html's file: URL in file mode or `<loopback origin>/index.html`
 *     in served mode. Any other value rejects with a TypeError before the
 *     profile directory is created.
 * @param {{now: (string|undefined)}=} options `now` is the fixed clock as
 *     an ISO string, DEFAULT_NOW by default; it is re-applied on relaunch.
 * @returns {!Promise<!Object>} The session: the same shape as
 *     createSession's, plus `profileDir` and `relaunch()`, which closes the
 *     browser gracefully (flushing storage to disk) and launches it again on
 *     the same profile with the same options. `context` always points at
 *     the current context, and is replaced only once the previous one has
 *     closed: a relaunch whose close fails rejects and keeps it. relaunch()
 *     rejects on a closing, closed or relaunching session. `close()` lets a
 *     relaunch in flight settle, closes the context, then removes the
 *     profile. Concurrent calls share one attempt; a failed attempt rejects
 *     and keeps the context and the profile for the next close() to retry,
 *     and after a success close() resolves at once.
 */
async function createPersistentSession(run, url, { now = DEFAULT_NOW } = {}) {
  sessionRun(run, url);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plant-parent-'));
  let closing = null;
  let relaunching = null;
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
    /**
     * Opens a page in this session's current context and loads the session
     * URL.
     * @returns {!Promise<!Object>} The loaded Playwright Page.
     */
    openPage: () => openSessionPage(session),
    /**
     * Closes the browser gracefully, flushing storage to the profile, then
     * launches it again on the same profile with the same viewport and clock.
     * @returns {!Promise<void>} Resolves once `session.context` holds the new
     *     context. Rejects when the session is closing, closed or already
     *     relaunching, or when the close or the launch fails; a context that
     *     fails to close stays in `session.context` for close() to retry.
     */
    relaunch: async () => {
      if (closing !== null || relaunching !== null) {
        throw new Error(
            `${run.name}: a persistent session that is closing, closed or ` +
            'already relaunching cannot relaunch');
      }
      relaunching = (
          /**
           * Closes the current context, if any, then launches the next one
           * on the same profile.
           * @returns {!Promise<void>} Resolves once `session.context` holds
           *     the new context; rejects when the close or the launch fails.
           */
          async () => {
            // The previous context stays in session.context until it has
            // closed, so a failed close leaves it for close() to retry.
            if (session.context) {
              await closeContext(session.context);
              session.context = null;
            }
            session.context =
                await launchPersistent(profileDir, run, now, session);
          })();
      try {
        await relaunching;
      } finally {
        relaunching = null;
      }
    },
    /**
     * Lets a relaunch in flight settle, closes the context, then removes the
     * profile, sharing one attempt among concurrent calls.
     * @returns {!Promise<void>} Resolves once the context is confirmed closed
     *     and the profile removed, and at once on every later call; rejects
     *     when the attempt fails, keeping what it could not close or remove
     *     for the next call to retry.
     */
    close: () => {
      // Concurrent calls share one attempt. A failed attempt is cleared so
      // the next call retries, keeping the context and the profile; a
      // successful one is returned to every later call, which does nothing.
      closing = closing ?? (
          /**
           * Waits for a relaunch in flight to settle, closes the current
           * context, if any, then removes the profile directory.
           * @returns {!Promise<void>} Resolves once the context is closed and
           *     the profile removed; rejects when the close or the removal
           *     fails.
           */
          async () => {
            // A relaunch in flight settles first, so the context it leaves in
            // session.context is the one closed here.
            await Promise.allSettled([relaunching]);
            if (session.context) {
              await closeContext(session.context);
              session.context = null;
            }
            fs.rmSync(profileDir, { recursive: true, force: true });
          })().catch((err) => {
            closing = null;
            throw err;
          });
      return closing;
    },
  };
  try {
    session.context = await launchPersistent(profileDir, run, now, session);
  } catch (err) {
    // The launch error is the one reported, so a failed close cannot mask
    // it; the profile then stays on disk, as its browser may be running.
    await Promise.allSettled([session.close()]);
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
 * reloads, so the app loads it as saved data. Malformed or wrong-shape
 * storage is seeded here, already serialised.
 * @param {!Object} page A loaded Playwright Page.
 * @param {string} raw The exact value to store.
 * @returns {!Promise<void>} Resolves once the reloaded page has loaded.
 *     Rejects with a TypeError, before the page is touched, when `raw` is
 *     not a string, which Web Storage would otherwise coerce.
 */
async function seedRaw(page, raw) {
  if (typeof raw !== 'string') {
    throw new TypeError(
        `seedRaw needs a string, got ${raw === null ? 'null' : typeof raw}`);
  }
  await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      [STORAGE_KEY, raw]);
  await page.reload();
}

/**
 * Seeds an array of plant records as JSON and reloads. Any other stored
 * shape goes through seedRaw as a string.
 * @param {!Object} page A loaded Playwright Page.
 * @param {!Array<*>} records The records to store, possibly none. Entries
 *     are stored as given, valid or not.
 * @returns {!Promise<string>} The exact string stored, for raw comparisons.
 *     Rejects with a TypeError, before the page is touched, when `records`
 *     is not an array.
 */
async function seedPlants(page, records) {
  if (!Array.isArray(records)) {
    const type = records === null ? 'null' : typeof records;
    throw new TypeError(`seedPlants needs an array, got ${type}`);
  }
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
      /**
       * Refuses every read of window.localStorage, as a browser that blocks
       * site data does.
       * @throws {DOMException} SecurityError on every read.
       */
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
    /**
     * Refuses every setItem call without storing anything, as a full quota
     * does.
     * @throws {DOMException} QuotaExceededError on every call.
     */
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
 * assertion. Every item's types are checked before the first fill; the
 * values themselves are left to the app's own validation.
 * @param {!Object} page A loaded Playwright Page.
 * @param {!Array<{name: string, date: (string|undefined)}>} items The
 *     plants, possibly none. `date` is filled as `YYYY-MM-DD` (or '') when
 *     given, which marks the date as edited; otherwise the field keeps
 *     today's default.
 * @returns {!Promise<void>} Resolves once every plant is listed. Rejects
 *     with a TypeError naming the item, before the page is touched, when
 *     `items` is not an array or an item is not an object with a string
 *     `name` and a string or undefined `date`.
 */
async function addPlants(page, items) {
  if (!Array.isArray(items)) {
    const type = items === null ? 'null' : typeof items;
    throw new TypeError(`addPlants needs an array, got ${type}`);
  }
  const plants = [];
  for (const [index, item] of items.entries()) {
    if (typeof item !== 'object' || item === null) {
      const type = item === null ? 'null' : typeof item;
      throw new TypeError(`addPlants item ${index} is ${type}, not an object`);
    }
    const { name, date } = item;
    if (typeof name !== 'string') {
      throw new TypeError(
          `addPlants item ${index} name is ${typeof name}, not a string`);
    }
    if (date !== undefined && typeof date !== 'string') {
      const type = date === null ? 'null' : typeof date;
      throw new TypeError(
          `addPlants item ${index} date is ${type}, not a string or ` +
          'undefined');
    }
    plants.push({ name, date });
  }
  const rows = page.locator(ROW_SELECTOR);
  for (const { name, date } of plants) {
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
 *     ariaLabel: ?string, describedBy: ?string,
 *     describesOwnDate: boolean}>>} One entry per row. `id` is the button's
 *     data-plant-id; `dateLine` is the whitespace-normalised date line, such
 *     as "Last watered Mar 6, 2025"; `dateText` and `datetime` come from its
 *     <time> element. `describedBy` is the button's aria-describedby, and
 *     `describesOwnDate` is whether that value, looked up as one id in the
 *     document, finds this row's own date line.
 */
function readRows(page) {
  return page.locator(ROW_SELECTOR).evaluateAll((rows) => rows.map((row) => {
    const name = row.querySelector('.plant__name');
    const date = row.querySelector('.plant__date');
    const time = row.querySelector('.plant__date time');
    const button = row.querySelector('button.plant__water');
    const describedBy =
        button ? button.getAttribute('aria-describedby') : null;
    return {
      id: button ? button.getAttribute('data-plant-id') : null,
      name: name ? name.textContent : null,
      dateLine: date ? date.textContent.replace(/\s+/g, ' ').trim() : null,
      dateText: time ? time.textContent : null,
      datetime: time ? time.getAttribute('datetime') : null,
      buttonText: button ? button.textContent.trim() : null,
      ariaLabel: button ? button.getAttribute('aria-label') : null,
      describedBy,
      describesOwnDate: describedBy !== null && date !== null &&
          document.getElementById(describedBy) === date,
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
    /**
     * Finds an element by its id.
     * @param {string} id The element id.
     * @returns {?HTMLElement} The element, or null when none has the id.
     */
    const byId = (id) => document.getElementById(id);
    /**
     * Reads a field's inline message and the input's error attributes.
     * @param {!HTMLElement} input The field's input.
     * @param {!HTMLElement} element The field's message element.
     * @returns {{text: string, hidden: boolean, inputInvalid: ?string,
     *     describedBy: ?string}} The message's text and `hidden` property,
     *     and the input's aria-invalid and aria-describedby attributes or
     *     null.
     */
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
    /**
     * Names an element stably for the offender list.
     * @param {!Element} element The element.
     * @returns {string} `tag#id` when it has an id, otherwise `tag.classes`,
     *     or the bare tag when it has no class.
     */
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
 * One safe file-name segment for a check id or screenshot suffix: a letter
 * or digit, then letters, digits, '_' or '-'. It cannot be empty, name a
 * directory or climb out of one.
 * @const {!RegExp}
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Checks that a check id or screenshot suffix is one safe file-name
 * segment, so it can name evidence without leaving its run folder.
 * @param {*} value The id or suffix.
 * @param {string} label What the value is, for the error message.
 * @returns {string} The value, unchanged.
 * @throws {TypeError} When the value is not a string matching
 *     SEGMENT_PATTERN.
 */
function checkSegment(value, label) {
  if (typeof value !== 'string' || !SEGMENT_PATTERN.test(value)) {
    throw new TypeError(
        `${label} must be letters, digits, '_' or '-', starting with a ` +
        `letter or digit, not ${describeValue(value)}`);
  }
  return value;
}

/**
 * Resolves a name inside a directory and checks that the result lies
 * directly in it, so no name reaches a parent, a subfolder or an absolute
 * path elsewhere. Nothing is created.
 * @param {string} dir An absolute, normalised directory.
 * @param {string} name The entry's name.
 * @returns {string} The entry's absolute path.
 * @throws {TypeError} When the resolved path is not directly in `dir`.
 */
function childPath(dir, name) {
  const target = path.resolve(dir, name);
  if (path.dirname(target) !== dir || path.basename(target) !== name) {
    throw new TypeError(
        `Evidence name ${describeValue(name)} is not directly in ${dir}`);
  }
  return target;
}

/**
 * Resolves an artifact's path in a run's evidence folder, checking that
 * the folder lies directly in tests/evidence/ and the artifact directly in
 * the folder, and only then creates the folder if needed.
 * @param {{name: string, mode: string,
 *     viewport: {width: number, height: number}}} run The run: an entry of
 *     RUNS, or a spec equal to one.
 * @param {string} name The artifact's file name.
 * @returns {string} The absolute path of tests/evidence/<run>/<name>.
 * @throws {TypeError} When the run is invalid or either path leaves its
 *     directory; nothing is created.
 */
function evidenceFile(run, name) {
  const dir = childPath(EVIDENCE_DIR, canonicalRun(run).name);
  const file = childPath(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  return file;
}

/**
 * The file name of a check's screenshot: <check>.png for its main
 * screenshot, or <check>-<suffix>.png for a sub-case.
 * @param {string} check The check id, one safe file-name segment.
 * @param {string|undefined} suffix The sub-case, one safe file-name
 *     segment, or undefined for the main screenshot. An empty string is
 *     invalid rather than another way to say "main".
 * @returns {string} The file name.
 * @throws {TypeError} When `check` or `suffix` is not a safe segment.
 */
function screenshotName(check, suffix) {
  const id = checkSegment(check, 'Check id');
  if (suffix === undefined) {
    return `${id}.png`;
  }
  return `${id}-${checkSegment(suffix, 'Screenshot suffix')}.png`;
}

/**
 * Creates a run's evidence folder if needed, after checking the run and
 * that the folder lies directly in tests/evidence/.
 * @param {{name: string, mode: string,
 *     viewport: {width: number, height: number}}} run The run: an entry of
 *     RUNS, or a spec equal to one.
 * @returns {string} The absolute path of tests/evidence/<run>/.
 * @throws {TypeError} When the run is invalid; nothing is created.
 */
function runDir(run) {
  const dir = childPath(EVIDENCE_DIR, canonicalRun(run).name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Saves a screenshot as tests/evidence/<run>/<check>.png, or
 * <check>-<suffix>.png for a sub-case.
 * @param {!Object} page A Playwright Page.
 * @param {{name: string, mode: string,
 *     viewport: {width: number, height: number}}} run The run: an entry of
 *     RUNS, or a spec equal to one.
 * @param {string} check The check id, such as 'C01': one safe file-name
 *     segment (SEGMENT_PATTERN).
 * @param {{suffix: (string|undefined), fullPage: (boolean|undefined)}=}
 *     options `suffix` names a sub-case and is a safe segment too; without
 *     it the main <check>.png is written. `fullPage` captures the whole page
 *     instead of the viewport.
 * @returns {!Promise<string>} The screenshot's absolute path. Rejects with
 *     a TypeError, before any folder or file is created, when the run, id
 *     or suffix is invalid.
 */
async function takeScreenshot(
    page, run, check, { suffix, fullPage = false } = {}) {
  const file = evidenceFile(run, screenshotName(check, suffix));
  await page.screenshot({ path: file, fullPage });
  return file;
}

/**
 * Writes a run's network log as tests/evidence/<run>/network.json.
 * @param {{name: string, mode: string,
 *     viewport: {width: number, height: number}}} run The run: an entry of
 *     RUNS, or a spec equal to one.
 * @param {*} data Any JSON-serialisable value.
 * @returns {string} The file's absolute path.
 * @throws {TypeError} When the run is invalid; nothing is created.
 */
function writeNetworkLog(run, data) {
  const file = evidenceFile(run, 'network.json');
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

/**
 * Records one check's outcome for one run.
 * @param {{check: string, run: {name: string, mode: string,
 *     viewport: {width: number, height: number}}, observed: !Object,
 *     pass: boolean, error: (?string|undefined)}} result The outcome;
 *     `check` is one safe file-name segment, `run` an entry of RUNS or a
 *     spec equal to one, and `error` the failure message, absent or null
 *     on a pass.
 * @returns {{check: string, run: string, observed: !Object, pass: boolean,
 *     error: ?string}} The entry added to `results`.
 * @throws {TypeError} When `check` or `run` is invalid; nothing is
 *     recorded.
 */
function recordResult({ check, run, observed, pass, error }) {
  const entry = {
    check: checkSegment(check, 'Check id'),
    run: canonicalRun(run).name,
    observed,
    pass,
    error: error ?? null,
  };
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
 * Returns a thrown value or rejection reason as an Error, so that any value,
 * null and undefined included, is reported and rethrown as a failure. An
 * Error is returned unchanged; any other value becomes an Error that names
 * it and keeps it as its `cause`.
 * @param {*} reason The thrown value or rejection reason.
 * @param {string} source What produced it, such as
 *     'C01 file-360: the check threw'.
 * @returns {!Error} The reason as an Error.
 */
function toCheckError(reason, source) {
  if (reason instanceof Error) {
    return reason;
  }
  let text;
  try {
    text = typeof reason === 'string' ? JSON.stringify(reason) : String(reason);
  } catch {
    text = `a value of type ${typeof reason}`;
  }
  return new Error(`${source} a non-Error value: ${text}`, { cause: reason });
}

/**
 * Closes every session a check opened, attempting each even when one fails.
 * Persistent sessions also remove their profile directory. Whether a close
 * failed is reported apart from its reason, because a reason can be any
 * value, null and undefined included.
 * @param {{sessions: !Array<{close: function(): !Promise<void>}>}} ctx The
 *     check context.
 * @returns {!Promise<{failed: boolean, error: *}>} `failed` is true when any
 *     session failed to close; `error` is then the first failure's reason,
 *     as thrown, and is undefined otherwise.
 */
async function closeSessions(ctx) {
  let failed = false;
  let error;
  for (const session of ctx.sessions) {
    try {
      await session.close();
    } catch (err) {
      if (!failed) {
        failed = true;
        error = err;
      }
    }
  }
  return { failed, error };
}

/**
 * Runs one check for one run. The body gets a context whose sessions are
 * tracked and closed afterwards. After the body, in order: <check>.png is
 * written from the last open page unless the body wrote it, every session
 * is closed, and only then are the page errors and console errors and
 * warnings collected from every session into `observed.failures`, so those
 * arriving during the screenshot or the teardown count too. The check fails
 * when the body throws or rejects with any value, null and undefined
 * included; when no <check>.png can be written; when a session fails to
 * close (which would leave a browser or profile behind); or when that final
 * failure list is not empty. The first of these, in that order, is the
 * reported error, and a non-Error value is reported as an Error naming it,
 * with the value as its `cause`. After a failed body the screenshot stays
 * best effort. Either way one results entry is recorded, after the sessions
 * are closed. An invalid spec is refused first: runCheck rejects with a
 * TypeError, before the body runs, any context opens or any entry is
 * recorded, when `check` is not one safe file-name segment
 * (SEGMENT_PATTERN), `run` is not an entry of RUNS or a spec equal to one,
 * or a served run's `server.url` does not pass servedOrigin.
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
  checkSegment(check, 'Check id');
  canonicalRun(run);
  const ctx = {
    check,
    run,
    url: pageUrl(run, server),
    server,
    observed: {},
    sessions: [],
    lastPage: null,
    mainScreenshot: false,
    /**
     * Creates a session on the spec's browser for this check's run and URL,
     * tracked so it is closed after the body.
     * @param {{now: (string|undefined), block: (boolean|undefined)}=} options
     *     The createSession options.
     * @returns {!Promise<!Object>} The session createSession returns. A
     *     rejection is createSession's own, and nothing is tracked.
     */
    newSession: async (options) => {
      const session = await createSession(browser, run, ctx.url, options);
      ctx.sessions.push(session);
      return session;
    },
    /**
     * Creates a persistent-profile session for this check's run and URL,
     * tracked so it is closed after the body.
     * @param {{now: (string|undefined)}=} options The createPersistentSession
     *     options.
     * @returns {!Promise<!Object>} The session createPersistentSession
     *     returns. A rejection is its own, and nothing is tracked.
     */
    newPersistentSession: async (options) => {
      const session = await createPersistentSession(run, ctx.url, options);
      ctx.sessions.push(session);
      return session;
    },
    /**
     * Saves a screenshot for this check's run and makes the page the one the
     * fallback <check>.png captures while it stays open.
     * @param {!Object} page A Playwright Page.
     * @param {{suffix: (string|undefined), fullPage: (boolean|undefined)}=}
     *     options The takeScreenshot options. Without `suffix` the main
     *     <check>.png is written, so no fallback is taken.
     * @returns {!Promise<string>} The screenshot's absolute path; rejects as
     *     takeScreenshot does.
     */
    screenshot: async (page, options = {}) => {
      ctx.lastPage = page;
      const file = await takeScreenshot(page, run, check, options);
      // takeScreenshot writes <check>.png exactly when there is no suffix.
      if (options.suffix === undefined) {
        ctx.mainScreenshot = true;
      }
      return file;
    },
  };
  // Whether the check failed is tracked apart from why, because a body can
  // throw or reject with any value, null and undefined included.
  let failed = false;
  let failure;
  try {
    await body(ctx);
  } catch (err) {
    failed = true;
    failure = toCheckError(err, `${check} ${run.name}: the check threw`);
  }
  try {
    await ensureCheckScreenshot(ctx);
  } catch (err) {
    // After a failed body the screenshot is best effort, and the body's own
    // error stays the one reported.
    if (!failed) {
      failed = true;
      failure = toCheckError(err, `${check} ${run.name}: the screenshot threw`);
    }
  }
  const closing = await closeSessions(ctx);
  if (closing.failed && !failed) {
    failed = true;
    failure = toCheckError(
        closing.error, `${check} ${run.name}: a session failed to close with`);
  }
  // Collected only once every session has closed, so a page error or console
  // error or warning that arrived during the screenshot or the teardown is
  // in the evidence and fails the check.
  ctx.observed.failures = collectFailures(ctx);
  if (!failed) {
    try {
      assert.deepEqual(
          ctx.observed.failures, [],
          `${check} ${run.name}: the page reported errors or warnings`);
    } catch (err) {
      failed = true;
      failure = err;
    }
  }
  if (failed) {
    recordResult({
      check,
      run,
      observed: ctx.observed,
      pass: false,
      error: failure.message,
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
