# @hqpl/errors

Error tracking only, for web (React) and React Native apps. It reports uncaught
errors, unhandled promise rejections, failed API calls and React render errors
to the Hqpl analytics service, where they show on the Errors page under your
project. No events, sessions or page views. For those, use
[`@hqpl/telemetry`](../telemetry) instead. Don't install both: each one
reports the same errors.

Stack traces are resolved on the server with the sourcemaps that
[`@hqpl/qtpack`](../telemetry-sourcemaps) uploads.

```bash
npm install @hqpl/errors
npm install -D @hqpl/qtpack
```

The import is the same on every platform. Metro picks the React Native build
for Android and iOS; Vite, webpack and other bundlers pick the web build.

## Web (React)

```js
import errors, { reactRootErrorHandlers } from '@hqpl/errors';

errors.init({
  endpoint: 'https://api.example.com/api/cx/errors',
  projectName: 'my-web-app',          // a-z, 0-9, _ or -; same as the qtpack upload project
  release: 'my-web-app-1.4.0',        // same as the qtpack upload release
  environment: 'production',
  enabled: import.meta.env.PROD,      // false: nothing is sent and nothing is installed
});

// React 19: also reports render errors that a route's error screen or your own boundary caught.
createRoot(document.getElementById('root'), reactRootErrorHandlers).render(<App />);
```

Apps behind the Qoneqt backend proxy can pass `apiBase: '/api/'` instead of
`endpoint`. Reports then go to `/api/cx/errors`.

## React Native

```js
import errors from '@hqpl/errors';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';

errors.init({
  endpoint: 'https://api.example.com/api/cx/errors',
  projectName: 'my-app',
  appVersion: Application.nativeApplicationVersion,
  // Same release qtpack uploads with: <project>-<version>+<build>
  release: `my-app-${Application.nativeApplicationVersion}+${Application.nativeBuildVersion}`,
  environment: __DEV__ ? 'development' : 'production',
  enabled: !__DEV__,
  storage: AsyncStorage,              // optional, see "Fatal crashes"
  getCurrentScreen: () => currentScreen,
  getAuthToken: () => AsyncStorage.getItem('authToken'),
});
```

The only required dependency is `react-native`. On React Native, `init()` installs:

- **Uncaught JS errors** through `ErrorUtils`. The previous handler (the red box,
  or the crash in release) still runs.
- **Fatal crashes.** The app is held open for up to 2 seconds while the report is
  sent. With `storage` (AsyncStorage), the report is saved first, and one that
  wasn't sent in time goes out on the next launch. Without `storage`, that report is lost.
- **Unhandled promise rejections** through Hermes. Hermes keeps one rejection
  tracker, so this replaces any set earlier. `trackUnhandledRejections: false`
  keeps the other one.

Native crashes (Java/Kotlin, Objective-C/Swift) are not captured. Those show in
Play Console (Android vitals) and Xcode Organizer.

## Error boundary (React and React Native)

```jsx
import { ErrorBoundary } from '@hqpl/errors/react';

<ErrorBoundary fallback={({ error, reset }) => <ErrorScreen onRetry={reset} />}>
  <Checkout />
</ErrorBoundary>
```

The boundary reports what it catches. An error that also reaches
`reactRootErrorHandlers` is reported only once.

## Failed API calls

`fetch` is wrapped on both platforms: responses with status 500 and above and
network failures are reported, one issue per route (`/users/41` and `/users/42`
are the same issue). Only the method, the URL path and the status are sent:
never query strings, headers or bodies. Aborted requests are not reported.

```js
errors.init({
  // ...
  trackFailedRequests: true,                 // default
  failedRequestStatus: (s) => s >= 500,      // default
  ignoreRequests: ['/health', /\/analytics\//],
});
```

The wrapper doesn't see axios. Report from an interceptor:

```js
api.interceptors.response.use(undefined, (error) => {
  const status = error.response?.status ?? 0;
  if (status === 0 || status >= 500) {
    errors.trackFailedRequest({ method: error.config?.method, url: error.config?.url, status, error });
  }
  return Promise.reject(error);
});
```

## Manual reporting

```js
try {
  await pay();
} catch (err) {
  errors.captureException(err, { error_type: 'PaymentError', level: 'warning' });
}

errors.captureMessage('Cart total was negative', 'warning');
errors.setUser(21277);       // numeric user ID; null on logout
errors.addBreadcrumb('checkout', 'applied coupon', { code: 'SAVE10' });
```

`captureException` takes an Error (preferred, because it carries the stack) or
anything else. Its second argument is merged into the report last, so it can set
any report field (`level`, `error_type`, `error_code`, `fingerprint`, `endpoint`
and others; see `ErrorPayload` in `src/index.d.ts`). The server ignores fields
it doesn't know, so put extra context in a breadcrumb's `data`.

The same error is sent at most 3 times a minute. Reports that fail to send
because the device is offline or the server returns 5xx are queued and retried
when the browser comes back online or the app returns to the foreground, or when
you call `errors.flush()`.

## Sourcemaps

Use the same project name and release in `init()` and in qtpack. See the
[qtpack README](../telemetry-sourcemaps/README.md) for the Vite plugin and the
React Native Gradle/Xcode hooks. qtpack writes a debug ID into each bundle, and
this SDK sends the debug IDs of the files in the stack, so the server finds the
exact sourcemap even if the release string is wrong.

### Adding a new app

1. Choose a project slug, e.g. `billing-web`.
2. Register it: generate an upload token and add its SHA-256 hash to the
   analytics service's `SOURCEMAP_PROJECT_TOKENS` (`billing-web:<sha256hex>`),
   then restart the service. The token itself goes only into the app's CI,
   never into the app code.
3. Install `@hqpl/errors`, call `init({ projectName: 'billing-web', ... })` and
   upload sourcemaps with qtpack from CI.

The server accepts errors only for registered projects. A report with a
missing or unregistered `projectName` is refused with 403 and not retried, so
register the project before the app ships. Once it is registered, the app's
errors appear on the Errors page under that project. No code change is needed
on the server or the dashboard.

## Privacy

- `scrubPii` (default `true`): email addresses, JWTs and `Bearer` values are
  replaced with `[email]` and `[token]` in every string of every report.
- `beforeSend(payload)`: return the report (edited or not) to send it, or `null`
  to drop it. If it throws, the report is dropped.
- Query strings and `#fragments` are removed from the page and request URLs.

Each report carries: error name, message, stack, cause, component stack, the
last 25 breadcrumbs, page path or screen, user agent, language, timezone,
connection type (web), the user ID you set and a per-session ID. The server also
sees the caller's IP address. A user ID is personal data under GDPR/CCPA.

## License

MIT
