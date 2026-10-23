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

/** Loopback only, unless the caller or HOST names another address. */
const DEFAULT_HOST = '127.0.0.1';

/** Printed to stderr when the direct run gets an invalid port argument. */
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
 * Answers one request from the root's own files.
 * @param {!http.IncomingMessage} req The request.
 * @param {!http.ServerResponse} res The response.
 * @param {string} rootDir Absolute root directory.
 * @param {string} rawPath The request path as sent, without query or
 *     fragment.
 * @returns {!Promise<void>} Settles once the response has ended; rejects
 *     only on an unexpected error, which the caller turns into a 500.
 */
async function handleRequest(req, res, rootDir, rawPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed', { 'Allow': 'GET, HEAD' });
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
    // The raw req.url, not new URL(req.url, base).pathname: WHATWG URL
    // parsing removes dot segments, so /../app.js would become /app.js and
    // be served instead of refused.
    const rawPath = String(req.url || '/').split(/[?#]/)[0] || '/';
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
 * method other than GET or HEAD gets a 405.
 * @param {{root: string, host: (string|undefined),
 *     port: (number|undefined)}=} options `root` is the directory to serve,
 *     resolved against the working directory. `host` is the address to bind,
 *     127.0.0.1 by default. `port` is the port to bind; the default 0 picks
 *     a free ephemeral port.
 * @returns {Promise<{url: string, requests: string[],
 *     close: function(): Promise<void>}>} Resolves once the server listens.
 *     `url` is `http://<host>:<port>` with no trailing slash, the host
 *     bracketed when it is an IPv6 literal. `requests` is a live log of
 *     every request path in arrival order, as sent, without its query.
 *     `close` destroys open connections and stops the server. Rejects with
 *     a TypeError for a missing or empty root or host, and with the listen
 *     error, such as EADDRINUSE or a port out of range, when binding fails.
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
  const rootDir = path.resolve(root);
  const requests = [];
  const server = http.createServer(createRequestListener(rootDir, requests));
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
 * An invalid port argument or a listen failure, such as EADDRINUSE, prints
 * to stderr and exits with code 1. The server then runs until the process
 * is stopped, for example with Ctrl+C.
 */
function main() {
  // From __dirname, not the working directory, so the run serves the
  // repository root wherever it is started.
  const root = path.resolve(__dirname, '..', '..');
  const host = process.env.HOST || DEFAULT_HOST;
  const port = parsePort(process.argv[2]);
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
