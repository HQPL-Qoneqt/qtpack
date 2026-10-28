/**
 * Hqpl Telemetry SDK (React Native). Metro picks this file over telemetry.js
 * for Android and iOS builds, so the import is the same as on web:
 *
 *   import telemetry from '@hqpl/telemetry';
 *   await telemetry.init({
 *     apiBase: 'https://api.example.com/api/',
 *     platform: Platform.OS,                 // 'android' | 'ios'
 *     appVersion: '3.1.87',
 *     release: 'hqpl-3.1.87+178',          // must match the sourcemap upload release
 *     getCurrentScreen: () => currentScreen,
 *     getAuthToken: () => AsyncStorage.getItem('authToken'),
 *   });
 *
 * Needs @react-native-async-storage/async-storage and
 * @react-native-community/netinfo installed in the app.
 *
 * init() also reports uncaught JS errors (ErrorUtils) and unhandled promise
 * rejections (Hermes). A fatal error's report is saved before the app closes
 * and sent on the next launch if it couldn't be sent in time.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { AppState, Platform } from 'react-native';
import { createTelemetry } from './telemetry-core.js';

// ── connection type (maintained via NetInfo listener) ─────────────────────────

let _connType = 'unknown';
let _isConnected = true;
const _onOnlineCbs = [];

NetInfo.fetch().then(s => { _connType = _mapNetInfo(s); _isConnected = s?.isConnected !== false; }).catch(() => {});
NetInfo.addEventListener(s => {
  const wasConnected = _isConnected;
  _connType = _mapNetInfo(s);
  // null means "not known yet", which shouldn't hold reports back.
  _isConnected = s?.isConnected !== false;
  if (!wasConnected && _isConnected) _onOnlineCbs.forEach(cb => cb());
});

// The backend accepts wifi, 4g, 3g, 2g and unknown. Wired counts as wifi, as on web.
function _mapNetInfo(state) {
  if (!state || state.type === 'none' || state.type === 'unknown') return 'unknown';
  if (state.type === 'wifi' || state.type === 'ethernet') return 'wifi';
  if (state.type === 'cellular') {
    const gen = state.details?.cellularGeneration;
    if (gen === '5g' || gen === '4g') return '4g';
    if (gen === '3g') return '3g';
    if (gen === '2g') return '2g';
    return 'unknown';
  }
  return 'unknown';
}

// ── RN adapters ───────────────────────────────────────────────────────────────

function _device() {
  // Android reports brand and model; iOS exposes no model name without a native module.
  const c = Platform.constants || {};
  return [c.Brand, c.Model].filter(Boolean).join(' ');
}

const _rnAdapters = {
  storage: AsyncStorage,

  getConnectionType: () => _connType,

  onBackground(cb) {
    AppState.addEventListener('change', state => {
      if (state === 'background' || state === 'inactive') cb();
    });
  },

  onForeground(cb) {
    AppState.addEventListener('change', state => {
      if (state === 'active') cb();
    });
  },

  onOnline(cb) { _onOnlineCbs.push(cb); },
  isOnline: () => _isConnected,

  getLocation: () => '',  // replaced by getCurrentScreen passed in init()

  getUserAgent() {
    if (typeof navigator !== 'undefined' && navigator.userAgent) return navigator.userAgent;
    return `ReactNative/${Platform.OS}/${Platform.Version}`;
  },

  getDevice: _device,

  fetchOptions: {},  // keepalive is browser-only
};

function safeJSON(value) {
  try { return JSON.stringify(value); } catch { return null; }
}

// An Error, or a string when there is none: a new Error made here would carry
// this file's stack and group unrelated reports together.
function _asError(value, fallback) {
  if (value instanceof Error || (value && typeof value === 'object' && typeof value.message === 'string')) return value;
  if (typeof value === 'string') return value;
  return safeJSON(value) || fallback;
}

// ── create and export ─────────────────────────────────────────────────────────

const _core = createTelemetry(_rnAdapters);

// How long a fatal crash may keep the app open while its report is saved and sent.
const FATAL_REPORT_TIMEOUT_MS = 2000;

let _errorHandlerInstalled = false;
let _fatalInProgress = false;

// ErrorUtils is the RN equivalent of window.onerror. The previous handler (RN's
// red box or crash) still gets every error.
function _installErrorHandler() {
  if (_errorHandlerInstalled || typeof ErrorUtils === 'undefined') return;
  _errorHandlerInstalled = true;
  const previous = ErrorUtils.getGlobalHandler();

  ErrorUtils.setGlobalHandler((error, isFatal) => {
    const err = _asError(error, 'Uncaught error');
    const name = err?.name || '';

    if (!isFatal) {
      HqplTelemetry.trackError(err, { level: 'error', error_type: 'UncaughtError', error_code: name, is_fatal: false });
      previous?.(error, isFatal);
      return;
    }

    // The app is already closing for the first fatal error.
    if (_fatalInProgress) return;
    _fatalInProgress = true;

    const report = _core.trackFatal(err, { error_type: 'FatalError', error_code: name, is_fatal: true });
    // In development the red box shows instead of closing the app, so don't make it wait.
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      _fatalInProgress = false;
      previous?.(error, isFatal);
      return;
    }
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      previous?.(error, isFatal);
    };
    const timer = setTimeout(close, FATAL_REPORT_TIMEOUT_MS);
    report.then(close, close).finally(() => clearTimeout(timer));
  });
}

// React Native only tracks unhandled rejections in development (to warn), so
// release builds report none unless something turns tracking on. Hermes keeps
// one tracker: this replaces RN's development one (its warning is kept below)
// and any set before init().
function _installRejectionTracking() {
  const hermes = globalThis.HermesInternal;
  if (!hermes?.enablePromiseRejectionTracker || hermes.hasPromise?.() === false) return;
  hermes.enablePromiseRejectionTracker({
    allRejections: true,
    onUnhandled(id, rejection) {
      const err = _asError(rejection, 'Unhandled promise rejection');
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(`Possible unhandled promise rejection (id: ${id}):\n${err?.stack || err?.message || err}`);
      }
      HqplTelemetry.trackError(err, { level: 'error', error_type: 'UnhandledRejection', error_code: err?.name || '' });
    },
    onHandled() {},
  });
}

// init() options beyond the shared ones (all optional):
//   trackUncaughtErrors        false leaves ErrorUtils alone. Default true.
//   trackUnhandledRejections   false leaves Hermes' rejection tracker alone. Default true.
async function init(config) {
  await _core.init(config);
  if (config.enabled === false) return;
  if (config.trackUncaughtErrors !== false) _installErrorHandler();
  if (config.trackUnhandledRejections !== false) _installRejectionTracking();
}

const HqplTelemetry = { ..._core, init };

export default HqplTelemetry;
