/**
 * @hqpl/errors — React Native (Android, iOS). Metro picks this file over
 * index.js, so the import is the same as on web:
 *
 *   import errors from '@hqpl/errors';
 *   import AsyncStorage from '@react-native-async-storage/async-storage';
 *   errors.init({
 *     endpoint: 'https://api.example.com/api/cx/errors',
 *     projectName: 'my-app',
 *     release: 'my-app-1.0.0+42',      // must match the qtpack upload release
 *     storage: AsyncStorage,           // optional: keeps fatal crash reports across the restart
 *     getCurrentScreen: () => screen,  // optional: `source` of each report
 *   });
 *
 * init() reports uncaught JS errors (ErrorUtils), unhandled promise rejections
 * (Hermes) and failed fetch calls. The only dependency is react-native itself.
 */

import { AppState, Platform } from 'react-native';
import { createClient, reportRenderError, reactRootErrorHandlers } from './core.js';
import { installNativeHandlers } from './native-handlers.js';

const os = Platform.OS;

const client = createClient({
  platform: os === 'ios' || os === 'web' ? os : 'android',
  // No default storage: AsyncStorage is a native module the app may not have.
  // Pass it as init({ storage }) to keep fatal crash reports across the restart.
  storage: null,
  getLocation: () => '',
  getUserAgent: () => (typeof navigator !== 'undefined' && navigator.userAgent) || `ReactNative/${os}/${Platform.Version}`,
  getConnectionType: () => '',
  // Coming back to the foreground is a good moment to retry reports that failed.
  onRetry(cb) {
    AppState.addEventListener('change', (state) => { if (state === 'active') cb(); });
  },
  install(config, api) {
    installNativeHandlers(api, config, {
      ErrorUtils: globalThis.ErrorUtils,
      hermes: globalThis.HermesInternal,
      isDev: typeof __DEV__ !== 'undefined' && __DEV__,
    });
  },
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
