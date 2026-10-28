import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveUploadConfig } from './config.js';
import { copyDebugId } from './debug-id.js';
import { describeError, uploadSourcemaps } from './upload.js';

// Uploads the final map of a React Native release build, from inside that build:
// gradle/qtpack.gradle runs it for Android (APK and AAB), bin/compose-source-maps.cjs
// for iOS (IPA). Like the Vite plugin it never fails the build unless
// SOURCEMAP_FAIL_ON_ERROR is set: a missing token or an unreachable backend logs a
// warning and the app still builds. Returns true when the map was uploaded.
export async function uploadReactNativeMap({
  platform,
  map,
  packagerMap,
  release,
  env = process.env,
  fetchImpl,
  log = console.log,
  warn = console.warn,
}) {
  const failOnError = ['1', 'true'].includes(env.SOURCEMAP_FAIL_ON_ERROR);
  try {
    // React Native's Hermes compose step drops "debugId"; Metro's map still has it.
    // Copied even when the upload is skipped, so a later manual upload has it too.
    // Without Hermes there is no compose step and no packager map.
    if (packagerMap && existsSync(packagerMap)) await copyDebugId(packagerMap, map);
    const { debugId } = JSON.parse(readFileSync(map, 'utf8'));
    if (debugId) log(`[qtpack] debug ID ${debugId}`);
    else warn('[qtpack] map has no debug ID (is metro.config.js using withDebugIds?); it will only resolve by release');
    const upload = resolveUploadConfig(env);
    if (!upload.configured) throw new Error(`missing ${upload.missing.join(', ')}`);
    await uploadSourcemaps({ files: [map], platform, release, url: upload.url, token: upload.token, fetchImpl, log });
    return true;
  } catch (err) {
    if (failOnError) throw err;
    warn(`[qtpack] sourcemap not uploaded, build continues: ${describeError(err)}`);
    return false;
  }
}

// <project>-<version>+<build> from the Xcode build environment, the same values
// DeviceInfo.getVersion() and getBuildNumber() return in the app. Info.plist is
// read because CFBundleVersion is often hard-coded there instead of coming from
// CURRENT_PROJECT_VERSION. The project defaults to the product name, lowercased.
export function iosRelease(env = process.env) {
  let plist = '';
  try {
    if (env.PROJECT_DIR && env.INFOPLIST_FILE) plist = readFileSync(resolve(env.PROJECT_DIR, env.INFOPLIST_FILE), 'utf8');
  } catch {}
  const value = (key, fallback) => {
    const raw = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? fallback ?? '';
    return raw.replace(/\$[({](\w+)[)}]/g, (_, name) => env[name] ?? '');
  };
  return releaseName(
    env.TELEMETRY_SOURCEMAPS_PROJECT || env.PRODUCT_NAME,
    value('CFBundleShortVersionString', env.MARKETING_VERSION),
    value('CFBundleVersion', env.CURRENT_PROJECT_VERSION),
  );
}

export function releaseName(project, version, build) {
  const slug = String(project || 'app').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return `${slug}-${version}+${build}`;
}
