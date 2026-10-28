# Telemetry (Qtpack)

`@hqpl/qtpack` makes your production error stack traces readable.

When your app is built for release, the code is minified, so a crash shows up as
`a.js:1:48210`. qtpack uploads the build's **sourcemaps** to the telemetry backend, which
uses them to turn that back into `CheckoutScreen.tsx:42`.

It works with:

- **Web apps** built with Vite
- **React Native / Expo apps** (Android and iOS release builds)
- **Anything else**, through a small CLI

## How it works

1. At build time, qtpack gives every bundle a unique **debug ID** and writes the same ID
   into its sourcemap.
2. The sourcemap is uploaded to the backend, then removed from your build output so it never
   ships to users.
3. When an error happens, the telemetry SDK sends the debug ID with the stack trace. The
   backend finds the matching map and resolves the trace.

Because the ID comes from the bundle's content, the map always matches the exact build that
crashed. You don't need to bump a version or track a git SHA.

---

## Setup (do this once per project)

### 1. Install

```bash
npm install -D @hqpl/qtpack
```

### 2. Create an upload token

Each project (web app, mobile app) gets its own token. Run:

```bash
npx qtpack token new --project my-mobile-app
```

This prints two things:

| Output | What to do with it |
| --- | --- |
| The **token** (on screen) | Save it in your CI secrets as `SOURCEMAP_UPLOAD_TOKEN`. It is shown once and not stored anywhere. If you lose it, create a new one. |
| A line like `my-mobile-app:3f9a…` (the **hash**) | Add it to the backend's `SOURCEMAP_PROJECT_TOKENS` setting, then restart the backend. |

The project name must be lowercase letters, digits, `-` or `_`.

To use several projects, put one entry per line:

```bash
SOURCEMAP_PROJECT_TOKENS="my-web-app:<hash1>
my-mobile-app:<hash2>"
```

Only hashes are stored on the backend, so a leaked config can't be used to upload.
To rotate a token, create a new one and replace its line. To revoke it, remove the line.

### 3. Set two environment variables in your build or CI

| Variable | Value |
| --- | --- |
| `SOURCEMAP_UPLOAD_URL` | The telemetry backend's address, e.g. `https://telemetry.example.com` |
| `SOURCEMAP_UPLOAD_TOKEN` | The token from step 2 |

The token is read from the environment only, never from a command-line flag, so it stays out
of shell history.

Now follow the section for your app type: [Web](#web-apps-vite) or
[React Native / Expo](#react-native--expo).

---

## Web apps (Vite)

Add the plugin to `vite.config.ts`:

```ts
import sourcemapUploadPlugin from '@hqpl/qtpack/vite';

export default defineConfig({
  plugins: [
    react(),
    sourcemapUploadPlugin({
      platform: 'web',
      release: 'my-web-app-1.4.0', // see "Release name" below
    }),
  ],
});
```

Then build with the two env vars set:

```bash
SOURCEMAP_UPLOAD_URL=https://telemetry.example.com \
SOURCEMAP_UPLOAD_TOKEN=... \
npm run build
```

During the build the plugin:

1. Turns on hidden sourcemaps (unless you've set `build.sourcemap` yourself).
2. Stamps a debug ID into each bundle.
3. Uploads all the maps.
4. Deletes the maps from `dist/`.

If an upload fails, the maps are still deleted from `dist/` so they can't be deployed by
accident. Errors from that build just won't have readable stack traces.

If the env vars are missing, a local build only prints a warning. A build with `CI` set
fails, so a release can't go out without its maps.

**Plugin options**

| Option | Default | Meaning |
| --- | --- | --- |
| `release` | the `RELEASE` env var | Release name. Must match what you pass to the SDK's `init()`. Set it here or via `RELEASE`. |
| `platform` | `'web'` | `'web'`, `'android'` or `'ios'` |
| `deleteAfterUpload` | `true` | Remove maps from `dist/` after upload |
| `enabled` | `true` | Set `false` to turn the plugin off |
| `url`, `token` | env vars | Override `SOURCEMAP_UPLOAD_URL` / `SOURCEMAP_UPLOAD_TOKEN` |
| `failOnError` | `false` | Fail the build if the upload fails |

---

## React Native / Expo

React Native needs **three small changes**. Do all three.

| # | File | What it does |
| --- | --- | --- |
| 1 | `metro.config.js` | Stamps the debug ID into the JS bundle |
| 2 | `android/app/build.gradle` | Uploads the map after every Android release build |
| 3 | `ios/.xcode.env` | Uploads the map after every iOS release build |

Requires Node 20.19+ or 22.12+ (the same minimum Expo has).

### Step 1: `metro.config.js`

For a plain Expo app:

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withDebugIds } = require('@hqpl/qtpack/metro');

module.exports = withDebugIds(getDefaultConfig(__dirname));
```

If you already customise Metro (for example, to import `.svg` files), keep your changes and
call `withDebugIds` on the config **last**, right before you return it:

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withDebugIds } = require('@hqpl/qtpack/metro');

module.exports = (() => {
  const config = getDefaultConfig(__dirname);
  const { transformer, resolver } = config;

  config.transformer = {
    ...transformer,
    babelTransformerPath: require.resolve('react-native-svg-transformer'),
  };
  config.resolver = {
    ...resolver,
    assetExts: resolver.assetExts.filter((ext) => ext !== 'svg'),
    sourceExts: [...resolver.sourceExts, 'svg'],
  };

  // Stamps a debug ID into the bundle and its map, so crashes can be resolved.
  return withDebugIds(config);
})();
```

A bare React Native app works the same way. Start from the config in
`@react-native/metro-config` instead of Expo's.

### Step 2: Android (`android/app/build.gradle`)

Add this line **after** `apply plugin: "com.facebook.react"`:

```groovy
apply from: new File(["node", "--print", "require.resolve('@hqpl/qtpack/package.json')"].execute(null, rootDir).text.trim()).getParentFile().getAbsolutePath() + "/gradle/qtpack.gradle"
```

This adds an upload step to every release build, for both APK (`assembleRelease`) and AAB
(`bundleRelease`). It runs only after the JS bundle was built successfully, so a failed
build never uploads the previous build's map. Debug builds never upload.

To run the upload on its own: `./gradlew :app:qtpackUploadReleaseSourceMap`

### Step 3: iOS (`ios/.xcode.env`)

Add this to the end of the file:

```bash
# qtpack: Release builds write the JS sourcemap and upload it.
# Skipped when qtpack isn't installed, so the build never points at a missing script.
QTPACK_DIR="$("$NODE_BINARY" --print "require('path').dirname(require.resolve('@hqpl/qtpack/package.json'))" 2>/dev/null || true)"
if [ -n "$PROJECT_DIR" ] && [ -f "$QTPACK_DIR/bin/compose-source-maps.cjs" ]; then
  export SOURCEMAP_FILE="$PROJECT_DIR/build/sourcemaps/main.jsbundle.map"
  mkdir -p "$(dirname "$SOURCEMAP_FILE")"
  export COMPOSE_SOURCEMAP_PATH="$QTPACK_DIR/bin/compose-source-maps.cjs"
fi
```

No Xcode build phase is needed. Release builds and Archives (every IPA) upload their map;
debug builds don't.

> If you run `expo prebuild` and it regenerates the `ios/` folder, add this block again.

### Credentials for mobile builds

**Do not** put the token in your app's `.env` file. Libraries like `react-native-config` copy
that file into the APK/IPA, which would ship your token to users.

| Where you build | Android | iOS |
| --- | --- | --- |
| CI | Set `SOURCEMAP_UPLOAD_URL` and `SOURCEMAP_UPLOAD_TOKEN` as environment variables | Same |
| Your own machine | `~/.gradle/gradle.properties` (the user-level one, not the project's) | `ios/.xcode.env.local` (make sure it is gitignored) |

On a Mac you can keep the iOS token in the keychain instead of a file:

```bash
# ios/.xcode.env.local
export SOURCEMAP_UPLOAD_URL=https://telemetry.example.com
export SOURCEMAP_UPLOAD_TOKEN="$(security find-generic-password -s qtpack -a upload -w)"
```

If the credentials are missing, or an upload fails, the build **still succeeds** and prints a
warning, so qtpack never blocks a store build. To make CI fail instead, set
`SOURCEMAP_FAIL_ON_ERROR=1`.

### Release name

The release name labels errors on the dashboard and must be the same in two places: the
upload and the SDK's `init()`.

| App | Format | Example |
| --- | --- | --- |
| Web | `<project>-<version>` | `my-web-app-1.4.0` |
| Mobile | `<project>-<version>+<build>` | `my-mobile-app-2.3.0+57` |

For mobile builds qtpack builds the name itself:

- **Android:** `versionName` and `versionCode` from Gradle
- **iOS:** `CFBundleShortVersionString` and `CFBundleVersion` from Info.plist
- **`<project>`:** set `TELEMETRY_SOURCEMAPS_PROJECT` (environment variable or Gradle
  property). Without it, qtpack uses the lowercased Android project name or the iOS product name.

Pass the same string as `release` to `init()` in your app. Even if the release doesn't match,
the map is still found by its debug ID first.

### Uploading by hand

To upload from a build that already exists, run the same command the build hooks run:

```bash
npx qtpack react-native --platform android \
  --map android/app/build/generated/sourcemaps/react/release/index.android.bundle.map \
  --packager-map android/app/build/intermediates/sourcemaps/react/release/index.android.bundle.packager.map \
  --release "my-mobile-app-$VERSION+$BUILD"
```

---

## CLI (webpack, custom builds, CI steps)

For build tools without a plugin, run these after the build:

```bash
npx qtpack inject --dir dist          # stamp debug IDs (do this before deploying)
npx qtpack upload --dir dist --platform web --release "$RELEASE" --delete
npx qtpack upload --dir dist --platform web --dry-run   # preview only: no network, no deletes
```

| Flag | Meaning |
| --- | --- |
| `--dir` | Folder with your build output. Point it at the output, not the project root, because the search is recursive and would walk `node_modules`. |
| `--platform` | `web`, `android` or `ios` |
| `--release` | Release name (default: the `RELEASE` env var) |
| `--delete` | Delete local `.map` files after a successful upload |
| `--dry-run` | Show what would be uploaded without doing it |

`inject` can be run twice safely. Running it again changes nothing.

---

## Troubleshooting

| Problem | Likely cause |
| --- | --- |
| Stack traces on the dashboard are still minified | The map wasn't uploaded for that build. Check the build log for a qtpack warning, and that both env vars were set. |
| Build log says "config missing" | `SOURCEMAP_UPLOAD_URL` or `SOURCEMAP_UPLOAD_TOKEN` isn't set in that environment. |
| Upload returns 401 | The token's hash isn't in the backend's `SOURCEMAP_PROJECT_TOKENS`, or the backend wasn't restarted after you added it. |
| Upload returns 409 | A map with that name already exists for that release with different content. Use a new release name. |
| `require()` error loading `@hqpl/qtpack/metro` | Node is older than 20.19 / 22.12. Upgrade Node. |
| Android upload step doesn't appear | The `apply from:` line must come after `apply plugin: "com.facebook.react"`. |
| iOS doesn't upload | The block must be in `ios/.xcode.env`, and the build must be Release or Archive. |

---

## Safety

- Sourcemaps contain your original source code. Never serve them from a public path. The
  plugin and `--delete` remove them from your build output.
- Local files are deleted only after every upload succeeds.
- Two maps with the same name in one build are rejected.

## Development

```bash
npm test   # no network needed
```
