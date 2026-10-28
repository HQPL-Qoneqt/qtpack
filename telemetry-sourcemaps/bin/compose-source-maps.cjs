#!/usr/bin/env node
// Stand-in for React Native's scripts/compose-source-maps.js in the iOS release
// build (Xcode Release / Archive, so every IPA). It runs the original, then
// `qtpack react-native`, which copies "debugId" from Metro's map into the result
// and uploads it. This is the only point where that works: the original drops the
// ID, and react-native-xcode.sh deletes Metro's map right after.
//
// Enabled by the block in ios/.xcode.env shown in the README.
//
// Called as: <metro map> <hermes map> -o <output map>

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
const original = require.resolve('react-native/scripts/compose-source-maps.js', {
  paths: [process.cwd(), __dirname],
});
const composed = spawnSync(process.execPath, [original, ...args], { stdio: 'inherit' });
if (composed.status !== 0) process.exit(composed.status ?? 1);

const outFlag = args.findIndex((a) => a === '-o' || a === '--output');
const output = outFlag >= 0 ? args[outFlag + 1] : null;
if (!output) process.exit(0);

// qtpack exits 0 after a warning. Anything else (SOURCEMAP_FAIL_ON_ERROR, or a
// crash in qtpack) fails the archive only when SOURCEMAP_FAIL_ON_ERROR is set.
const uploaded = spawnSync(
  process.execPath,
  [path.join(__dirname, 'qtpack.js'), 'react-native', '--platform', 'ios', '--map', output, '--packager-map', args[0]],
  { stdio: 'inherit' },
);
if (uploaded.status === 0) process.exit(0);
if (['1', 'true'].includes(process.env.SOURCEMAP_FAIL_ON_ERROR)) process.exit(uploaded.status ?? 1);
console.warn('[qtpack] sourcemap step failed, build continues');
