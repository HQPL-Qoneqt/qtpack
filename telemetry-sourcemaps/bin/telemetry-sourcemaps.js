#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolveUploadConfig } from '../src/config.js';
import { copyDebugId, injectDebugIds } from '../src/debug-id.js';
import { describeError, uploadSourcemaps } from '../src/upload.js';
import { assertProjectName, hashToken, newToken } from '../src/token.js';
import { iosRelease, uploadReactNativeMap } from '../src/react-native.js';

const USAGE = `Usage:
  telemetry-sourcemaps inject --dir <path>
  telemetry-sourcemaps copy-debug-id --from <metro map> --to <final map>
  telemetry-sourcemaps upload --dir <path> --platform <web|android|ios> [options]
  telemetry-sourcemaps react-native --platform <android|ios> --map <path> [options]
  telemetry-sourcemaps token new --project <name>
  telemetry-sourcemaps token hash            (reads the token from stdin)

inject: stamps a debug ID into every bundle under --dir that has a .map next
  to it, so errors resolve against that exact build. Run it after the build
  and before deploying and uploading. (The Vite plugin and the Metro wrapper
  in src/metro.cjs do this for you.)

copy-debug-id: copies "debugId" from Metro's map into the map React Native's
  Hermes step produces, which drops it (Android: from
  intermediates/sourcemaps/react/release/index.android.bundle.packager.map).

upload: uploads every .map file under --dir to the telemetry backend.

react-native: what the Android (gradle/telemetry-sourcemaps.gradle) and iOS
  (bin/compose-source-maps.cjs) release builds run. Copies the debug ID from
  --packager-map into --map, then uploads --map. A missing token or a failed
  upload only warns, unless SOURCEMAP_FAIL_ON_ERROR=1.
  --map <path>          the final (Hermes-composed) map
  --packager-map <path> Metro's map, to copy the debug ID from (optional)
  --release <string>    default on iOS: <product>-<version>+<build> from Xcode

Options:
  --dir <path>        directory to search for .map files (required)
  --platform <name>   web | android | ios (required)
  --release <string>  must match the release passed to the SDK init()
                      (default: $RELEASE)
  --delete            delete local .map files after a successful upload
  --dry-run           print what would be uploaded; no network, no deletes
  -h, --help          show this help

token new: creates a project upload token (shown once).
  --project <name>    project slug, e.g. telemetry | my-web-app | my-mobile-app
  Prints the token to stdout only. Prints the SOURCEMAP_PROJECT_TOKENS
  entry (name:sha256) to stderr. Put the token in the project's CI secret
  as SOURCEMAP_UPLOAD_TOKEN, and the entry in the backend env. The token
  is not stored anywhere by this command.

token hash: prints the SOURCEMAP_PROJECT_TOKENS hash of a token read from stdin.

Environment (upload):
  SOURCEMAP_UPLOAD_URL   telemetry backend base URL, e.g. https://telemetry.example.com
  SOURCEMAP_UPLOAD_TOKEN this project's upload token (keep it in CI secrets)
`;

function fail(message) {
  console.error(`telemetry-sourcemaps: ${message}`);
  process.exit(1);
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

async function runToken(args) {
  const [sub, ...flags] = args;
  if (sub === 'new') {
    const { values } = parseArgs({
      args: flags,
      options: { project: { type: 'string' } },
      strict: true,
    });
    if (!values.project) fail('--project is required (e.g. telemetry, my-web-app, my-mobile-app)');
    try {
      assertProjectName(values.project);
    } catch (err) {
      fail(err.message);
    }
    const token = newToken();
    // Token on stdout only, so `telemetry-sourcemaps token new ... | pbcopy` works and
    // nothing leaks into logs via stderr. The hash line is what the backend needs.
    process.stdout.write(`${token}\n`);
    console.error(`SOURCEMAP_PROJECT_TOKENS entry for ${values.project} (add to backend env, then restart):`);
    console.error(`${values.project}:${hashToken(token)}`);
    console.error('The token is shown once and is not stored. Save it to the project CI secret SOURCEMAP_UPLOAD_TOKEN.');
    return;
  }
  if (sub === 'hash') {
    const token = await readStdin();
    if (!token) fail('no token on stdin');
    console.log(hashToken(token));
    return;
  }
  fail(`token needs a subcommand: "token new --project <name>" or "token hash"\n\n${USAGE}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help') {
    console.log(USAGE);
    return;
  }
  if (command === 'token') {
    await runToken(rest);
    return;
  }
  if (command === 'copy-debug-id') {
    const { values } = parseArgs({ args: rest, options: { from: { type: 'string' }, to: { type: 'string' } }, strict: true });
    if (!values.from || !values.to) fail('--from and --to are required');
    const id = await copyDebugId(values.from, values.to);
    if (!id) fail(`${values.from} has no debugId (is metro.config.js using withDebugIds?)`);
    console.log(`debug ID ${id} -> ${values.to}`);
    return;
  }
  if (command === 'inject') {
    const { values } = parseArgs({ args: rest, options: { dir: { type: 'string' } }, strict: true });
    if (!values.dir) fail('--dir is required');
    const count = await injectDebugIds(values.dir, { log: console.log });
    if (!count) console.log('no bundles to inject (already injected, or no .map next to a text bundle)');
    return;
  }
  if (command === 'react-native') {
    const { values } = parseArgs({
      args: rest,
      options: {
        platform: { type: 'string' },
        map: { type: 'string' },
        'packager-map': { type: 'string' },
        release: { type: 'string' },
      },
      strict: true,
    });
    if (values.platform !== 'android' && values.platform !== 'ios') fail('--platform must be android or ios');
    if (!values.map) fail('--map is required');
    const release = values.release ?? (values.platform === 'ios' ? iosRelease(process.env) : process.env.RELEASE);
    await uploadReactNativeMap({
      platform: values.platform,
      map: values.map,
      packagerMap: values['packager-map'],
      release,
    });
    return;
  }
  if (command !== 'upload') {
    fail(`unknown command "${command}"\n\n${USAGE}`);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      dir: { type: 'string' },
      platform: { type: 'string' },
      release: { type: 'string' },
      delete: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.dir) fail('--dir is required');
  if (!values.platform) fail('--platform is required');

  const upload = resolveUploadConfig(process.env);
  if (!upload.configured && !values['dry-run']) {
    fail(`missing ${upload.missing.join(', ')}`);
  }

  await uploadSourcemaps({
    dir: values.dir,
    platform: values.platform,
    release: values.release ?? process.env.RELEASE,
    url: upload.configured ? upload.url : undefined,
    token: upload.configured ? upload.token : undefined,
    deleteAfterUpload: values.delete,
    dryRun: values['dry-run'],
    log: console.log,
  });
}

main().catch((err) => fail(describeError(err)));
