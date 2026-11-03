// React Native error hooks. Kept apart from index.native.js, which imports
// 'react-native', so they can be tested with stand-ins for ErrorUtils and Hermes.

import { installFetchTracking } from './fetch-tracking.js';

// How long a fatal crash may hold the app open while its report is saved and sent.
export const FATAL_REPORT_TIMEOUT_MS = 2000;

function _json(value) {
  try { return JSON.stringify(value); } catch { return null; }
}

// An Error, or a string when there is none: an Error made here would carry this
// file's stack and group unrelated reports together.
function _asError(value, fallback) {
  if (value instanceof Error || (value && typeof value === 'object' && typeof value.message === 'string')) return value;
  if (typeof value === 'string') return value;
  return _json(value) || fallback;
}

// deps: { ErrorUtils, hermes, isDev, setTimeout }
export function installNativeHandlers(client, config, deps) {
  installFetchTracking(client, config);
  if (config.trackUncaughtErrors !== false) _installErrorHandler(client, deps);
  if (config.trackUnhandledRejections !== false) _installRejectionTracking(client, deps);
}

// ErrorUtils is React Native's window.onerror. The previous handler (the red
// box in development, the crash in release) still gets every error.
function _installErrorHandler(client, { ErrorUtils, isDev, setTimeout: delay = setTimeout }) {
  if (!ErrorUtils?.setGlobalHandler) return;
  const previous = ErrorUtils.getGlobalHandler?.();
  let fatalInProgress = false;

  ErrorUtils.setGlobalHandler((error, isFatal) => {
    const err = _asError(error, 'Uncaught error');
    const name = err?.name || '';

    if (!isFatal) {
      client.captureException(err, { level: 'error', error_type: 'UncaughtError', error_code: name, is_fatal: false });
      previous?.(error, isFatal);
      return;
    }

    // The app is already closing for the first fatal error.
    if (fatalInProgress) return;
    fatalInProgress = true;
    const report = client.trackFatal(err, { error_type: 'FatalError', error_code: name, is_fatal: true });

    // In development the red box shows instead of closing the app, so don't make it wait.
    if (isDev) {
      fatalInProgress = false;
      previous?.(error, isFatal);
      return;
    }
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      previous?.(error, isFatal);
    };
    const timer = delay(close, FATAL_REPORT_TIMEOUT_MS);
    report.then(close, close).finally(() => clearTimeout(timer));
  });
}

// React Native only tracks unhandled rejections in development (to warn), so
// release builds report none unless something turns tracking on. Hermes keeps
// one tracker: this replaces React Native's (its development warning is kept)
// and any set before init().
function _installRejectionTracking(client, { hermes, isDev }) {
  if (!hermes?.enablePromiseRejectionTracker || hermes.hasPromise?.() === false) return;
  hermes.enablePromiseRejectionTracker({
    allRejections: true,
    onUnhandled(id, rejection) {
      const err = _asError(rejection, 'Unhandled promise rejection');
      if (isDev) console.warn(`Possible unhandled promise rejection (id: ${id}):\n${err?.stack || err?.message || err}`);
      client.captureException(err, { level: 'error', error_type: 'UnhandledRejection', error_code: err?.name || '' });
    },
    onHandled() {},
  });
}
