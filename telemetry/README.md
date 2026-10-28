# @hqpl/telemetry

Telemetry and error-tracking SDK for Hqpl web and React Native apps. It sends
sessions, page views, events and errors to the Hqpl telemetry service through
your backend's proxy.

```bash
npm install @hqpl/telemetry
```

```js
import telemetry from '@hqpl/telemetry';

telemetry.init({
  apiBase: 'https://api.example.com/api/', // your backend's proxy base
  platform: 'web',                          // 'web' | 'android' | 'ios'
  appVersion: '1.0.0',
  projectName: 'my-web-app',
  release: 'my-web-app-1.0.0',              // must match the sourcemap upload release
  environment: 'production',
  enabled: import.meta.env.PROD,            // false → nothing is sent (use to keep dev/staging out of the DB)
});

telemetry.track('button_click', { id: 'signup' });
telemetry.trackError(new Error('boom'));
```

Failed API calls (HTTP 5xx and network errors) are reported automatically. Turn that
off with `trackFailedRequests: false`, or narrow it with `failedRequestStatus` and
`ignoreRequests`. Request and response bodies and query strings are never sent.

## React Native

The import is the same. Metro picks the React Native build (`telemetry.native.js`)
for Android and iOS. It needs two packages in the app:

```bash
npx expo install @react-native-async-storage/async-storage @react-native-community/netinfo
```

```js
import telemetry from '@hqpl/telemetry';
import { Platform } from 'react-native';
import * as Application from 'expo-application';

await telemetry.init({
  apiBase: 'https://api.example.com/api/',
  platform: Platform.OS,                     // 'android' | 'ios'
  appVersion: Application.nativeApplicationVersion,
  projectName: 'hqpl',
  // Must match the release qtpack uploads with: <project>-<version>+<build>
  release: `hqpl-${Application.nativeApplicationVersion}+${Application.nativeBuildVersion}`,
  environment: __DEV__ ? 'development' : 'production',
  enabled: !__DEV__,
  getCurrentScreen: () => currentScreen,      // source of events and errors
  getAuthToken: () => getAccessToken(),       // RN has no cookies; return the bearer token
});

telemetry.identify(userId); // user already signed in at launch (no new login session)
telemetry.login(userId);    // user just signed in
```

With Expo Router, render the screen tracker once in the root layout:

```jsx
import { TelemetryScreenTracker } from '@hqpl/telemetry/expo-router';

<TelemetryScreenTracker />
```

`init()` on React Native also reports:

- **Uncaught JS errors** through `ErrorUtils`. The previous handler (React Native's
  red box or crash) still runs.
- **Fatal crashes.** The report is saved before the app closes, and the app is held
  open for up to 2 seconds while it is sent. If it isn't sent in time, it goes out
  on the next launch.
- **Unhandled promise rejections** through Hermes. Hermes keeps only one rejection
  tracker, so this replaces any set earlier. Pass
  `trackUnhandledRejections: false` to keep the other one.

Failed API calls are not tracked automatically on React Native (apps usually use
axios, not `fetch`). Report them from an axios interceptor with `trackError`.

Native crashes (Java/Kotlin, Objective-C/Swift) are not captured. Those show in
Google Play Console (Android vitals) and Xcode Organizer.

## Data collected

Sent to the `apiBase` you configure, and nowhere else:

- **Identifiers:** the user ID you pass to `login()`, a per-tab session ID and a sequence number.
- **Device and context:** user agent, timezone, language, connection type, platform and app version.
- **Pages:** the page URL and referrer with the query string and `#fragment` removed.
- **Events:** whatever you pass to `track()`.
- **Errors:** error name, message, stack trace, cause, and the last 25 breadcrumbs (tracked events, page navigations, login/logout, failed request paths).

It does not read form fields, cookies or storage contents, and it does not collect email addresses or phone numbers. Your server will still see the caller's IP address. Because a user ID is a persistent identifier, treat this as personal data under GDPR/CCPA and cover it in your privacy policy.

Error messages, `extra` fields and event properties are sent as you provide them, so keep personal data out of them.

## Privacy controls

- `scrubPii` (default `true`): email addresses, JWTs and `Bearer` values in any outgoing string are replaced with `[email]` / `[token]`.
- `beforeSend(payload, kind)`: called with every payload just before it is sent (`kind` is `'event'`, `'error'`, `'page_view'` or `'session'`). Return the payload, edited or not, to send it, or `null` to drop it. If it throws, the payload is dropped.
- `enabled: false` sends nothing at all.

```js
telemetry.init({
  // ...
  beforeSend(payload, kind) {
    if (kind === 'error') delete payload.breadcrumbs;
    return payload;
  },
});
```

React helpers (`ErrorBoundary`, impression hooks) are not part of this package.
Pair it with [`@hqpl/qtpack`](../qtpack) to upload sourcemaps so stack traces resolve
to original source.

## License

MIT
