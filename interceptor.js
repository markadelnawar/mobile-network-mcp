/**
 * mobile-network-mcp — drop-in XHR hook for React Native.
 *
 * Usage (in your app entry, dev only):
 *   if (__DEV__) require('mobile-network-mcp/interceptor');
 *
 * Or with custom options:
 *   if (__DEV__) require('mobile-network-mcp/interceptor').start({ port: 7890 });
 */

const DEFAULT_PORT = 7890;
const DEFAULT_HOST = 'localhost';
const BATCH_INTERVAL_MS = 500;

let started = false;
let queue = [];
let timer = null;
let ingestUrl = '';

function start(options = {}) {
  if (started) return;
  started = true;

  const port = options.port || DEFAULT_PORT;
  const host = options.host || DEFAULT_HOST;
  ingestUrl = `http://${host}:${port}/flows/batch`;

  // Use RN's built-in XHRInterceptor
  const XHRInterceptor = require('react-native/Libraries/Network/XHRInterceptor');

  XHRInterceptor.setOpenCallback((method, url, xhr) => {
    // Skip our own ingest requests
    if (url.includes('/flows/batch')) return;
    xhr._rnmcp = { method, url, startTime: Date.now() };
  });

  XHRInterceptor.setSendCallback((data, xhr) => {
    if (xhr._rnmcp) {
      xhr._rnmcp.requestBody = data;
    }
  });

  XHRInterceptor.setHeaderReceivedCallback((type, size, url, xhr) => {
    if (xhr._rnmcp) {
      xhr._rnmcp.responseType = type;
      xhr._rnmcp.responseSize = size;
    }
  });

  XHRInterceptor.setResponseCallback((status, timeout, body, url, type, xhr) => {
    if (!xhr._rnmcp) return;

    const meta = xhr._rnmcp;
    const endTime = Date.now();

    const flow = {
      request: {
        url: meta.url,
        method: meta.method,
        headers: xhr._headers || {},
        body: meta.requestBody,
      },
      response: {
        status: status,
        statusText: '',
        headers: xhr.responseHeaders || {},
        body: body,
      },
      startTime: meta.startTime,
      endTime: endTime,
      duration: endTime - meta.startTime,
      timestamp: meta.startTime / 1000,
    };

    enqueue(flow);
  });

  XHRInterceptor.enableInterception();
}

function enqueue(flow) {
  queue.push(flow);

  // Batch sends to avoid spamming requests
  if (!timer) {
    timer = setTimeout(flush, BATCH_INTERVAL_MS);
  }
}

function flush() {
  timer = null;
  if (queue.length === 0) return;

  const batch = queue;
  queue = [];

  // Use XMLHttpRequest directly to avoid intercepting our own requests
  const xhr = new XMLHttpRequest();
  xhr._rnmcp_internal = true;
  xhr.open('POST', ingestUrl);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send(JSON.stringify(batch));
}

// Auto-start on require
start();

module.exports = { start };
