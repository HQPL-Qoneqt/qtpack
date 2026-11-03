/**
 * @hqpl/errors — shared core. Import the package root instead: Metro picks
 * index.native.js for Android and iOS, every other bundler picks index.js.
 *
 * Each platform entry creates the one client at load and registers it here, so
 * helpers such as react.js reach it without importing a platform file.
 *
 * Adapters (from the platform entry):
 *   platform           default platform when init() gets none
 *   storage            { getItem, setItem } (async) for crash reports that must survive a restart;
 *                      init({ storage }) overrides it
 *   sessionId()        returns the session ID, called once at init
 *   getLocation()      default `source` of a report (page path); init({ getCurrentScreen }) overrides it
 *   getUserAgent()
 *   getConnectionType()
 *   isOnline()         optional; false queues reports instead of sending them
 *   onRetry(cb)        optional; cb runs when queued reports are worth retrying (online, app active)
 *   install(config, client)  platform error hooks, run once on the first enabled init()
 *   keepalive          true: send with fetch keepalive (browsers), so a report survives page unload
 */

const MAX_BREADCRUMBS = 25;
const MAX_QUEUE = 20;
const MAX_PENDING = 5;
const PENDING_KEY = '_hqe_pending';
// The same fingerprint more than FLOOD_MAX times in FLOOD_WINDOW_MS: repeats are dropped.
const FLOOD_WINDOW_MS = 60000;
const FLOOD_MAX = 3;
const FAILED_REQUEST_DEDUPE_MS = 30000;
// Browsers refuse keepalive requests over 64KB; bigger reports are sent without it.
const KEEPALIVE_MAX_BYTES = 60000;
const FIELD_LIMITS = { message: 2000, stack: 16000, cause: 8000, component_stack: 8000 };
// Fields the server binds as strings; a number here would fail the whole request.
const STRING_FIELDS = ['status', 'error_code', 'error_type', 'method', 'endpoint', 'source', 'message'];
// Written by @hqpl/qtpack into every bundle it builds: { <load-time stack>: <debug id> }.
const DEBUG_ID_REGISTRY = '__telemetryDebugIds';
const PLATFORMS = ['web', 'android', 'ios', 'server'];
// Same rule as the server's project_name and qtpack's upload project.
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

let _current = null;

// The client created by the platform entry, or null before it loads.
export function getClient() {
  return _current;
}

export function createClient(adapters) {
  const s = {
    enabled: false,
    installed: false,
    endpoint: '',
    platform: adapters.platform || 'web',
    projectName: '',
    release: '',
    appVersion: '',
    environment: '',
    headers: {},
    getAuthToken: null,
    beforeSend: null,
    scrubPii: true,
    onSendError: null,
    ignoreRequests: [],
    storage: adapters.storage || null,
    getSource: adapters.getLocation,
    sessionId: '',
    seq: 0,
    userId: 0,
    breadcrumbs: [],
    queue: [],
  };

  // ── public API ──────────────────────────────────────────────────────────────

  // Call once, as early as possible. Returns a promise for compatibility; nothing
  // in it waits on the network.
  async function init(config = {}) {
    s.endpoint = config.endpoint || (config.apiBase ? `${config.apiBase}cx/errors` : '');
    s.platform = config.platform || adapters.platform || 'web';
    s.projectName = config.projectName || '';
    s.appVersion = config.appVersion || '';
    s.release = config.release || config.appVersion || '';
    s.environment = config.environment || '';
    s.headers = config.headers || {};
    s.getAuthToken = typeof config.getAuthToken === 'function' ? config.getAuthToken : null;
    s.beforeSend = typeof config.beforeSend === 'function' ? config.beforeSend : null;
    s.scrubPii = config.scrubPii !== false;
    s.onSendError = typeof config.onSendError === 'function' ? config.onSendError : null;
    s.ignoreRequests = Array.isArray(config.ignoreRequests) ? config.ignoreRequests : [];
    if (config.storage) s.storage = config.storage;
    if (typeof config.getCurrentScreen === 'function') s.getSource = config.getCurrentScreen;

    if (config.enabled === false) {
      s.enabled = false;
      return;
    }
    if (!s.endpoint) {
      console.warn('[@hqpl/errors] init() needs `endpoint` or `apiBase`; nothing will be sent.');
      s.enabled = false;
      return;
    }
    // The server rejects these with a 400, so every report would be lost.
    if (!PLATFORMS.includes(s.platform)) console.warn(`[@hqpl/errors] platform "${s.platform}" is not one of ${PLATFORMS.join(', ')}; the server will reject reports.`);
    if (!s.projectName) console.warn('[@hqpl/errors] init() needs `projectName` (a registered project); the server will reject reports without one.');
    else if (!PROJECT_RE.test(s.projectName)) console.warn(`[@hqpl/errors] projectName "${s.projectName}" must be 1-64 chars of a-z, 0-9, _ or -; the server will reject reports.`);

    s.enabled = true;
    if (!s.sessionId) s.sessionId = _safe(adapters.sessionId) || _uuid();
    if (!s.installed) {
      s.installed = true;
      adapters.onRetry?.(() => { flush(); });
      adapters.install?.(config, api);
    }
    _sendPending();
  }

  // errorOrMessage: an Error (preferred, it carries the stack), an Error-like
  // object, or anything else (stringified). `extra` is spread over the report
  // last, so it can set level, error_type, fingerprint or any other field.
  function captureException(errorOrMessage, extra = {}) {
    const payload = _build(errorOrMessage, extra);
    if (!payload) return;
    if (adapters.isOnline && !_safe(adapters.isOnline, true)) {
      _enqueue(payload);
      return;
    }
    _post(payload).then((done) => { if (!done) _enqueue(payload); });
  }

  function captureMessage(message, level = 'info', extra = {}) {
    captureException(String(message), { level, error_type: 'Message', ...extra });
  }

  // A crash that is about to close the app. The report is saved to storage
  // first (when there is storage), then sent; a saved report that wasn't sent
  // goes out on the next init(). Settles once it is sent or saved, so the
  // caller knows when the app may close.
  async function trackFatal(errorOrMessage, extra = {}) {
    const payload = _build(errorOrMessage, { level: 'fatal', ...extra });
    if (!payload) return;
    const id = _uuid();
    const storage = s.storage;
    if (storage) await _updatePending((list) => [...list, { id, payload }]);
    const done = await _post(payload);
    if (done && storage) await _updatePending((list) => list.filter((e) => e.id !== id));
    if (!done && !storage) _enqueue(payload);
  }

  // A failed API call. The web and React Native entries call this from their
  // fetch wrapper; call it yourself from an axios (or other client) interceptor.
  // Only the path is sent: never the query string, headers or bodies.
  const _requestSeen = new Map();
  function trackFailedRequest({ method = 'GET', url = '', status = 0, error } = {}) {
    if (!s.enabled) return;
    const href = String(url ?? '');
    if (_isOwnRequest(href) || _isIgnored(href)) return;
    const m = String(method || 'GET').toUpperCase();
    const path = _pathOf(href);
    const code = Number(status) || 0;
    const routeKey = `${m} ${_routeOf(path)} ${code || 'network'}`;

    const now = Date.now();
    const last = _requestSeen.get(routeKey) || 0;
    if (now - last >= FAILED_REQUEST_DEDUPE_MS) {
      if (_requestSeen.size > 200) _requestSeen.clear();
      _requestSeen.set(routeKey, now);
      const name = code ? 'HttpError' : 'NetworkError';
      const err = new Error(`${code ? `HTTP ${code}` : 'Network error'}: ${m} ${path}`);
      err.name = name;
      if (error !== undefined) err.cause = error;
      captureException(err, {
        level: !code || code >= 500 ? 'error' : 'warning',
        error_type: name,
        error_code: code ? String(code) : (error?.name || ''),
        status: code ? String(code) : '',
        method: m,
        endpoint: path,
        // One issue per route and outcome. The top stack frame is the fetch
        // wrapper, which would otherwise group every failed request together.
        fingerprint: `${name}:${routeKey}`,
      });
    }
    addBreadcrumb('http', `${m} ${path} failed`, { status: code || 'network' });
  }

  // userId: the numeric user ID (the server stores an unsigned integer), or
  // null/0 on logout. Non-numeric IDs are not sent.
  function setUser(userId) {
    const n = Number(userId);
    s.userId = Number.isSafeInteger(n) && n > 0 ? n : 0;
    if (userId != null && userId !== 0 && !s.userId) console.warn('[@hqpl/errors] setUser() needs a numeric user ID; it was not set.');
  }

  // A short trail of what happened before an error; the last 25 ride along on
  // every report. Keep `data` small and JSON-serializable.
  function addBreadcrumb(category, message, data) {
    s.breadcrumbs.push({
      category: String(category),
      message: _truncate(String(message ?? ''), 200),
      ...(data ? { data } : {}),
      timestamp: new Date().toISOString(),
    });
    if (s.breadcrumbs.length > MAX_BREADCRUMBS) s.breadcrumbs.shift();
  }

  // Sends reports queued while offline or after a failed send.
  let _flushing = null;
  function flush() {
    if (_flushing) return _flushing;
    _flushing = (async () => {
      const items = s.queue.splice(0);
      for (const payload of items) {
        if (!(await _post(payload))) _enqueue(payload);
      }
    })().finally(() => { _flushing = null; });
    return _flushing;
  }

  function isEnabled() {
    return s.enabled;
  }

  // ── reports ─────────────────────────────────────────────────────────────────

  // The prepared report, or null when it must not be sent (SDK off, flooding,
  // or dropped by beforeSend).
  function _build(input, extra) {
    if (!s.enabled) return null;
    const err = _normalizeError(input);
    const payload = {
      platform: s.platform,
      app_version: s.appVersion,
      release: s.release,
      environment: s.environment,
      project_name: s.projectName,
      source: _safe(s.getSource) || '',
      user_agent: _safe(adapters.getUserAgent) || '',
      user_id: s.userId,
      session_id: s.sessionId,
      session_seq: ++s.seq,
      connection_type: _safe(adapters.getConnectionType) || '',
      language: _lang(),
      timezone: _timezone(),
      level: 'error',
      message: err.message,
      error_name: err.name,
      stack: err.stack,
      cause: err.cause,
      fingerprint: _fingerprint(err),
      breadcrumbs: s.breadcrumbs.slice(),
      debug_ids: _debugIds(err.stack),
      ...extra,
    };
    if (extra.is_fatal === undefined) payload.is_fatal = payload.level === 'fatal';
    for (const key of STRING_FIELDS) {
      if (payload[key] != null && typeof payload[key] !== 'string') payload[key] = String(payload[key]);
    }
    // Query strings and #fragments often carry tokens, emails or IDs.
    payload.source = _stripUrl(payload.source);
    if (payload.endpoint) payload.endpoint = _stripUrl(payload.endpoint);
    if (!payload.message) payload.message = payload.error_name || 'Unknown error';
    for (const [key, max] of Object.entries(FIELD_LIMITS)) {
      if (typeof payload[key] === 'string') payload[key] = _truncate(payload[key], max);
    }
    if (_isFlood(payload.fingerprint)) return null;
    return _prepare(payload);
  }

  // Privacy pass on everything that leaves the device: redact emails and
  // tokens, then let the app edit or drop the report. A throwing beforeSend
  // drops the report rather than send unreviewed data.
  function _prepare(payload) {
    let out = s.scrubPii ? _redact(payload) : payload;
    if (s.beforeSend) {
      try { out = s.beforeSend(out); } catch { return null; }
    }
    return out || null;
  }

  const _floodSeen = new Map();
  function _isFlood(fp) {
    if (!fp) return false;
    const now = Date.now();
    const e = _floodSeen.get(fp);
    if (!e || now - e.start > FLOOD_WINDOW_MS) {
      if (_floodSeen.size > 200) _floodSeen.clear();
      _floodSeen.set(fp, { start: now, count: 1 });
      return false;
    }
    return ++e.count > FLOOD_MAX;
  }

  // ── transport ───────────────────────────────────────────────────────────────

  // Resolves true when the report is done with: accepted, or refused as invalid
  // (4xx other than 429), which a retry won't fix. False means retry later.
  // Never rejects.
  async function _post(payload) {
    let body;
    try { body = JSON.stringify(payload); } catch { return true; }
    try {
      const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...s.headers, ...(await _authHeaders()) },
        body,
      };
      if (adapters.keepalive && _byteLength(body) < KEEPALIVE_MAX_BYTES) init.keepalive = true;
      const res = await globalThis.fetch(s.endpoint, init);
      if (res.ok) return true;
      _sendFailed({ status: res.status });
      return res.status < 500 && res.status !== 429;
    } catch (error) {
      _sendFailed({ error: error?.message || String(error) });
      return false;
    }
  }

  function _enqueue(payload) {
    s.queue.push(payload);
    if (s.queue.length > MAX_QUEUE) s.queue.shift();
  }

  function _sendFailed(detail) {
    if (!s.onSendError) return;
    try { s.onSendError(detail); } catch { /* a broken hook must not break sending */ }
  }

  // {} without getAuthToken, or when it throws or returns nothing (logged out).
  async function _authHeaders() {
    if (!s.getAuthToken) return {};
    try {
      const token = await s.getAuthToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    } catch {
      return {};
    }
  }

  // Saved crash reports: [{ id, payload }] under one key, oldest first. Updates
  // run one at a time so a crash and the next launch's resend can't overwrite
  // each other.
  let _pendingOp = Promise.resolve();

  function _readPending() {
    return Promise.resolve(s.storage.getItem(PENDING_KEY)).then((raw) => {
      const list = JSON.parse(raw || '[]');
      return Array.isArray(list) ? list : [];
    }).catch(() => []);
  }

  function _updatePending(change) {
    _pendingOp = _pendingOp
      .then(async () => {
        const next = change(await _readPending()).slice(-MAX_PENDING);
        await s.storage.setItem(PENDING_KEY, JSON.stringify(next));
      })
      .catch(() => { /* storage failed: the report is only sent now, not saved */ });
    return _pendingOp;
  }

  async function _sendPending() {
    if (!s.storage) return;
    for (const entry of await _readPending()) {
      if (!entry?.payload) continue;
      if (await _post(entry.payload)) await _updatePending((list) => list.filter((e) => e.id !== entry.id));
    }
  }

  // ── requests ────────────────────────────────────────────────────────────────

  // The SDK's own reports, so a failing report can never trigger another one.
  function _isOwnRequest(href) {
    return !!s.endpoint && (href.startsWith(s.endpoint) || _pathOf(href) === _pathOf(s.endpoint));
  }

  function _isIgnored(href) {
    return s.ignoreRequests.some((rule) => (rule instanceof RegExp ? rule.test(href) : href.includes(String(rule))));
  }

  // ── debug IDs ───────────────────────────────────────────────────────────────

  // Bundle file name → debug ID for every file in the stack, so the server
  // picks the exact sourcemap of the build that crashed whatever the release says.
  const _debugIdIndex = { count: -1, byFile: {} };

  function _debugIds(stack) {
    const registry = globalThis[DEBUG_ID_REGISTRY];
    if (!registry || !stack) return undefined;
    const stacks = Object.keys(registry);
    if (stacks.length !== _debugIdIndex.count) {
      const byFile = {};
      for (const loadStack of stacks) {
        const file = _firstStackFile(loadStack);
        if (file) byFile[file] = registry[loadStack];
      }
      _debugIdIndex.count = stacks.length;
      _debugIdIndex.byFile = byFile;
    }
    const out = {};
    let found = false;
    for (const line of String(stack).split('\n')) {
      const file = _stackLineFile(line);
      if (file && _debugIdIndex.byFile[file]) {
        out[file] = _debugIdIndex.byFile[file];
        found = true;
      }
    }
    return found ? out : undefined;
  }

  const api = {
    init,
    captureException,
    trackError: captureException,
    captureMessage,
    trackFatal,
    trackFailedRequest,
    setUser,
    addBreadcrumb,
    flush,
    isEnabled,
  };
  _current = api;
  return api;
}

// ── React render errors (no React import; works with any renderer) ────────────

const _reportedRenderErrors = new WeakSet();

// Reports an error a React error boundary caught. The same Error object passing
// through more than one hook (a boundary plus a root handler) is reported once.
export function reportRenderError(error, info, extra) {
  const client = _current;
  if (!client) return;
  if (error && typeof error === 'object') {
    if (_reportedRenderErrors.has(error)) return;
    _reportedRenderErrors.add(error);
  }
  const err = _isErrorLike(error) ? error : new Error(typeof error === 'string' ? error : (_json(error) || 'Unknown render error'));
  client.captureException(err, {
    error_type: 'RenderError',
    error_code: err.name || '',
    component_stack: info?.componentStack?.trim() || '',
    ...extra,
  });
}

// React 19 root options: createRoot(el, reactRootErrorHandlers). Error
// boundaries and router error screens swallow render errors before
// window.onerror sees them; these hooks still get every one.
export const reactRootErrorHandlers = {
  onCaughtError: (error, info) => reportRenderError(error, info, { level: 'error' }),
  onUncaughtError: (error, info) => reportRenderError(error, info, { level: 'fatal' }),
  onRecoverableError: (error, info) => reportRenderError(error, info, { level: 'warning' }),
};

// ── helpers ───────────────────────────────────────────────────────────────────

function _isErrorLike(v) {
  return v instanceof Error || (!!v && typeof v === 'object' && typeof v.message === 'string');
}

// An Error, an Error-like object (e.g. from another realm, where instanceof
// fails) or anything else. Always { message, name, stack, cause }.
function _normalizeError(input) {
  if (_isErrorLike(input)) {
    return {
      message: input.message,
      name: input.name || 'Error',
      stack: typeof input.stack === 'string' ? input.stack : undefined,
      cause: input.cause !== undefined ? _causeToString(input.cause) : undefined,
    };
  }
  const message = typeof input === 'string' ? input : (_json(input) || String(input));
  return { message, name: 'Error', stack: undefined, cause: undefined };
}

function _causeToString(cause) {
  if (cause instanceof Error) return cause.stack || `${cause.name}: ${cause.message}`;
  if (typeof cause === 'string') return cause;
  return _json(cause) || String(cause);
}

// Grouping key: error name plus the top stack frame, or name plus message
// when there is no stack.
function _fingerprint(err) {
  if (err.stack) {
    for (const line of err.stack.split('\n').slice(1)) {
      const frame = line.trim();
      if (frame) return `${err.name}@${frame.replace(/^at\s+/, '').slice(0, 200)}`;
    }
  }
  return `${err.name}:${String(err.message).slice(0, 200)}`;
}

// Bundle file name of one stack line, read the way the server reads it:
// "at f (https://x/assets/index-abc.js?v=1:1:2)" and "f@https://x/a.js:1:2" → "index-abc.js" / "a.js",
// Hermes "(address at index.android.bundle:1:2)" → "index.android.bundle".
function _stackLineFile(line) {
  const m = /([^\s()@]+):\d+:\d+\)?\s*$/.exec(String(line).trim());
  if (!m) return null;
  const ref = m[1].split(/[?#]/)[0];
  return ref.slice(ref.lastIndexOf('/') + 1) || null;
}

function _firstStackFile(stack) {
  for (const line of String(stack).split('\n')) {
    const file = _stackLineFile(line);
    if (file) return file;
  }
  return null;
}

// Path of a URL without origin, query or fragment. String-based, because React
// Native's URL implementation is incomplete.
function _pathOf(href) {
  const path = String(href).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0];
  return path || '/';
}

// Numeric and UUID path segments → ":id", so /users/41 and /users/42 are one issue.
function _routeOf(path) {
  return path.replace(/\/(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\/|$)/gi, '/:id');
}

function _stripUrl(u) {
  return typeof u === 'string' ? u.split(/[?#]/)[0] : u;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

function _redact(v, depth = 0) {
  if (typeof v === 'string') {
    return v.replace(EMAIL_RE, '[email]').replace(JWT_RE, '[token]').replace(BEARER_RE, 'Bearer [token]');
  }
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => _redact(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) out[k] = _redact(v[k], depth + 1);
  return out;
}

function _truncate(str, max) {
  return str.length > max ? `${str.slice(0, max)}…[truncated]` : str;
}

function _byteLength(str) {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(str).length : str.length * 3;
}

function _lang() {
  const locale = (typeof navigator !== 'undefined' && navigator.language) || _intlLocale();
  return locale ? locale.split('-')[0] : '';
}

function _intlLocale() {
  try { return Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch { return ''; }
}

function _timezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

function _safe(fn, fallback) {
  try { return typeof fn === 'function' ? fn() : fallback; } catch { return fallback; }
}

function _json(value) {
  try { return JSON.stringify(value); } catch { return null; }
}

function _uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
