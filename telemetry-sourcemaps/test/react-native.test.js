import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iosRelease, uploadReactNativeMap } from '../src/react-native.js';

const COMPOSE = fileURLToPath(new URL('../bin/compose-source-maps.cjs', import.meta.url));

const ID = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b';
const ENV = { SOURCEMAP_UPLOAD_URL: 'https://telemetry.example.com', SOURCEMAP_UPLOAD_TOKEN: 'tok_123' };
const map = (extra = {}) => JSON.stringify({ version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA', ...extra });

async function build({ packagerId = ID } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rn-test-'));
  const paths = { dir, map: join(dir, 'index.android.bundle.map'), packagerMap: join(dir, 'index.android.bundle.packager.map') };
  await writeFile(paths.map, map());
  await writeFile(paths.packagerMap, map(packagerId ? { debugId: packagerId } : {}));
  return paths;
}

function fakeFetch(status = 201) {
  const uploads = [];
  const fetchImpl = async (url, init) => {
    if (init?.body) uploads.push({ url, release: init.body.get('release'), files: init.body.getAll('file').map((f) => f.name) });
    return { ok: status < 300, status, json: async () => ({}) };
  };
  return { uploads, fetchImpl };
}

const quiet = { log: () => {}, warn: () => {} };

test('copies the debug ID Hermes dropped, then uploads only the final map', async () => {
  const p = await build();
  const { uploads, fetchImpl } = fakeFetch();
  const ok = await uploadReactNativeMap({ platform: 'android', map: p.map, packagerMap: p.packagerMap, release: 'hqpl-3.1.87+178', env: ENV, fetchImpl, ...quiet });
  assert.equal(ok, true);
  assert.equal(JSON.parse(await readFile(p.map, 'utf8')).debugId, ID);
  assert.deepEqual(uploads, [{ url: 'https://telemetry.example.com/analytics/sourcemaps', release: 'hqpl-3.1.87+178', files: ['index.android.bundle.map'] }]);
  await rm(p.dir, { recursive: true });
});

test('without upload config the build continues, and the ID is still copied', async () => {
  const p = await build();
  const warnings = [];
  const ok = await uploadReactNativeMap({ platform: 'android', map: p.map, packagerMap: p.packagerMap, release: 'r-1+1', env: {}, log: () => {}, warn: (m) => warnings.push(m) });
  assert.equal(ok, false);
  assert.match(warnings.join('\n'), /missing SOURCEMAP_UPLOAD_TOKEN, SOURCEMAP_UPLOAD_URL/);
  assert.equal(JSON.parse(await readFile(p.map, 'utf8')).debugId, ID);
  await rm(p.dir, { recursive: true });
});

test('a failed upload only warns, unless SOURCEMAP_FAIL_ON_ERROR is set', async () => {
  const p = await build();
  const args = { platform: 'android', map: p.map, packagerMap: p.packagerMap, release: 'r-1+1', fetchImpl: fakeFetch(500).fetchImpl, ...quiet };
  assert.equal(await uploadReactNativeMap({ ...args, env: ENV }), false);
  await assert.rejects(uploadReactNativeMap({ ...args, env: { ...ENV, SOURCEMAP_FAIL_ON_ERROR: '1' } }), /HTTP 500/);
  await rm(p.dir, { recursive: true });
});

test('a missing map is reported, not thrown', async () => {
  const warnings = [];
  const ok = await uploadReactNativeMap({ platform: 'ios', map: '/nope/main.jsbundle.map', release: 'r-1+1', env: ENV, log: () => {}, warn: (m) => warnings.push(m) });
  assert.equal(ok, false);
  assert.match(warnings.join('\n'), /not uploaded/);
});

test('iosRelease reads Info.plist and expands build settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rn-ios-'));
  await writeFile(join(dir, 'Info.plist'), `<dict>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>42</string>
</dict>`);
  const env = { PROJECT_DIR: dir, INFOPLIST_FILE: 'Info.plist', PRODUCT_NAME: 'Hqpl', MARKETING_VERSION: '3.1.87', CURRENT_PROJECT_VERSION: '1' };
  assert.equal(iosRelease(env), 'hqpl-3.1.87+42');
  assert.equal(iosRelease({ ...env, TELEMETRY_SOURCEMAPS_PROJECT: 'hqpl-mobile' }), 'hqpl-mobile-3.1.87+42');
  assert.equal(iosRelease({ PRODUCT_NAME: 'My App', MARKETING_VERSION: '1.0', CURRENT_PROJECT_VERSION: '7' }), 'my-app-1.0+7');
  await rm(dir, { recursive: true });
});

// The iOS hook, run the way react-native-xcode.sh runs it, with a stand-in for
// React Native's compose script (which drops "debugId", like the real one).
async function runCompose(env) {
  const dir = await mkdtemp(join(tmpdir(), 'rn-compose-'));
  await mkdir(join(dir, 'node_modules/react-native/scripts'), { recursive: true });
  await writeFile(
    join(dir, 'node_modules/react-native/scripts/compose-source-maps.js'),
    `const fs=require('fs');const a=process.argv.slice(2);const m=JSON.parse(fs.readFileSync(a[0]));delete m.debugId;fs.writeFileSync(a[a.indexOf('-o')+1],JSON.stringify(m));`,
  );
  await writeFile(join(dir, 'packager.map'), map({ debugId: ID }));
  await writeFile(join(dir, 'hbc.map'), '{}');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SOURCEMAP_')));
  const result = spawnSync(process.execPath, [COMPOSE, 'packager.map', 'hbc.map', '-o', 'main.jsbundle.map'], {
    cwd: dir,
    env: { ...clean, PRODUCT_NAME: 'Hqpl', MARKETING_VERSION: '1.0', CURRENT_PROJECT_VERSION: '1', ...env },
    encoding: 'utf8',
  });
  const out = JSON.parse(await readFile(join(dir, 'main.jsbundle.map'), 'utf8'));
  await rm(dir, { recursive: true });
  return { status: result.status, out, stderr: result.stderr };
}

test('iOS hook: composes, restores the debug ID, and never fails the build by default', async () => {
  const { status, out, stderr } = await runCompose({});
  assert.equal(status, 0);
  assert.equal(out.debugId, ID);
  assert.match(stderr, /not uploaded, build continues/);
});

test('iOS hook: fails the build when SOURCEMAP_FAIL_ON_ERROR is set', async () => {
  const { status, out } = await runCompose({ SOURCEMAP_FAIL_ON_ERROR: '1' });
  assert.notEqual(status, 0);
  assert.equal(out.debugId, ID);
});
