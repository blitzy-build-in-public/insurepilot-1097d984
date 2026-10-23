/**
 * @fileoverview Static file server for the browser checks and the manual
 * pass. It serves only the regular files directly in the given root whose
 * extension is .html, .css or .js, so the repository root's index.html,
 * styles.css and app.js are reachable and tests/, node_modules/, dotfiles
 * and every other path get a 404. Each requested path is logged, because
 * Playwright filters some requests, such as /favicon.ico, out of its events.
 * Responses carry Cache-Control: no-store, so a reload re-requests every
 * file.
 *
 * API:
 *   const { startStaticServer } = require('../support/static-server.js');
 *   const { url, requests, close } = await startStaticServer({ root });
 *   // Open `${url}/index.html`; read `requests`; await close().
 *
 * Direct run, from any working directory (it always serves the repository
 * root):
 *   node tests/support/static-server.js [port]
 *   HOST=0.0.0.0 node tests/support/static-server.js 8080
 * The server binds to 127.0.0.1 unless HOST names another address. With
 * HOST=0.0.0.0 it also prints the LAN URLs for the phone pass.
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
 *     nested path, a NUL byte, a dotfile or `..`, or an extension outside
 *     CONTENT_TYPES.
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
      name.includes('\0') || name.startsWith('.') ||
      !Object.hasOwn(CONTENT_TYPES, path.extname(name))) {
    return null;
  }
  return name;
}

/**
 * Answers one request from the root's own files. Before any file lookup, a
 * method other than GET or HEAD gets a 405 and a target the URL parser
 * rejects gets a 404.
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
  const filePath = path.join(rootDir, name);
  // Defence in depth: resolveFileName already refuses every separator.
  if (path.dirname(filePath) !== rootDir) {
    sendText(res, 404, 'Not Found');
    return;
  }
  let stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch {
    sendText(res, 404, 'Not Found');
    return;
  }
  if (!stats.isFile()) {
    sendText(res, 404, 'Not Found');
    return;
  }
  let body;
  try {
    body = await fs.promises.readFile(filePath);
  } catch (err) {
    sendText(res, 500, `Could not read ${name}: ${err.code || err.message}`);
    return;
  }
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(name)],
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(body);
  }
}

/**
 * Creates the server's request listener, which logs every request path
 * before answering and never lets an error escape.
 * @param {string} rootDir Absolute root directory.
 * @param {!Array<string>} requests Log that receives each request path.
 * @returns {function(!http.IncomingMessage, !http.ServerResponse): void}
 *     The listener.
 */
function createRequestListener(rootDir, requests) {
  return (req, res) => {
    const rawPath = requestPath(req);
    requests.push(rawPath);
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
}

/**
 * Creates the server's checkExpectation listener. Node emits that event,
 * not 'request', for an HTTP/1.1 request whose Expect header is anything
 * but 100-continue, and without a listener answers it with a bare 417 that
 * is never logged. This listener logs the request once, gives a method
 * other than GET or HEAD the usual 405, gives GET and HEAD a 417, and never
 * lets an error escape. Expect: 100-continue stays with Node, which sends
 * 100 Continue and then emits 'request'.
 * @param {!Array<string>} requests Log that receives each request path.
 * @returns {function(!http.IncomingMessage, !http.ServerResponse): void}
 *     The listener.
 */
function createExpectationListener(requests) {
  return (req, res) => {
    requests.push(requestPath(req));
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
}

/**
 * Creates the server's connect listener. Node emits that event, not
 * 'request', for CONNECT, and without a listener destroys the socket
 * unanswered and unlogged. This listener logs the target once and answers
 * 405 with Allow on the raw socket, then closes it; it never opens a
 * tunnel.
 * @param {!Array<string>} requests Log that receives each request path.
 * @returns {function(!http.IncomingMessage, !net.Socket): void} The
 *     listener.
 */
function createConnectListener(requests) {
  return (req, socket) => {
    // Node has already detached its own error handler and dropped the
    // socket from the server's connection list, so closeAllConnections()
    // cannot reach it: this listener absorbs its errors and destroys it as
    // soon as the response is flushed, so close() never waits on it.
    socket.on('error', () => socket.destroy());
    requests.push(requestPath(req));
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
      'Connection: close',
      '',
      body,
    ].join('\r\n'), () => socket.destroy());
  };
}

/**
 * Stops a server, first destroying its open connections, so keep-alive
 * sockets a browser still holds cannot delay the shutdown.
 * @param {!http.Server} server A listening server.
 * @returns {!Promise<void>} Resolves once the server has closed; rejects
 *     when it was not listening.
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Starts a static server for the regular .html, .css and .js files directly
 * in `root`. `/` serves index.html; every other path gets a 404, and any
 * method other than GET or HEAD, CONNECT included, gets a 405 with Allow.
 * A GET or HEAD whose Expect header is not 100-continue gets a 417.
 * @param {{root: string, host: (string|undefined),
 *     port: (number|undefined)}=} options `root` is the directory to serve,
 *     resolved against the working directory. `host` is the address to bind,
 *     127.0.0.1 by default. `port` is the port to bind; the default 0 picks
 *     a free ephemeral port.
 * @returns {Promise<{url: string, requests: string[],
 *     close: function(): Promise<void>}>} Resolves once the server listens.
 *     `url` is `http://<host>:<port>` with no trailing slash, the host
 *     bracketed when it is an IPv6 literal. `requests` is a live log of
 *     every request path in arrival order, as sent, without its query or
 *     fragment; a CONNECT is logged by its target authority, and a request
 *     with an unsupported Expect header is logged too. `close` destroys
 *     open connections and stops the server. Rejects, without creating a
 *     server, with a TypeError for a missing or empty root or host or a
 *     port that is not a number, and with a RangeError for a port that is
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
  const requests = [];
  const server = http.createServer(createRequestListener(rootDir, requests));
  // Node routes each request to exactly one of these three listeners, so
  // each is logged once.
  server.on('checkExpectation', createExpectationListener(requests));
  server.on('connect', createConnectListener(requests));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const boundPort = server.address().port;
      const hostForUrl = host.includes(':') ? `[${host}]` : host;
      resolve({
        url: `http://${hostForUrl}:${boundPort}`,
        requests,
        close: () => closeServer(server),
      });
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
 * then runs until the process is stopped, for example with Ctrl+C.
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
      ({ url }) => {
        console.log(`Serving ${root} at ${url}/index.html`);
        if (host === '0.0.0.0') {
          printLanUrls(url.slice(url.lastIndexOf(':') + 1));
        }
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
