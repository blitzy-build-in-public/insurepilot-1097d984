/**
 * @fileoverview Static file server for the browser checks and the manual
 * pass. It serves only the regular files directly in the given root whose
 * extension is .html, .css or .js, so the repository root's index.html,
 * styles.css and app.js are reachable and tests/, node_modules/, dotfiles
 * and every other path get a 404. Symbolic links are never followed: a link
 * in the root gets a 404 whatever it points at, even when it is named
 * app.js. Each requested path is logged, because Playwright filters some
 * requests, such as /favicon.ico, out of its events. Responses carry
 * Cache-Control: no-store, so a reload re-requests every file, and
 * X-Content-Type-Options: nosniff, so a browser keeps to the type sent.
 *
 * API:
 *   const { startStaticServer } = require('../support/static-server.js');
 *   const { url, requests, close } = await startStaticServer({ root });
 *   // Open `${url}/index.html`; read `requests`; await close().
 * The request log is bounded: past 100000 paths or 16777216 characters the
 * server stops itself with a stderr diagnostic and must be restarted.
 *
 * Direct run, from the repository root, since the script path is relative
 * (the served root comes from this file's location, not the working
 * directory):
 *   node tests/support/static-server.js [port]
 *   HOST=0.0.0.0 node tests/support/static-server.js 8080
 * The server binds to 127.0.0.1 unless HOST names another address. With
 * HOST=0.0.0.0 it also prints the LAN URLs for the phone pass. A run whose
 * request log fills exits with code 1.
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

/** Content type per servable extension; every other extension gets 404. */
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
});

/** The methods served, sent as Allow on every 405. */
const ALLOW = 'GET, HEAD';

/** Loopback only, unless the caller or HOST names another address. */
const DEFAULT_HOST = '127.0.0.1';

/**
 * Printed to stderr when the direct run gets an invalid port argument or
 * more than one argument.
 */
const USAGE =
    'Usage: [HOST=<address>] node tests/support/static-server.js [port]';

/**
 * Most paths the request log holds before the server stops itself. A page
 * load logs three, so only a flood of requests comes near it. Besides its
 * characters, each path costs a string header and an array slot, a few
 * dozen bytes, so this many paths retain about 4 MB more.
 */
const REQUEST_LOG_MAX_ENTRIES = 100000;

/**
 * Most UTF-16 code units the request log holds, summed over its paths,
 * before the server stops itself. The log stores each path as a copy with
 * storage of its own, at two bytes per code unit at most, so the paths it
 * holds retain about 32 MiB at most. Node caps a request head at 16 KiB by
 * default, so a flood of long unique paths stops the server after about a
 * thousand requests.
 */
const REQUEST_LOG_MAX_CHARS = 16 * 1024 * 1024;

/**
 * The request log behind each object startStaticServer has resolved to.
 * It is kept here rather than on that object, so the object stays
 * `{ url, requests, close }` while main() can still learn that the log
 * stopped the server and exit with code 1.
 */
const requestLogs = new WeakMap();

/**
 * Ends a response with a plain-text body, which is omitted for HEAD.
 * @param {!http.ServerResponse} res The response, not yet started.
 * @param {number} status The HTTP status code.
 * @param {string} text The body text.
 * @param {!Object<string, string>=} extraHeaders Headers to add, such as
 *     Allow on a 405.
 */
function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    ...extraHeaders,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (res.req.method === 'HEAD') {
    res.end();
  } else {
    res.end(text);
  }
}

/**
 * Tells whether the server answers a method rather than refusing it.
 * @param {string} method The request method.
 * @returns {boolean} True for GET and HEAD, the methods in ALLOW.
 */
function isServedMethod(method) {
  return method === 'GET' || method === 'HEAD';
}

/**
 * Reads the request target that is logged and routed.
 * @param {!http.IncomingMessage} req The request.
 * @returns {string} The target as sent, without its query or fragment and
 *     still percent-encoded, or `/` when that leaves nothing. A CONNECT
 *     target is an authority, such as example.com:443.
 */
function requestPath(req) {
  // The raw req.url, not new URL(req.url, base).pathname: WHATWG URL
  // parsing removes dot segments, so /../app.js would become /app.js and
  // be served instead of refused.
  return String(req.url || '/').split(/[?#]/)[0] || '/';
}

/**
 * Checks a request target's syntax with the WHATWG URL parser.
 * @param {string} target The request target as sent, query included.
 * @returns {boolean} False when the parser rejects the target, such as
 *     `//[` or `http://[`; true otherwise.
 */
function hasValidUrlSyntax(target) {
  try {
    // Parsed for its syntax only: routing keeps the raw path, because the
    // parsed pathname has its dot segments removed.
    new URL(target, 'http://localhost');
  } catch (err) {
    if (err instanceof TypeError && err.code === 'ERR_INVALID_URL') {
      return false;
    }
    throw err;
  }
  return true;
}

/**
 * Maps a raw request path to the name of a file directly in the root.
 * @param {string} rawPath The request path as sent, without its query or
 *     fragment, still percent-encoded.
 * @returns {?string} The file name, or null when the path cannot name a
 *     servable file: a malformed escape, no leading slash, an empty name, a
 *     nested path, a NUL byte, a dotfile, a name containing `..` anywhere,
 *     such as backup..js, or an extension outside CONTENT_TYPES.
 */
function resolveFileName(rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch (err) {
    if (err instanceof URIError) {
      return null;
    }
    throw err;
  }
  if (decoded === '/') {
    return 'index.html';
  }
  if (!decoded.startsWith('/')) {
    return null;
  }
  const name = decoded.slice(1);
  if (name === '' || name.includes('/') || name.includes('\\') ||
      name.includes('\0') || name.startsWith('.') || name.includes('..') ||
      !Object.hasOwn(CONTENT_TYPES, path.extname(name))) {
    return null;
  }
  return name;
}

/**
 * Flags for the one open of a served file. O_NOFOLLOW makes the open fail,
 * with ELOOP, when the name has become a symbolic link, and O_NONBLOCK
 * keeps a FIFO swapped in for the file from blocking it. A platform that
 * lacks either flag, such as Windows, gets 0 in its place, and
 * readCheckedFile's device and inode comparison still refuses a swapped
 * entry there.
 */
const OPEN_FLAGS = fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

/**
 * Reads an opened file, provided it is still the entry that lstat found.
 * @param {!fs.promises.FileHandle} handle The file, opened with OPEN_FLAGS.
 * @param {!fs.BigIntStats} entry The lstat result for the file's name.
 * @returns {!Promise<?Buffer>} The file's bytes, or null when the handle is
 *     not a regular file or has another device or inode than `entry`,
 *     because the name was swapped between the lstat and the open. Rejects
 *     when the fstat or the read fails.
 */
async function readCheckedFile(handle, entry) {
  const opened = await handle.stat({ bigint: true });
  if (!opened.isFile() || opened.dev !== entry.dev ||
      opened.ino !== entry.ino) {
    return null;
  }
  return handle.readFile();
}

/**
 * Closes a served file's handle without rejecting. A failed close does not
 * change the bytes already read, so it concerns the operator, not the
 * client: it is reported as a process warning, and the response stands.
 * @param {!fs.promises.FileHandle} handle The open file.
 * @param {string} name The file name, for the warning.
 * @returns {!Promise<void>} Resolves once the handle is closed or the
 *     failure is reported.
 */
async function closeFile(handle, name) {
  try {
    await handle.close();
  } catch (err) {
    process.emitWarning(`Could not close ${name}: ${err.message}`);
  }
}

/**
 * Answers one request from the root's own files. Before any file lookup, a
 * method other than GET or HEAD gets a 405 and a target the URL parser
 * rejects gets a 404. Symbolic links are never followed: the name is
 * looked up with lstat in the root's real path, so a link gets a 404 even
 * when it is named app.js, as does every other entry that is not a regular
 * file. The file is then opened once, without following a link, and read
 * through that descriptor only when it is still the entry lstat found, so
 * a name swapped in between gets a 404 too. A failed read gets a 500 whose
 * body holds no error detail.
 * @param {!http.IncomingMessage} req The request.
 * @param {!http.ServerResponse} res The response.
 * @param {string} rootDir Absolute root directory.
 * @param {string} rawPath The request path as sent, without query or
 *     fragment.
 * @returns {!Promise<void>} Settles once the response has ended; rejects
 *     only on an unexpected error, which the caller turns into a 500.
 */
async function handleRequest(req, res, rootDir, rawPath) {
  if (!isServedMethod(req.method)) {
    sendText(res, 405, 'Method Not Allowed', { 'Allow': ALLOW });
    return;
  }
  if (!hasValidUrlSyntax(req.url || '/')) {
    sendText(res, 404, 'Not Found');
    return;
  }
  const name = resolveFileName(rawPath);
  if (name === null) {
    sendText(res, 404, 'Not Found');
    return;
  }
  // The root's real path, so the comparison below is between real paths.
  // The root itself may be reached through a link, which the operator
  // chose; the entries inside it may not.
  let realRoot;
  try {
    realRoot = await fs.promises.realpath(rootDir);
  } catch {
    sendText(res, 404, 'Not Found');
    return;
  }
  const filePath = path.join(realRoot, name);
  // Defence in depth: resolveFileName already refuses every separator.
  if (path.dirname(filePath) !== realRoot) {
    sendText(res, 404, 'Not Found');
    return;
  }
  let entry;
  try {
    entry = await fs.promises.lstat(filePath, { bigint: true });
  } catch {
    sendText(res, 404, 'Not Found');
    return;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    sendText(res, 404, 'Not Found');
    return;
  }
  let handle;
  try {
    handle = await fs.promises.open(filePath, OPEN_FLAGS);
  } catch {
    // Such as ELOOP for a link swapped in after the lstat, ENOENT for a
    // file removed since, or EACCES.
    sendText(res, 404, 'Not Found');
    return;
  }
  let body;
  try {
    body = await readCheckedFile(handle, entry);
  } catch {
    sendText(res, 500, 'Internal Server Error');
    return;
  } finally {
    await closeFile(handle, name);
  }
  if (body === null) {
    sendText(res, 404, 'Not Found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(name)],
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(body);
  }
}

/**
 * The request log a server's three listeners share. `requests` holds every
 * logged path. `record` logs one path and returns false once the log has
 * stopped the server. `exhausted` resolves when it does. `stopped` is null
 * until then, and then resolves once the server has fully closed.
 * @typedef {{requests: !Array<string>, record: function(string): boolean,
 *     exhausted: !Promise<void>, stopped: ?Promise<void>}} RequestLog
 */

/**
 * Creates a server's request log, bounded by REQUEST_LOG_MAX_ENTRIES paths
 * and REQUEST_LOG_MAX_CHARS characters. It keeps a copy of each path, not
 * a slice of a longer string, so those limits bound the memory it retains,
 * as their descriptions state. It fails closed rather than drop a path:
 * the path that takes it past either limit is still logged, and the
 * log then prints one diagnostic to stderr and stops the server listening,
 * which also closes its idle connections, so no new connection is
 * accepted. Every later path is logged too, but only the few still
 * arriving on connections open at that moment can come, and each of those
 * connections closes after its refusal.
 * @param {!http.Server} server The server whose requests are logged.
 * @returns {!RequestLog} The log, empty.
 */
function createRequestLog(server) {
  let paths = 0;
  let chars = 0;
  let markExhausted;
  const log = {
    requests: [],
    /**
     * Logs one path, and stops the server when the path takes the log past
     * a limit.
     * @param {string} rawPath The path to log; the log keeps a copy of it.
     * @returns {boolean} True while the server still answers; false from
     *     the path that stopped it on.
     */
    record: (rawPath) => {
      // The path requestPath returns can be a slice of req.url, which keeps
      // the whole request target, query included, alive while the slice is
      // held. The copy has storage of its own, so the log keeps and counts
      // only the path's characters. UTF-16LE round-trips every code unit,
      // lone surrogates included, so the copy equals the path.
      const logged = Buffer.from(rawPath, 'utf16le').toString('utf16le');
      log.requests.push(logged);
      if (log.stopped !== null) {
        return false;
      }
      paths += 1;
      chars += logged.length;
      if (paths <= REQUEST_LOG_MAX_ENTRIES &&
          chars <= REQUEST_LOG_MAX_CHARS) {
        return true;
      }
      const limit = paths > REQUEST_LOG_MAX_ENTRIES ?
          `${REQUEST_LOG_MAX_ENTRIES} paths` :
          `${REQUEST_LOG_MAX_CHARS} characters`;
      console.error(
          `static-server: the request log reached its limit of ${limit}, ` +
          'so the server has stopped accepting requests. Restart it to ' +
          'serve again.');
      // http.Server#close() closes the idle connections too; one still
      // waiting on its response stays open until that response ends.
      log.stopped = new Promise((resolve) => {
        server.close(() => resolve());
      });
      markExhausted();
      return false;
    },
    exhausted: new Promise((resolve) => {
      markExhausted = resolve;
    }),
    stopped: null,
  };
  return log;
}

/**
 * Refuses a request that arrives after its server's request log has
 * stopped the server: a 503 with Connection: close, so its connection
 * closes once the response ends. It never lets an error escape.
 * @param {!http.ServerResponse} res The response, not yet started.
 */
function sendUnavailable(res) {
  try {
    sendText(res, 503, 'Service Unavailable', { 'Connection': 'close' });
  } catch {
    res.destroy();
  }
}

/**
 * Creates the server's request listener, which logs every request path
 * before answering and never lets an error escape.
 * @param {string} rootDir Absolute root directory.
 * @param {!RequestLog} log Log that receives each request path.
 * @returns {function(!http.IncomingMessage, !http.ServerResponse): void}
 *     The listener.
 */
function createRequestListener(rootDir, log) {
  /**
   * Logs the request's path, then answers it from the root's files, or
   * with sendUnavailable once the log has stopped the server. An
   * unexpected failure gets a 500, or a destroyed socket when the response
   * has already started.
   * @param {!http.IncomingMessage} req The request.
   * @param {!http.ServerResponse} res Its response.
   */
  const onRequest = (req, res) => {
    const rawPath = requestPath(req);
    if (!log.record(rawPath)) {
      sendUnavailable(res);
      return;
    }
    handleRequest(req, res, rootDir, rawPath).catch(() => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      try {
        sendText(res, 500, 'Internal Server Error');
      } catch {
        res.destroy();
      }
    });
  };
  return onRequest;
}

/**
 * Creates the server's checkExpectation listener. Node emits that event,
 * not 'request', for an HTTP/1.1 request whose Expect header is anything
 * but 100-continue, and without a listener answers it with a bare 417 that
 * is never logged. This listener logs the request once, gives a method
 * other than GET or HEAD the usual 405, gives GET and HEAD a 417, and never
 * lets an error escape. Expect: 100-continue stays with Node, which sends
 * 100 Continue and then emits 'request'.
 * @param {!RequestLog} log Log that receives each request path.
 * @returns {function(!http.IncomingMessage, !http.ServerResponse): void}
 *     The listener.
 */
function createExpectationListener(log) {
  /**
   * Logs the request's path, then answers 417 or 405, or uses
   * sendUnavailable once the log has stopped the server.
   * @param {!http.IncomingMessage} req The request, whose Expect header is
   *     not 100-continue.
   * @param {!http.ServerResponse} res Its response.
   */
  const onCheckExpectation = (req, res) => {
    if (!log.record(requestPath(req))) {
      sendUnavailable(res);
      return;
    }
    try {
      if (isServedMethod(req.method)) {
        sendText(res, 417, 'Expectation Failed');
      } else {
        sendText(res, 405, 'Method Not Allowed', { 'Allow': ALLOW });
      }
    } catch {
      res.destroy();
    }
  };
  return onCheckExpectation;
}

/**
 * Creates the server's connect listener. Node emits that event, not
 * 'request', for CONNECT, and without a listener destroys the socket
 * unanswered and unlogged. This listener logs the target once and answers
 * 405 with Allow on the raw socket, then closes it; it never opens a
 * tunnel.
 * @param {!RequestLog} log Log that receives each request path.
 * @returns {function(!http.IncomingMessage, !net.Socket): void} The
 *     listener.
 */
function createConnectListener(log) {
  /**
   * Logs the CONNECT's target, then answers 405 on the raw socket and
   * closes it, or, once the log has stopped the server, destroys the
   * socket unanswered.
   * @param {!http.IncomingMessage} req The CONNECT request.
   * @param {!net.Socket} socket The client's socket, which Node has handed
   *     over to this listener.
   */
  const onConnect = (req, socket) => {
    // Node has already detached its own error handler and dropped the
    // socket from the server's connection list, so closeAllConnections()
    // cannot reach it: this listener absorbs its errors and destroys it as
    // soon as the response is flushed, so close() never waits on it.
    socket.on('error', () => socket.destroy());
    if (!log.record(requestPath(req))) {
      socket.destroy();
      return;
    }
    const body = 'Method Not Allowed';
    // Reading and discarding what the client sends keeps unread bytes from
    // turning the close into a reset that could drop the response.
    socket.resume();
    socket.end([
      'HTTP/1.1 405 Method Not Allowed',
      `Allow: ${ALLOW}`,
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Cache-Control: no-store',
      'X-Content-Type-Options: nosniff',
      'Connection: close',
      '',
      body,
    ].join('\r\n'), () => socket.destroy());
  };
  return onConnect;
}

/**
 * Stops a server, first destroying its open connections, so keep-alive
 * sockets a browser still holds cannot delay the shutdown.
 * @param {!http.Server} server The server.
 * @param {!RequestLog} log The server's request log.
 * @returns {!Promise<void>} Resolves once the server has closed. After the
 *     log has stopped the server, every call resolves, once the server has
 *     fully closed; before that, a call rejects when the server is not
 *     listening, as on a second call.
 */
function closeServer(server, log) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    if (log.stopped !== null) {
      resolve(log.stopped);
      return;
    }
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Starts a static server for the regular .html, .css and .js files directly
 * in `root`. `/` serves index.html; every other path gets a 404, and any
 * method other than GET or HEAD, CONNECT included, gets a 405 with Allow.
 * A GET or HEAD whose Expect header is not 100-continue gets a 417.
 * @param {{root: string, host: (string|undefined),
 *     port: (number|undefined)}} options `root` is required: the directory
 *     to serve, a non-empty string resolved against the working directory.
 *     `host` is optional: the address to bind, 127.0.0.1 when omitted or
 *     undefined. `port` is optional: the port to bind, 0 when omitted or
 *     undefined, which picks a free ephemeral port.
 * @returns {Promise<{url: string, requests: string[],
 *     close: function(): Promise<void>}>} Resolves once the server listens.
 *     `url` is `http://<host>:<port>` with no trailing slash, the host
 *     bracketed when it is an IPv6 literal. `requests` is a live log of
 *     every request path in arrival order, as sent, without its query or
 *     fragment; a CONNECT is logged by its target authority, and a request
 *     with an unsupported Expect header is logged too. The log is bounded
 *     by REQUEST_LOG_MAX_ENTRIES paths and REQUEST_LOG_MAX_CHARS
 *     characters and fails closed rather than drop a path: the request
 *     that takes it past either limit is still logged, one diagnostic goes
 *     to stderr, and the server stops listening, so a new connection is
 *     refused and only a restart serves again. That request, and each one
 *     still arriving on a connection open at that moment, gets a 503 with
 *     Connection: close, or, for a CONNECT, a destroyed socket. `close`
 *     destroys open connections and stops the server; a repeated call
 *     rejects with ERR_SERVER_NOT_RUNNING, except after the log has
 *     stopped the server, when every call resolves once it has fully
 *     closed. Rejects, without creating a server, with a TypeError when
 *     root is missing or not a non-empty string, when a host is given that
 *     is not a non-empty string, such as null or '', or when a port is
 *     given that is not a number, and with a RangeError for a port that is
 *     not an integer from 0 to 65535. Rejects with the listen error, such
 *     as EADDRINUSE, when binding fails.
 */
function startStaticServer({ root, host = DEFAULT_HOST, port = 0 } = {}) {
  if (typeof root !== 'string' || root === '') {
    return Promise.reject(
        new TypeError('startStaticServer: root must be a non-empty string'));
  }
  if (typeof host !== 'string' || host === '') {
    return Promise.reject(
        new TypeError('startStaticServer: host must be a non-empty string'));
  }
  // Checked here because listen() is overloaded: a string port would name
  // an IPC pipe and an object would replace the host with listen options.
  if (typeof port !== 'number') {
    return Promise.reject(
        new TypeError('startStaticServer: port must be a number'));
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return Promise.reject(new RangeError(
        'startStaticServer: port must be an integer from 0 to 65535'));
  }
  const rootDir = path.resolve(root);
  const server = http.createServer();
  const log = createRequestLog(server);
  // Node routes each request to exactly one of these three listeners, so
  // each is logged once, all against the one budget.
  server.on('request', createRequestListener(rootDir, log));
  server.on('checkExpectation', createExpectationListener(log));
  server.on('connect', createConnectListener(log));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const boundPort = server.address().port;
      const hostForUrl = host.includes(':') ? `[${host}]` : host;
      const started = {
        url: `http://${hostForUrl}:${boundPort}`,
        requests: log.requests,
        /**
         * Destroys the server's open connections and stops it.
         * @returns {!Promise<void>} Resolves once the server has closed;
         *     see startStaticServer for a repeated call.
         */
        close: () => closeServer(server, log),
      };
      requestLogs.set(started, log);
      resolve(started);
    });
  });
}

/**
 * Parses the direct run's port argument.
 * @param {string|undefined} arg The first command-line argument.
 * @returns {?number} 0 when the argument is absent, the port for a decimal
 *     integer up to 65535, or null for anything else.
 */
function parsePort(arg) {
  if (arg === undefined) {
    return 0;
  }
  if (!/^\d+$/.test(arg)) {
    return null;
  }
  const port = Number(arg);
  return port <= 65535 ? port : null;
}

/**
 * Lists this machine's non-internal IPv4 addresses, the ones a phone on the
 * same network can reach.
 * @returns {!Array<string>} The addresses, in interface order.
 */
function lanIpv4Addresses() {
  return Object.values(os.networkInterfaces())
      .flat()
      // Node.js 18.0-18.3 reported the family as the number 4.
      .filter((info) => info && !info.internal &&
          (info.family === 'IPv4' || info.family === 4))
      .map((info) => info.address);
}

/**
 * Prints the URLs a phone on the same network can open, for a server bound
 * to every interface.
 * @param {string} port The bound port.
 */
function printLanUrls(port) {
  let addresses;
  try {
    addresses = lanIpv4Addresses();
  } catch (err) {
    console.error(`Could not list network interfaces: ${err.message}`);
    return;
  }
  if (addresses.length === 0) {
    console.log('No LAN IPv4 address found; connect to a network first.');
    return;
  }
  console.log('For the phone pass, open one of these on the same network:');
  for (const address of addresses) {
    console.log(`  http://${address}:${port}/index.html`);
  }
}

/**
 * Runs the server from the command line, serving the repository root.
 * An invalid port argument, more than one argument or a listen failure,
 * such as EADDRINUSE, prints to stderr and exits with code 1. The server
 * then runs until the process is stopped, for example with Ctrl+C, or
 * until its request log reaches a limit: the server then stops listening,
 * and the process exits with code 1 once its last connection has closed.
 */
function main() {
  // From __dirname, not the working directory, so the run serves the
  // repository root wherever it is started.
  const root = path.resolve(__dirname, '..', '..');
  const host = process.env.HOST || DEFAULT_HOST;
  // The port is the only argument, so a second one, such as the host in
  // `8080 0.0.0.0` that belongs in HOST, is a misuse and gets the usage.
  const args = process.argv.slice(2);
  const port = args.length <= 1 ? parsePort(args[0]) : null;
  if (port === null) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  startStaticServer({ root, host, port }).then(
      (started) => {
        const { url } = started;
        console.log(`Serving ${root} at ${url}/index.html`);
        if (host === '0.0.0.0') {
          printLanUrls(url.slice(url.lastIndexOf(':') + 1));
        }
        // The log has already printed why; nothing else keeps the process
        // alive once the stopped server's connections have closed.
        requestLogs.get(started).exhausted.then(() => {
          process.exitCode = 1;
        });
      },
      (err) => {
        console.error(err.message);
        process.exitCode = 1;
      });
}

if (require.main === module) {
  main();
}

module.exports = { startStaticServer };
