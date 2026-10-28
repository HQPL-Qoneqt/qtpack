/**
 * Hqpl Telemetry — shared core. Import from the package root instead.
 *
 * Adapters: storage, getConnectionType, onBackground, onForeground (optional),
 * getLocation, getUserAgent, getDevice (optional), fetchOptions.
 *
 * init() config: apiBase, getAuthToken (async, returns a bearer token or null),
 * onError (hook for failed or partially rejected sends), projectName,
 * enabled (false makes the SDK a no-op), environment, release.
 *
 * trackFatal(error, extra) is for a crash that is about to close the app: the
 * report is saved to storage before it is sent, and a saved report that was not
 * sent goes out on the next init().
 *
 * Batch sends return 202 even when individual events are rejected; rejections
 * are reported through onError.
 *
 * trackError(errorOrMessage, extra) / captureException(...) accepts a string or
 * an Error (name, message, stack, cause) and adds level, fingerprint and
 * breadcrumbs. `extra` is spread last and can override any field. At most 3
 * errors per fingerprint are sent per 60s.
 */

export function createTelemetry({ storage, getConnectionType, onBackground, onForeground, onOnline, isOnline = () => true, getLocation, getUserAgent, getDevice = () => '', fetchOptions = {} }) {

  const _s = {
    apiBase: '',
    platform: 'web',
    appVersion: '',
    language: '',
    userID: 0,
    sessionID: '',
    sessionSeq: 0,
    previousPage: '',
    currentPage: null,   // { pageName, pageURL, previousPage, entryTime, seq }
    pendingEvents: [],     // batches both track() and impression() events
    errorQueue: [],     // errors queued while offline; flushed on reconnect
    eventTimer: null,
    _getLocation: getLocation,
    foregroundSince: 0,  // Date.now() of the last app_open/resume — powers app_background's dwell_ms
    isBackgrounded: false,
    getAuthToken: null,  // async () => string|null; set via init({ getAuthToken }) — see header comment
    beforeSend: null,    // (payload, kind) => payload | null — last chance to edit or drop; kind: 'event' | 'error' | 'page_view' | 'session'
    scrubPii: true,      // redact emails and tokens from outgoing strings
    onError: null,       // ({ path, status, body } | { path, status, rejections } | { path, error }) => void
    environment: '',     // config.environment — e.g. 'production' | 'staging'; echoed onto error payloads
    projectName: '',     // config.projectName — which app/project sent the error, e.g. 'telemetry' | 'hqpl-web' | 'hqpl-app'
    release: '',         // config.release — defaults to appVersion; echoed onto error payloads
    enabled: true,       // config.enabled — false: nothing is sent, queued or persisted
    errorsOnly: false,   // config.errorsOnly — true: send only error reports; events, sessions and page views are dropped
    breadcrumbs: [],      // rolling trail of recent actions — see _addBreadcrumb
  };

  // This SDK's payload goes over the wire on every single
  // error (not batched/sampled), so keep it small enough not to bloat that.
  const MAX_BREADCRUMBS = 25;

  // ── public API ──────────────────────────────────────────────────────────────

  async function init(config) {
    _s.apiBase = config.apiBase || '';
    _s.platform = config.platform || 'web';
    _s.appVersion = config.appVersion || '';
    _s.language = config.language || '';
    _s.environment = config.environment || '';
    _s.projectName = config.projectName || '';
    _s.release = config.release || config.appVersion || '';
    _s.errorsOnly = config.errorsOnly === true;
    _s.enabled = config.enabled !== false;
    if (!_s.enabled) return;

    // RN callers pass getCurrentScreen; web callers rely on the adapter's getLocation
    if (config.getCurrentScreen) _s._getLocation = config.getCurrentScreen;
    if (typeof config.getDevice === 'function') getDevice = config.getDevice;

    // RN callers pass getAuthToken (reads AsyncStorage); web callers can omit
    // it and rely on the browser sending the session cookie automatically.
    if (config.getAuthToken) _s.getAuthToken = config.getAuthToken;

    if (config.onError) _s.onError = config.onError;
    if (typeof config.beforeSend === 'function') _s.beforeSend = config.beforeSend;
    if (config.scrubPii === false) _s.scrubPii = false;

    const [sid, seq, prevPage] = await Promise.all([
      storage.getItem('_ca_sid'),
      storage.getItem('_ca_seq'),
      storage.getItem('_ca_prev_page'),
    ]);
    _s.sessionID = sid || _uuid();
    // Self-heals a corrupted/non-numeric persisted value (parseInt('') or a
    // garbage string both yield NaN) rather than propagating NaN forever —
    // NaN + 1 is still NaN, and it gets re-persisted as the string "NaN" by
    // _nextSeq() below, so once contaminated it never recovers on its own.
    const parsedSeq = parseInt(seq || '0', 10);
    _s.sessionSeq = Number.isFinite(parsedSeq) ? parsedSeq : 0;
    _s.previousPage = prevPage || '';
    await storage.setItem('_ca_sid', _s.sessionID);

    // Crash reports saved by trackFatal() whose send didn't finish before the app closed.
    _sendPendingErrors();

    onBackground(() => {
      _trackAppBackground();
      if (_s.currentPage) _flushPageView(new Date().toISOString());
      _flushEvents();
    });

    if (onForeground) {
      onForeground(() => {
        // Ignore spurious foreground callbacks (e.g. the initial mount) —
        // only a real return from background counts as a "resume".
        if (!_s.isBackgrounded) return;
        _s.isBackgrounded = false;
        _s.foregroundSince = Date.now();
        _buffer(_enrich({ event_type: 'app_open', secondary_type: 'resume' }));
      });
    }

    if (onOnline) onOnline(_flushErrorQueue);

    await _trackAppOpen();
  }

  // Coerced to a number: callers may pass a numeric string.
  function login(userID) {
    const id = Number(userID);
    _s.userID = Number.isFinite(id) ? id : 0;
    _addBreadcrumb('auth', 'login');
    _postSession({ login_time: new Date().toISOString() });
    // drain any events buffered before login
    _flushEvents();
  }

  // Sets the user without posting a login session, for a user who was already
  // signed in when the app started (login() would count a new login every launch).
  function identify(userID) {
    const id = Number(userID);
    _s.userID = Number.isFinite(id) ? id : 0;
    _flushEvents();
  }

  function logout() {
    _addBreadcrumb('auth', 'logout');
    _flushEvents();
    if (_s.currentPage) _flushPageView(new Date().toISOString());
    _postSession({ logout_time: new Date().toISOString() });
    _s.userID = 0;
  }

  function track(eventType, payload = {}) {
    const { properties, ...rest } = payload;
    _addBreadcrumb('track', eventType, { target_id: rest.target_id, target_type: rest.target_type, source: rest.source });
    _buffer(_enrich({
      event_type: eventType,
      properties: properties || {},
      ...rest,
    }));
  }

  function impression(opts) {
    _buffer(_enrich({
      event_type: 'impression',
      target_id: opts.target_id,
      target_type: opts.target_type || 'post',
      owner_id: opts.owner_id,
      content_category: opts.content_category || '',
      referral_type: opts.referral_type || '',
      recommendation_model_version: opts.recommendation_model_version || '',
      recommendation_score: opts.recommendation_score || 0,
      experiment_id: opts.experiment_id || '',
      variant_id: opts.variant_id || '',
      // Sent as typed top-level fields.
      feed_position: opts.feed_position,
      scroll_past_ms: opts.scroll_past_ms,
      content_age_hours: opts.content_age_hours,
      properties: {},
    }));
  }

  function trackPage(pageName, pageURL) {
    const prevPageName = _s.currentPage?.pageName || _s.previousPage || '';
    _addBreadcrumb('navigation', prevPageName ? `${prevPageName} -> ${pageName}` : pageName);
    if (_s.currentPage) _flushPageView(new Date().toISOString());
    _s.previousPage = prevPageName;
    storage.setItem('_ca_prev_page', prevPageName).catch(() => { });
    _s.currentPage = {
      pageName,
      pageURL: _stripUrl(pageURL || pageName),
      previousPage: prevPageName,
      entryTime: new Date().toISOString(),
      seq: _nextSeq(),
    };
  }

  // Record the outcome of an OS-level permission prompt (camera, microphone,
  // location, notifications, contacts, photos, storage, bluetooth, calendar).
  //   telemetry.trackPermission('camera', 'granted');
  //   telemetry.trackPermission('location', 'blocked', { source: 'onboarding' });
  function trackPermission(permissionType, result, extra = {}) {
    track('permission_prompt', {
      permission_type: permissionType,
      secondary_type: result,
      ...extra,
    });
  }

  // errorOrMessage: a string (legacy) or an Error — pass a real Error
  // whenever one is available (e.g. from a catch block) so the stack trace,
  // error name and cause chain actually reach the backend instead of just
  // the message. See header comment for the full enriched payload shape.
  function trackError(errorOrMessage, extra = {}) {
    const payload = _errorPayload(errorOrMessage, extra);
    if (!payload) return;
    if (!isOnline()) {
      _s.errorQueue.push(payload);
      return;
    }
    _sendError(payload);
  }

  // A fatal crash closes the app right after its handler returns, usually before
  // a normal send finishes. The report is saved first, then sent; the promise
  // settles once it is sent or saved, so the caller knows when it can let the app
  // close. If the app closes before the send, init() sends it on the next launch.
  async function trackFatal(errorOrMessage, extra = {}) {
    const raw = _errorPayload(errorOrMessage, { level: 'fatal', ...extra });
    const payload = raw && _prepare('error', raw);
    if (!payload) return;
    const id = _uuid();
    await _updatePending(list => [...list, { id, payload }]);
    if (await _postError(payload)) {
      await _updatePending(list => list.filter(e => e.id !== id));
    }
  }

  // Builds an error report, or returns null when it must not be sent (SDK off,
  // or the same error repeating too fast).
  function _errorPayload(errorOrMessage, extra) {
    if (!_s.apiBase || !_s.enabled) return null;
    const err = _normalizeError(errorOrMessage);
    const payload = {
      platform: _s.platform,
      app_version: _s.appVersion,
      release: _s.release,
      environment: _s.environment,
      project_name: _s.projectName,
      source: _stripUrl(_s._getLocation()),
      user_agent: getUserAgent(),
      user_id: _s.userID,
      session_id: _s.sessionID,
      session_seq: _nextSeq(),
      connection_type: getConnectionType(),
      language: _lang(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      level: 'error',
      message: err.message,
      error_name: err.name,
      stack: err.stack,
      cause: err.cause,
      fingerprint: _fingerprint(err),
      breadcrumbs: _s.breadcrumbs.slice(),
      debug_ids: _debugIds(err.stack),
      ...extra,
    };
    payload.source = _stripUrl(payload.source);
    if (payload.endpoint) payload.endpoint = _stripUrl(payload.endpoint);
    if (_isFlood(payload.fingerprint)) return null;
    return payload;
  }

  // Same fingerprint more than 3 times in 60s → drop the repeats.
  const FLOOD_WINDOW_MS = 60000;
  const FLOOD_MAX = 3;
  const _floodSeen = new Map(); // fingerprint -> { start, count }
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

  async function _sendError(raw) {
    if (!_s.enabled) return;
    const payload = _prepare('error', raw);
    if (!payload) return;
    _postError(payload);
  }

  // Sends a prepared report. Resolves true when it is done with: accepted, or
  // refused by the server as invalid (4xx), which a retry won't fix. False means
  // retry later (network failure or 5xx). Never rejects.
  async function _postError(payload) {
    try {
      const res = await fetch(_s.apiBase + 'cx/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await _authHeaders()) },
        body: JSON.stringify(payload),
        ...fetchOptions,
      });
      if (res.ok) return true;
      _reportFailure('cx/errors', res);
      return res.status < 500;
    } catch (err) {
      _reportFailure('cx/errors', err);
      return false;
    }
  }

  function _flushErrorQueue() {
    if (!_s.errorQueue.length) return;
    _s.errorQueue.splice(0).forEach(_sendError);
  }

  // Saved crash reports: [{ id, payload }] under one key, oldest first. Updates
  // run one at a time so a crash and the next launch's resend can't overwrite
  // each other's changes.
  const PENDING_ERRORS_KEY = '_ca_pending_errors';
  const MAX_PENDING_ERRORS = 5;
  let _pendingErrorsOp = Promise.resolve();

  function _readPending() {
    return storage.getItem(PENDING_ERRORS_KEY).then(raw => {
      const list = JSON.parse(raw || '[]');
      return Array.isArray(list) ? list : [];
    }).catch(() => []);
  }

  function _updatePending(change) {
    _pendingErrorsOp = _pendingErrorsOp
      .then(async () => {
        const next = change(await _readPending()).slice(-MAX_PENDING_ERRORS);
        await storage.setItem(PENDING_ERRORS_KEY, JSON.stringify(next));
      })
      .catch(() => { /* storage failure: the report is only sent now, not saved */ });
    return _pendingErrorsOp;
  }

  async function _sendPendingErrors() {
    for (const entry of await _readPending()) {
      if (!entry?.payload) continue;
      if (await _postError(entry.payload)) {
        await _updatePending(list => list.filter(e => e.id !== entry.id));
      }
    }
  }

  // ── error enrichment (breadcrumbs, stack normalization, fingerprinting) ───────

  // Bundles built with debug IDs (sourcemap-cli's debug-id.js) register
  // { <their load-time stack>: <id> } here. Sending the IDs of the files in the
  // error's stack lets the server pick the exact map of the build that crashed,
  // whatever the release string says.
  const _debugIdIndex = { count: -1, byFile: {} };

  function _debugIds(stack) {
    const registry = typeof globalThis !== 'undefined' ? globalThis.__telemetryDebugIds : undefined;
    if (!registry || !stack) return undefined;
    const stacks = Object.keys(registry);
    if (stacks.length !== _debugIdIndex.count) {
      const byFile = {};
      for (const s of stacks) {
        const file = _firstStackFile(s);
        if (file) byFile[file] = registry[s];
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

  // Bundle file name of one stack line, the same way the server reads it:
  // "at f (https://x/assets/index-abc.js?v=1:1:2)" and "f@https://x/a.js:1:2" -> "index-abc.js" / "a.js",
  // Hermes "(address at index.android.bundle:1:2)" -> "index.android.bundle".
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

  // data is kept small and JSON-serializable — this rides inside every error
  // payload, so a breadcrumb is a one-line summary, not a copy of the event.
  function _addBreadcrumb(category, message, data) {
    _s.breadcrumbs.push({
      category,
      message,
      ...(data ? { data } : {}),
      timestamp: new Date().toISOString(),
    });
    if (_s.breadcrumbs.length > MAX_BREADCRUMBS) _s.breadcrumbs.shift();
  }

  // Accepts a real Error (preferred — carries a stack), an Error-shaped
  // object (e.g. from a cross-realm iframe, where `instanceof Error` fails),
  // or a plain string (legacy trackError(message) callers). Always returns
  // { message, name, stack, cause }, any of which may be undefined.
  function _normalizeError(input) {
    if (input instanceof Error || (input && typeof input === 'object' && typeof input.message === 'string')) {
      return {
        message: input.message,
        name: input.name || 'Error',
        stack: input.stack,
        cause: input.cause !== undefined ? _causeToString(input.cause) : undefined,
      };
    }
    return { message: String(input), name: 'Error', stack: undefined, cause: undefined };
  }

  function _causeToString(cause) {
    if (cause instanceof Error) return cause.stack || cause.message;
    if (typeof cause === 'string') return cause;
    try { return JSON.stringify(cause); } catch { return String(cause); }
  }

  // A grouping key so near-identical errors cluster into issues
  // instead of being read one row at a time — error name + where in the
  // stack it actually happened, falling back to name + message when there's
  // no stack at all (e.g. a manually-called trackError('some message')).
  function _fingerprint(err) {
    const frame = err.stack && _topStackFrame(err.stack);
    return frame ? `${err.name}@${frame}` : `${err.name}:${err.message}`;
  }

  // First non-empty line of the stack after the "Error: message" header —
  // typically "at functionName (file:line:col)". Trimmed to keep the
  // fingerprint short; this is a grouping key, not a full trace (the full
  // `stack` field already carries that).
  function _topStackFrame(stack) {
    const lines = stack.split('\n').slice(1);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) return trimmed.replace(/^at\s+/, '').slice(0, 200);
    }
    return null;
  }

  // ── internal ────────────────────────────────────────────────────────────────

  // Push an enriched event into the buffer and arm the flush timer.
  function _buffer(event) {
    if (!_s.enabled || _s.errorsOnly) return;
    _s.pendingEvents.push(event);
    if (!_s.eventTimer) {
      _s.eventTimer = setTimeout(_flushEvents, 3000);
    }
  }

  // Send all buffered events. Silently defers if the user hasn't logged in yet —
  // the buffer drains automatically when login() is called.
  //
  // user_id is stamped here rather than at buffer time: app_open (and any
  // track()/impression() a caller fires pre-login) can sit in the buffer for
  // a while, and _s.userID at that point may still be 0. Baking it in early
  // would permanently mislabel the event as anonymous even after the user
  // logs in and the buffer drains — so every buffered event gets the
  // *current* user_id right before it's sent, once one is guaranteed to exist.
  function _flushEvents() {
    clearTimeout(_s.eventTimer);
    _s.eventTimer = null;
    if (_s.pendingEvents.length === 0 || !_s.userID) return;

    const all = _s.pendingEvents.splice(0)
      .map(e => _prepare('event', { ...e, user_id: _s.userID }))
      .filter(Boolean);
    if (!all.length) return;
    for (let i = 0; i < all.length; i += 200) {
      _sendBatch('cx/actions/batch', { events: all.slice(i, i + 200) });
    }
  }

  // Fired once at init() — determines *why* this launch is happening by
  // comparing persisted install/version markers against the current state,
  // then starts the foreground-time clock that app_background reads from.
  async function _trackAppOpen() {
    const [installed, lastVersion] = await Promise.all([
      storage.getItem('_ca_installed'),
      storage.getItem('_ca_last_version'),
    ]);

    let reason = 'cold_start';
    if (!installed) reason = 'first_open';
    else if (lastVersion && lastVersion !== _s.appVersion) reason = 'update';

    await Promise.all([
      storage.setItem('_ca_installed', '1'),
      storage.setItem('_ca_last_version', _s.appVersion),
    ]);

    _s.foregroundSince = Date.now();
    _buffer(_enrich({ event_type: 'app_open', secondary_type: reason }));
  }

  // Fired on every backgrounding — reports how long the app was actually in
  // the foreground since the last app_open/resume. Guarded so a burst of
  // background-ish callbacks (some platforms fire pagehide + visibilitychange
  // together) only produces one event.
  function _trackAppBackground() {
    if (_s.isBackgrounded) return;
    _s.isBackgrounded = true;
    const dwellMs = _s.foregroundSince ? Date.now() - _s.foregroundSince : 0;
    _buffer(_enrich({ event_type: 'app_background', dwell_ms: dwellMs }));
  }

  // Page views need a user id; drop those entered/exited before login.
  function _flushPageView(exitTime) {
    const p = _s.currentPage;
    _s.currentPage = null;
    if (!p || !_s.userID) return;

    _send('cx/page-views', {
      user_id: _s.userID,
      page_name: p.pageName,
      page_url: p.pageURL !== p.pageName ? p.pageURL : undefined,
      previous_page: p.previousPage,
      entry_time: p.entryTime,
      exit_time: exitTime,
      platform: _s.platform,
      app_version: _s.appVersion,
      user_agent: getUserAgent(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      connection_type: getConnectionType(),
      language: _lang(),
      session_id: _s.sessionID,
      session_seq: p.seq,
    });
  }

  function _postSession(payload) {
    _send('cx/sessions', {
      user_id: _s.userID,
      platform: _s.platform,
      app_version: _s.appVersion,
      user_agent: getUserAgent(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      connection_type: getConnectionType(),
      language: _lang(),
      device: getDevice() || undefined,
      ...payload,
    });
  }

  // user_id is stamped in _flushEvents. A caller-supplied session_seq is ignored
  // so it can't corrupt the sequence.
  function _enrich(payload) {
    const { session_seq: _callerSeq, ...rest } = payload;
    return _coerceNumbers({
      platform: _s.platform,
      app_version: _s.appVersion,
      user_agent: getUserAgent(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      connection_type: getConnectionType(),
      language: _lang(),
      session_id: _s.sessionID,
      session_seq: _nextSeq(),
      source: _stripUrl(payload.source || _s._getLocation()),
      ...rest,
    });
  }

  // Fields sent as numbers; string values (e.g. route params) are coerced.
  const NUMERIC_FIELDS = [
    'target_id', 'secondary_id', 'owner_id', 'content_age_hours',
    'recommendation_score', 'group_member_count', 'feed_position',
    'dwell_ms', 'watch_seconds', 'scroll_past_ms', 'completion_pct',
    'content_duration_seconds',
  ];

  function _coerceNumbers(payload) {
    for (const key of NUMERIC_FIELDS) {
      const v = payload[key];
      if (v === undefined || v === null || typeof v === 'number') continue;
      const n = Number(v);
      // Non-numeric values are left as-is.
      if (Number.isFinite(n)) payload[key] = n;
    }
    return payload;
  }

  async function _send(path, raw) {
    if (!_s.apiBase || !_s.enabled || _s.errorsOnly) return;
    const body = _prepare(path === 'cx/sessions' ? 'session' : 'page_view', raw);
    if (!body) return;
    fetch(_s.apiBase + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await _authHeaders()) },
      body: JSON.stringify(body),
      ...fetchOptions,
    }).then(res => {
      if (!res.ok) _reportFailure(path, res);
    }).catch(err => _reportFailure(path, err));
  }

  // Privacy pass applied to everything that leaves the device: redact emails and
  // tokens from strings, then let the app edit or drop the payload via beforeSend.
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
  const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

  function _redact(v, depth = 0) {
    if (typeof v === 'string') {
      return v.replace(EMAIL_RE, '[email]').replace(JWT_RE, '[token]').replace(BEARER_RE, 'Bearer [token]');
    }
    if (depth > 6 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(x => _redact(x, depth + 1));
    const out = {};
    for (const k of Object.keys(v)) out[k] = _redact(v[k], depth + 1);
    return out;
  }

  // Returns the payload to send, or null to drop it. A throwing beforeSend drops
  // the payload rather than risk sending unreviewed data.
  function _prepare(kind, payload) {
    let out = _s.scrubPii ? _redact(payload) : payload;
    if (_s.beforeSend) {
      try { out = _s.beforeSend(out, kind); } catch { return null; }
    }
    return out || null;
  }

  // Like _send, but also reports per-event rejections from the response body
  // (the HTTP status is 202 even when some events are rejected).
  async function _sendBatch(path, body) {
    if (!_s.apiBase || !_s.enabled || _s.errorsOnly) return;
    fetch(_s.apiBase + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await _authHeaders()) },
      body: JSON.stringify(body),
      ...fetchOptions,
    }).then(res => {
      if (!res.ok) {
        _reportFailure(path, res);
        return;
      }
      res.json().then(json => {
        const rejected = json?.data?.rejected;
        if (rejected) {
          _emitFailure({ path, status: res.status, rejections: json.data.rejections });
        }
      }).catch(() => { /* body not JSON / already consumed — nothing to report */ });
    }).catch(err => _reportFailure(path, err));
  }

  // Fires on a non-2xx response or a network-level failure — the only two
  // ways a send can fail. Still entirely fire-and-forget: called from a
  // .then()/.catch() after the caller has already moved on, never awaited,
  // never throws back into track()/impression()/etc. Always console.warns;
  // additionally invokes config.onError (if set) with the same detail,
  // wrapped so a broken hook can't take sending down with it.
  function _reportFailure(path, errOrResponse) {
    if (errOrResponse && typeof errOrResponse.status === 'number') {
      const res = errOrResponse;
      res.text().then(
        body => _emitFailure({ path, status: res.status, body }),
        () => _emitFailure({ path, status: res.status }),
      );
    } else {
      _emitFailure({ path, error: errOrResponse?.message || String(errOrResponse) });
    }
  }

  function _emitFailure(detail) {
    console.warn('[telemetry] request failed', detail);
    // Skip cx/errors itself — a failing error-reporting endpoint shouldn't
    // spam its own next report's breadcrumb trail.
    if (detail.path !== 'cx/errors') _addBreadcrumb('http', `${detail.path} failed`, { status: detail.status });
    if (_s.onError) {
      try { _s.onError(detail); } catch { /* never let a broken hook break sending */ }
    }
  }

  // Resolves to {} when no getAuthToken was configured (web's default —
  // cookies ride along on the fetch automatically) or when it throws/returns
  // nothing (e.g. logged out, AsyncStorage read failed) — never blocks sending.
  async function _authHeaders() {
    if (!_s.getAuthToken) return {};
    try {
      const token = await _s.getAuthToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    } catch {
      return {};
    }
  }

  // Query strings and #fragments often carry tokens, emails or ids — never send them.
  function _stripUrl(u) {
    return typeof u === 'string' ? u.split(/[?#]/)[0] : u;
  }

  function _nextSeq() {
    // Belt-and-suspenders alongside the init() guard above — if _s.sessionSeq
    // ever ends up non-finite by some other path, reset rather than let NaN
    // propagate (NaN + 1 = NaN forever, and JSON.stringify turns NaN into
    // `null`, which is worse than a reset counter but silent about it).
    if (!Number.isFinite(_s.sessionSeq)) _s.sessionSeq = 0;
    _s.sessionSeq += 1;
    storage.setItem('_ca_seq', String(_s.sessionSeq)).catch(() => { });
    return _s.sessionSeq;
  }

  function _lang() {
    if (_s.language) return _s.language;
    // React Native has no navigator.language; Hermes' Intl gives the device locale.
    const locale = (typeof navigator !== 'undefined' && navigator.language) || _intlLocale();
    return locale ? locale.split('-')[0] : '';
  }

  function _intlLocale() {
    try { return Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch { return ''; }
  }

  function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // captureException is an alias for trackError — same
  // function, same signature (Error|string, extra).
  return { init, login, identify, logout, track, impression, trackPage, trackError, captureException: trackError, trackFatal, trackPermission };
}
