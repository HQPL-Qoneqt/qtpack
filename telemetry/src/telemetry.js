/**
 * Hqpl Telemetry SDK (web / React).
 *
 *   import telemetry from '@hqpl/telemetry';
 *   await telemetry.init({ apiBase: 'https://api.example.com/api/', platform: 'web', appVersion: '1.0.0' });
 *   telemetry.login(userId);
 *   telemetry.track('button_click', { id: 'signup' });
 *   telemetry.trackPage('/home');
 *   telemetry.trackError(err, { error_type: 'NetworkError' });
 *
 * init() also fires app_open (first_open, update, cold_start or resume), and
 * app_background when the tab is hidden. See README.md for the options.
 */

import { createTelemetry } from './telemetry-core.js';

// ── web adapters ──────────────────────────────────────────────────────────────
//
// Install markers persist across restarts (localStorage); other keys are per tab session.
const _DURABLE_KEYS = new Set(['_ca_installed', '_ca_last_version']);

function _storageFor(key) {
  return _DURABLE_KEYS.has(key) ? localStorage : sessionStorage;
}

function _connType() {
  const c = navigator.connection;
  if (!c) return 'unknown';

  // Physical transport — available on Android browsers
  if (c.type === 'wifi' || c.type === 'ethernet') return 'wifi';
  if (c.type === 'cellular') {
    return { '4g': '4g', '3g': '3g', '2g': '2g', 'slow-2g': '2g' }[c.effectiveType] || 'unknown';
  }

  // No physical type (desktop Chrome/Firefox) — use effectiveType
  // '4g' effective on desktop is almost always WiFi or fast wired
  if (c.effectiveType === '4g') return 'wifi';
  if (c.effectiveType === '3g') return '3g';
  if (c.effectiveType === '2g' || c.effectiveType === 'slow-2g') return '2g';
  return 'unknown';
}

const _webAdapters = {
  storage: {
    async getItem(key)      { return _storageFor(key).getItem(key); },
    async setItem(key, val) { _storageFor(key).setItem(key, val); },
  },

  getConnectionType: _connType,

  onBackground(cb) {
    window.addEventListener('pagehide', cb);
    // visibilitychange's target is `document`, not `window` — it does not
    // bubble, so a window-level listener never fires and backgrounding is
    // silently missed.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) cb();
    });
  },

  onForeground(cb) {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) cb();
    });
  },

  onOnline(cb) { window.addEventListener('online', cb); },
  isOnline:    () => navigator.onLine,

  getLocation:  () => window.location.pathname,
  getUserAgent: () => navigator.userAgent,

  fetchOptions: { keepalive: true },
};

function safeJSON(value) {
  try { return JSON.stringify(value); } catch { return null; }
}

// ── create and export ─────────────────────────────────────────────────────────

const _core = createTelemetry(_webAdapters);

// Failed API calls. A 502 or a dropped connection is a normal fetch() result, not an
// exception, so neither the window listeners nor an error boundary ever see it. This wraps
// window.fetch once, so every call in the app is covered without touching call sites.
//
// init() options (all optional):
//   trackFailedRequests    false turns it off. Default true.
//   failedRequestStatus    (status) => boolean, which responses count as failures.
//                          Default: 500 and above. 4xx are usually expected (401, 404, validation).
//   ignoreRequests         array of strings or RegExps matched against the full URL; matching
//                          requests are never reported.
//
// Network failures (offline, DNS, CORS, connection reset) are always reported; aborted requests
// are not. The request and response bodies and the query string are never read or sent.
const _FAILED_REQUEST_DEDUPE_MS = 30000;

function _installFetchTracking(config = {}) {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  if (config.trackFailedRequests === false || window.fetch.__hqplWrapped) return;

  const isFailure  = typeof config.failedRequestStatus === 'function' ? config.failedRequestStatus : (status) => status >= 500;
  const ignore     = Array.isArray(config.ignoreRequests) ? config.ignoreRequests : [];
  const ownBase    = String(config.apiBase || '');
  const lastSent   = new Map();
  const nativeFetch = window.fetch.bind(window);

  const urlOf = (input) => {
    try { return new URL(typeof input === 'string' ? input : (input?.url ?? String(input)), window.location.href); } catch { return null; }
  };
  const isIgnored = (url) => {
    const full = url.href;
    // The SDK's own reporting endpoints, so a failing report can never trigger another report.
    if (ownBase && full.startsWith(new URL(ownBase + 'cx/', window.location.href).href)) return true;
    return ignore.some((rule) => (rule instanceof RegExp ? rule.test(full) : full.includes(String(rule))));
  };
  const report = (url, method, status, cause) => {
    const path = url.pathname;
    const key = `${method} ${path} ${status}`;
    const now = Date.now();
    if (now - (lastSent.get(key) || 0) < _FAILED_REQUEST_DEDUPE_MS) return;
    lastSent.set(key, now);
    const label = status ? `HTTP ${status}` : 'Network error';
    const err = new Error(`${label}: ${method} ${path}`);
    err.name = status ? 'HttpError' : 'NetworkError';
    if (cause) err.cause = cause;
    HqplTelemetry.trackError(err, {
      level:       status >= 500 || !status ? 'error' : 'warning',
      error_type:  err.name,
      error_code:  status ? String(status) : (cause?.name || ''),
      status:      status ? String(status) : '',
      method,
      endpoint:    path,
      // One issue per endpoint and outcome. The stack's top frame is this wrapper, which would
      // otherwise group every failed request in the app together.
      fingerprint: `${err.name}:${method} ${path} ${status || 'network'}`,
    });
  };

  window.fetch = async function hqplFetch(input, init) {
    const url = urlOf(input);
    const method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    let response;
    try {
      response = await nativeFetch(input, init);
    } catch (error) {
      if (url && error?.name !== 'AbortError' && !isIgnored(url)) report(url, method, 0, error);
      throw error;
    }
    if (url && isFailure(response.status) && !isIgnored(url)) report(url, method, response.status);
    return response;
  };
  window.fetch.__hqplWrapped = true;
}

// Wraps core's init() to additionally wire uncaught-error / unhandled-rejection
// reporting — web-specific crash tracking, not part of the shared core (the
// React Native adapter wires its own equivalent via ErrorUtils instead).
async function init(config) {
  await _core.init(config);
  // enabled: false → nothing is sent; failed-request tracking is skipped.
  if (config.enabled !== false) _installFetchTracking(config);

  const _seen = new Set();

  window.addEventListener('error', (event) => {
    // Static asset failures (images, scripts, fonts) are noise.
    if (event.target && event.target !== window) return;
    const key = `uncaught:${event.message}:${event.filename}:${event.lineno}`;
    if (_seen.has(key)) return;
    _seen.add(key);
    // event.error carries the real Error (with stack) when the browser has
    // one; some engines report a syntax error or a cross-origin script
    // failure with event.error === null, so fall back to a plain message.
    const err = event.error instanceof Error ? event.error : new Error(event.message || 'Uncaught error');
    HqplTelemetry.trackError(err, {
      level:      'fatal',
      error_type: 'UncaughtError',
      error_code: err.name || '',
      endpoint:   `${event.filename}:${event.lineno}:${event.colno}`,
    });
  }, { capture: true });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const err = reason instanceof Error
      ? reason
      : new Error(typeof reason === 'string' ? reason : (safeJSON(reason) || 'Unhandled promise rejection'));
    const key = 'rejection:' + err.message;
    if (_seen.has(key)) return;
    _seen.add(key);
    HqplTelemetry.trackError(err, {
      level:      'error',
      error_type: 'UnhandledRejection',
      error_code: err.name || '',
    });
  });
}

const HqplTelemetry = { ..._core, init };

if (typeof window !== 'undefined') window.HqplTelemetry = HqplTelemetry;

export function withTanStackRouter(router) {
  router.subscribe('onResolved', () => {
    const actualURL  = router.state.location.pathname;
    const lastMatch  = router.state.matches.at(-1);
    const route      = lastMatch ? router.routesById[lastMatch.routeId] : null;
    const rawPattern = route?.fullPath ?? actualURL;
    const pattern    = rawPattern.replace(/\$([^/]+)/g, '[$1]');
    HqplTelemetry.trackPage(pattern, actualURL);
  });
}

// React 19 root-level error hooks. Pass once to createRoot and every render error is
// reported, whichever boundary caught it: your own ErrorBoundary, a router's per-route
// errorComponent, or none at all. Those boundaries swallow the error before it reaches
// window.onerror, so without this a route-level errorComponent hides crashes from the SDK.
//   createRoot(el, reactRootErrorHandlers)
const _reportedRenderErrors = new WeakSet();

export function reportRenderError(error, info, extra) {
  // The same error can pass through more than one hook (a boundary's own report plus
  // onCaughtError), so report each Error object only once.
  if (error && typeof error === 'object') {
    if (_reportedRenderErrors.has(error)) return;
    _reportedRenderErrors.add(error);
  }
  const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : (safeJSON(error) || 'Unknown render error'));
  HqplTelemetry.trackError(err, {
    error_type: 'UncaughtError',
    error_code: err.name || '',
    component_stack: info?.componentStack?.trim() || '',
    ...extra,
  });
}

export const reactRootErrorHandlers = {
  onCaughtError:      (error, info) => reportRenderError(error, info, { level: 'error' }),
  onUncaughtError:    (error, info) => reportRenderError(error, info, { level: 'fatal' }),
  onRecoverableError: (error, info) => reportRenderError(error, info, { level: 'warning' }),
};

export default HqplTelemetry;
