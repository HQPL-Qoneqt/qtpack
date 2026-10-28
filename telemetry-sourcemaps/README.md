# telemetry-sourcemaps

Stamps a debug ID into each build and uploads its `.map` files to the telemetry
backend, which stores them in the bucket so error stack traces resolve to
original source. It has three entry points:

- **Vite plugin**: stamps debug IDs and uploads at the end of `vite build`, then
  deletes the maps from `dist/`.
- **Metro wrapper** (`src/metro.cjs`): stamps debug IDs into React Native /
  Expo bundles. A Gradle script (`gradle/telemetry-sourcemaps.gradle`) and an Xcode hook
  (`bin/compose-source-maps.cjs`) upload the map from every release build.
- **CLI** (`telemetry-sourcemaps inject` / `upload` / `react-native`): for webpack or CI
  steps that run outside the bundler.

Projects never hold bucket credentials. Each project gets its own upload
token, and the backend checks it on every request (`POST /analytics/sourcemaps`).

## Debug IDs

A debug ID is a UUID derived from a bundle's content. The build writes it into
the bundle's map (`"debugId"`) and adds a one-line snippet to the bundle that
registers it at runtime. When an error happens, the SDK sends the IDs of the
bundles in the stack (`debug_ids`), and the backend picks the map by ID.

So the map always matches the exact build that crashed:

- Forgetting to bump the version doesn't matter: a new build has new content, so
  a new ID.
- Rebuilding the same code gives the same ID, so a re-upload just replaces it.
- No git SHA or build counter is needed.

The release is still sent and stored. It labels errors on the dashboard, and
maps without a debug ID (older builds, Hermes maps that lost it) are still
found by release, as before.

How the snippet gets in:

- **Vite / any JS output on disk**: prepended as a new first line, and the
  map's `mappings` gets one leading `;` so every position still lines up.
- **Metro**: shipped as a polyfill containing a 36-character placeholder, so it
  runs before any app module and is part of every map Metro builds (including
  the dev server's `.map` endpoint, which skips custom serializers). The
  serializer then swaps the placeholder for the real ID, which is also 36
  characters, so nothing moves.

## Setting up a project

Projects are named by slug: one slug per app, one key per project:

| project | app | version comes from | release |
| --- | --- | --- | --- |
| `my-web-app` | web app | its `package.json` | `my-web-app-<version>` |
| `my-mobile-app` | mobile app | native version + build number (`DeviceInfo.getVersion()`, `getBuildNumber()`) | `my-mobile-app-<version>+<build>` |

The release starts with `<project>-<version>`. The SDK reports it on errors, and
the upload uses the same string.

1. Issue the project's key. The token is generated locally, printed once, and
   never stored by the tool:
   ```bash
   npx telemetry-sourcemaps token new --project telemetry
   ```
   The token goes to stdout. The `SOURCEMAP_PROJECT_TOKENS` entry (`name:sha256`)
   goes to stderr. Save the token in the project's CI secret as
   `SOURCEMAP_UPLOAD_TOKEN`. If it's lost, issue a new one.
2. Add the entry to the telemetry backend's env and restart it. Entries can
   be comma-joined on one line or split one-per-line (either is accepted;
   one-per-line reads far better once there's more than one 64-char hash):
   ```bash
   # SOURCEMAP_PROJECT_TOKENS="telemetry:<hash>
   # my-web-app:<hash2>
   # my-mobile-app:<hash3>"
   ```
   Only hashes live in config, so a leaked env never leaks a usable token. The
   backend rejects names that aren't slugs (lowercase, digits, `_`, `-`, max 64).
   To rotate, issue a new token, put the new entry in place of the old one, and
   restart. To revoke, remove the entry and restart.
   `token hash` prints the hash of a token read from stdin, to check an entry.
3. Install the package: `npm install -D @hqpl/telemetry-sourcemaps`.

## Configuration

| variable | where | meaning |
| --- | --- | --- |
| `SOURCEMAP_UPLOAD_URL` | build/CI | telemetry backend base URL, e.g. `https://telemetry.example.com` |
| `SOURCEMAP_UPLOAD_TOKEN` | build/CI secret | the project's upload token |
| `RELEASE` | CLI only | default for `--release`. The Vite plugin takes `release` as an option instead. |

The token is read from the environment only, never a flag, so it stays out of
shell history and `ps` output.

## Vite plugin

`vite.config.ts`:

```ts
import sourcemapUploadPlugin from '@hqpl/telemetry-sourcemaps/vite';

plugins: [react(), sourcemapUploadPlugin({ platform: 'web', release: RELEASE })],
```

```bash
SOURCEMAP_UPLOAD_URL=http://localhost:8080 SOURCEMAP_UPLOAD_TOKEN=... npm run build
```

`RELEASE` is computed in `vite.config.ts` as `<project>-<package.json version>`
(see "Setting up a project"), so the app sets it, not the environment.

Options: `url`, `token`, `release` (required, no env fallback in the app),
`platform` (default `web`), `deleteAfterUpload` (default `true`), `enabled`
(default `true`). `url` and `token` fall back to their env vars.

What happens during a build:

- **Config present:** sets `build.sourcemap = 'hidden'` unless you set it
  yourself, stamps a debug ID into every bundle that has a map, uploads every
  map, then deletes them. A failed upload fails the build and deletes nothing.
- **Config missing, local build:** logs a warning. No maps are generated, so
  none can be deployed by accident.
- **Config missing, `CI` set:** fails the build, so a release can't ship without its maps.

## React Native / Expo (Metro)

`metro.config.js`:

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withDebugIds } = require('@hqpl/telemetry-sourcemaps/metro');

module.exports = withDebugIds(getDefaultConfig(__dirname));
```

Bare React Native works the same way with `@react-native/metro-config`'s
config. Needs Node 20.19+ or 22.12+ (Expo's minimum), which can `require()` the
ES module the wrapper uses.

### Upload from the release build (APK, AAB, IPA)

Every release build uploads its own map, so a store build can't ship without one.
Debug builds never upload.

**Android** (`assembleRelease` for an APK, `bundleRelease` for an AAB). In
`android/app/build.gradle`, after `apply plugin: "com.facebook.react"`:

```groovy
apply from: new File(["node", "--print", "require.resolve('@hqpl/telemetry-sourcemaps/package.json')"].execute(null, rootDir).text.trim()).getParentFile().getAbsolutePath() + "/gradle/telemetry-sourcemaps.gradle"
```

This adds `telemetrySourcemapsUpload<Variant>SourceMap` for each release variant. It runs
after React Native's `createBundle<Variant>JsAndAssets` and before
`assemble<Variant>` (APK) and `bundle<Variant>` (AAB). It runs only after a
successful bundle step, so a failed build never uploads the previous build's
map. Run it alone with `./gradlew :app:telemetrySourcemapsUploadReleaseSourceMap`.

**iOS** (a Release build or Archive, so every IPA). Append to `ios/.xcode.env`:

```bash
# telemetry-sourcemaps: Release builds (every IPA) write the JS sourcemap and upload it.
# Skipped when telemetry-sourcemaps isn't installed, so the build never points at a missing script.
TELEMETRY_SOURCEMAPS_DIR="$("$NODE_BINARY" --print "require('path').dirname(require.resolve('@hqpl/telemetry-sourcemaps/package.json'))" 2>/dev/null || true)"
if [ -n "$PROJECT_DIR" ] && [ -f "$TELEMETRY_SOURCEMAPS_DIR/bin/compose-source-maps.cjs" ]; then
  export SOURCEMAP_FILE="$PROJECT_DIR/build/sourcemaps/main.jsbundle.map"
  mkdir -p "$(dirname "$SOURCEMAP_FILE")"
  export COMPOSE_SOURCEMAP_PATH="$TELEMETRY_SOURCEMAPS_DIR/bin/compose-source-maps.cjs"
fi
```

`PROJECT_DIR` is only set inside Xcode, so `pod install` skips the block.

`react-native-xcode.sh` only writes a map when `SOURCEMAP_FILE` is set. Then it
calls `COMPOSE_SOURCEMAP_PATH` in place of React Native's compose script.
telemetry-sourcemaps's version runs the original and then uploads. No Xcode build phase is
added. If `ios/` is regenerated by `expo prebuild`, add the block again.

**What both do:** React Native's Hermes step (`compose-source-maps.js`) drops
`"debugId"` from the final map, so it is copied back from Metro's map first.
Then the map is uploaded as `index.android.bundle.map` or `main.jsbundle.map`,
which is the on-device bundle name plus `.map`.

**Credentials.** Never put them in the app's `.env`: `react-native-config`
copies that file into the APK/IPA. Use one of these:

| | Android | iOS |
| --- | --- | --- |
| CI | env `SOURCEMAP_UPLOAD_URL`, `SOURCEMAP_UPLOAD_TOKEN` | same |
| your machine | `~/.gradle/gradle.properties` (user-level, not the project's) | `ios/.xcode.env.local` (gitignored) |

```bash
# ios/.xcode.env.local (macOS keychain, so the token is not in a file)
export SOURCEMAP_UPLOAD_URL=https://telemetry.example.com
export SOURCEMAP_UPLOAD_TOKEN="$(security find-generic-password -s telemetry-sourcemaps -a upload -w)"
```

Without them the build still succeeds and logs a warning. A failed upload, or
even a crash inside telemetry-sourcemaps, also only warns, so telemetry-sourcemaps can never block a store
build. Set `SOURCEMAP_FAIL_ON_ERROR=1` in CI to fail the build instead, so a
release can't ship without its map.

**Release** is `<project>-<version>+<build>`. On Android that is `versionName`
and `versionCode`. On iOS it is `CFBundleShortVersionString` and
`CFBundleVersion` from Info.plist. `<project>` is `TELEMETRY_SOURCEMAPS_PROJECT` (env or Gradle
property). It defaults to the lowercased `rootProject.name` (Android) or
`PRODUCT_NAME` (iOS). Pass the same string as `release` to the SDK's `init()`.
The map is still found by its debug ID first.

**Running next to Sentry** (e.g. while migrating off it): wrap Sentry's config,
`withDebugIds(getSentryExpoConfig(__dirname))`. If the bundle already has a debug
ID, telemetry-sourcemaps uses that same ID, so both tools' maps match the bundle and both keep
resolving. telemetry-sourcemaps looks in three places: the map's `debugId`, the `//# debugId=`
comment, and Sentry's `sentry-dbid-<id>` snippet. Expo's serializer computes
that ID for release exports, and Sentry only reuses Expo's. So telemetry-sourcemaps doesn't
depend on Sentry: once Sentry is removed (switch the base to `getDefaultConfig`
from `expo/metro-config`), it uses Expo's ID, or makes its own from the bundle's
content.

To upload by hand from an existing build, run the same command the hooks run:

```bash
npx telemetry-sourcemaps react-native --platform android \
  --map android/app/build/generated/sourcemaps/react/release/index.android.bundle.map \
  --packager-map android/app/build/intermediates/sourcemaps/react/release/index.android.bundle.packager.map \
  --release "my-mobile-app-$VERSION+$BUILD"
```

## CLI

```bash
npx telemetry-sourcemaps inject --dir dist                 # stamp debug IDs, before deploying
npx telemetry-sourcemaps upload --dir dist --platform web --release "$RELEASE" --delete
npx telemetry-sourcemaps upload --dir build --platform web --dry-run   # no network, no deletes
```

`inject` stamps every bundle under `--dir` that has a `.map` next to it as text
(`index-abc.js` + `index-abc.js.map`). Bytecode bundles are skipped. Running it
twice is a no-op. The Vite plugin and Metro wrapper do this for you.

`upload` flags: `--dir` (searched recursively), `--platform` (`web|android|ios`),
`--release` (default `$RELEASE`), `--delete`, `--dry-run`.

Point `--dir` at the build output, not the project root. The search is
recursive and would otherwise walk `node_modules`.

## What the backend enforces

`POST /analytics/sourcemaps`: multipart form with `platform`, `release` and
one or more `file` parts. Each request is checked before anything is written:

- The token must match a project in `SOURCEMAP_PROJECT_TOKENS` (401 otherwise).
- `platform` is `web`, `android` or `ios`. `release` is 1 to 128 characters of
  letters, digits, `. _ + -`.
- Each file is a plain `*.map` name, at most 50 MiB, and a version 3 sourcemap.
  A `debugId`, if present, must be a UUID.
- Up to 20 files per request. The request body is capped at 120 MiB. The
  batch is all-or-nothing on validation: one bad file writes nothing.
- A map with a debug ID goes to `deployed-map-files/<project>/<release>/<id>.map`.
  Uploading it again replaces it. Each release has its own folder, so retiring a
  build is deleting that one prefix; a newer release that ships an unchanged chunk
  has its own copy. Maps uploaded earlier sit at `debug-ids/<release>/<id>.map` or flat at
  `debug-ids/<id>.map`, which the backend still reads.
- A map without one goes to `deployed-map-files/<project>/<platform>/<release>/<name>`.
  If that file already exists with different content, it's a 409 and nothing
  is written. Identical content is accepted.

## Safety rules

- Maps include `sourcesContent`, which is your original source. Never serve
  them from a public path. The plugin and `--delete` remove them from build output.
- Local files are deleted only after every batch succeeds.
- Duplicate map names in one build are rejected.

## Distribution

Published to npm as `@hqpl/telemetry-sourcemaps`. It has no runtime dependencies. Vite is an
optional peer dependency, needed only for the `/vite` and `/vite-dev` plugins.

Subpath imports: `@hqpl/telemetry-sourcemaps/vite`, `@hqpl/telemetry-sourcemaps/vite-dev`,
`@hqpl/telemetry-sourcemaps/metro`. The CLI is `npx telemetry-sourcemaps`.

## Tests

```bash
npm test   # node:test, fake fetch; no network needed
```
