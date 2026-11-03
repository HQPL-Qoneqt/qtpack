/**
 * @hqpl/errors — web / React. React Native builds use index.native.js instead.
 *
 *   import errors, { reactRootErrorHandlers } from '@hqpl/errors';
 *   errors.init({ endpoint: 'https://api.example.com/api/cx/errors', projectName: 'my-app', release: 'my-app-1.0.0' });
 *   createRoot(el, reactRootErrorHandlers).render(<App />);
 *
 * init() reports uncaught errors, unhandled promise rejections and failed fetch
 * calls. Safe to import during server-side rendering: nothing touches `window`
 * until init() runs in a browser.
 */

import { createClient, reportRenderError, reactRootErrorHandlers } from './core.js';
import { installFetchTracking } from './fetch-tracking.js';

const SESSION_KEY = '_hqe_sid';
const hasWindow = typeof window !== 'undefined';

// Throws in some privacy modes and sandboxed iframes, so every access is guarded.
function _webStorage(kind) {
  try { return hasWindow ? window[kind] || null : null; } catch { return null; }
}

function _connType() {
  const c = typeof navigator !== 'undefined' ? navigator.connection : undefined;
  if (!c) return 'unknown';
  if (c.type === 'wifi' || c.type === 'ethernet') return 'wifi';
  if (c.type === 'cellular') return { '4g': '4g', '3g': '3g', '2g': '2g', 'slow-2g': '2g' }[c.effectiveType] || 'unknown';
  // No physical type (desktop browsers): a 4g effective type is almost always wifi or wired.
  if (c.effectiveType === '4g') return 'wifi';
  if (c.effectiveType === '3g') return '3g';
  if (c.effectiveType === '2g' || c.effectiveType === 'slow-2g') return '2g';
  return 'unknown';
}

function _json(value) {
  try { return JSON.stringify(value); } catch { return null; }
}

function _install(config, client) {
  if (!hasWindow) return;
  installFetchTracking(client, config);
  const seen = new Set();

  if (config.trackUncaughtErrors !== false) {
    window.addEventListener('error', (event) => {
      // Failed images, scripts and fonts also fire here, on the element; those are not code errors.
      if (event.target && event.target !== window) return;
      const key = `uncaught:${event.message}:${event.filename}:${event.lineno}`;
      if (seen.has(key)) return;
      seen.add(key);
      // event.error is null for some syntax errors and for cross-origin scripts without CORS.
      const err = event.error instanceof Error ? event.error : new Error(event.message || 'Uncaught error');
      client.captureException(err, {
        level: 'fatal',
        error_type: 'UncaughtError',
        error_code: err.name || '',
        endpoint: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '',
      });
    }, { capture: true });
  }

  if (config.trackUnhandledRejections !== false) {
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      const err = reason instanceof Error
        ? reason
        : new Error(typeof reason === 'string' ? reason : (_json(reason) || 'Unhandled promise rejection'));
      const key = `rejection:${err.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      client.captureException(err, { level: 'error', error_type: 'UnhandledRejection', error_code: err.name || '' });
    });
  }
}

const client = createClient({
  platform: 'web',
  keepalive: true,
  storage: {
    async getItem(key) { return _webStorage('localStorage')?.getItem(key) ?? null; },
    async setItem(key, value) { _webStorage('localStorage')?.setItem(key, value); },
  },
  // One session per tab, kept across reloads.
  sessionId() {
    const store = _webStorage('sessionStorage');
    try {
      const existing = store?.getItem(SESSION_KEY);
      if (existing) return existing;
      const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : '';
      if (id) store?.setItem(SESSION_KEY, id);
      return id;
    } catch {
      return '';
    }
  },
  getLocation: () => (hasWindow ? window.location?.pathname || '' : ''),
  getUserAgent: () => (typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''),
  getConnectionType: _connType,
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  onRetry(cb) {
    if (hasWindow) window.addEventListener('online', cb);
  },
  install: _install,
});

export const {
  init,
  captureException,
  trackError,
  captureMessage,
  trackFatal,
  trackFailedRequest,
  setUser,
  addBreadcrumb,
  flush,
  isEnabled,
} = client;
export { reportRenderError, reactRootErrorHandlers };
export default client;
