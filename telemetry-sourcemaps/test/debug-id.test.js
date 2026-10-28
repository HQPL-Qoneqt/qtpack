import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  PLACEHOLDER,
  REGISTRY,
  copyDebugId,
  debugIdFromContent,
  finalizeMetroBundle,
  injectDebugIds,
  injectIntoCode,
  registrationSnippet,
} from '../src/debug-id.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Runs code the way a browser would load it from url and returns the registry it built.
function runAt(code, url) {
  const ctx = vm.createContext({});
  ctx.globalThis = ctx;
  vm.runInContext(code, ctx, { filename: url });
  return ctx[REGISTRY];
}

const sampleMap = () => ({ version: 3, sources: ['a.ts'], sourcesContent: ['x'], names: [], mappings: 'AAAA;AACA' });

test('debug IDs are deterministic UUIDs that change with content', () => {
  assert.match(debugIdFromContent('a'), UUID);
  assert.equal(debugIdFromContent('a', 'b'), debugIdFromContent('a', 'b'));
  assert.notEqual(debugIdFromContent('a', 'b'), debugIdFromContent('a', 'c'));
});

test('injectIntoCode registers the bundle under its own file and shifts the map one line', () => {
  const map = sampleMap();
  const { id, code } = injectIntoCode('var a=1;\nvar b=2;\n', map);
  assert.match(id, UUID);
  assert.equal(map.debugId, id);
  assert.equal(map.mappings, ';AAAA;AACA');
  // Original first line is now line 2, so the extra ";" keeps it mapped.
  assert.equal(code.split('\n')[1], 'var a=1;');
  assert.ok(code.trimEnd().endsWith(`//# debugId=${id}`));

  const registry = runAt(code, 'https://example.com/assets/index-abc.js');
  const [stack] = Object.keys(registry);
  assert.equal(registry[stack], id);
  assert.match(stack, /index-abc\.js:1:\d+/);
});

test('injectIntoCode leaves already-injected bundles alone', () => {
  const map = sampleMap();
  const first = injectIntoCode('var a=1;', map);
  assert.equal(injectIntoCode(first.code, map), null);
});

test('injectIntoCode stamps a bundle that only reads the registry (e.g. one bundling the SDK)', () => {
  const code = `var ids=globalThis.${REGISTRY};if(ids){console.log(Object.keys(ids))}`;
  const result = injectIntoCode(code, sampleMap());
  assert.ok(result, 'bundle that merely mentions the registry must still get a debug ID');
  assert.match(result.code, /^;!function\(\)\{try\{/);
});

test('injectIntoCode skips code that already has the snippet even when the map has no debugId', () => {
  const first = injectIntoCode('var a=1;', sampleMap());
  assert.equal(injectIntoCode(first.code, sampleMap()), null);
});

test('injectDebugIds rewrites bundle and map on disk, skipping maps without a text bundle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'debug-id-'));
  await writeFile(join(dir, 'index-abc.js'), 'console.log(1);\n');
  await writeFile(join(dir, 'index-abc.js.map'), JSON.stringify(sampleMap()));
  await writeFile(join(dir, 'orphan.js.map'), JSON.stringify(sampleMap()));
  await writeFile(join(dir, 'app.hbc'), 'HBC\0bytecode');
  await writeFile(join(dir, 'app.hbc.map'), JSON.stringify(sampleMap()));

  assert.equal(await injectDebugIds(dir), 1);
  const map = JSON.parse(await readFile(join(dir, 'index-abc.js.map'), 'utf8'));
  const code = await readFile(join(dir, 'index-abc.js'), 'utf8');
  assert.match(map.debugId, UUID);
  assert.ok(code.includes(map.debugId));
  assert.equal(JSON.parse(await readFile(join(dir, 'orphan.js.map'), 'utf8')).debugId, undefined);
  assert.equal(await injectDebugIds(dir), 0, 'second run is a no-op');
});

test('copyDebugId restores the ID the Hermes compose step drops', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copy-id-'));
  const packager = join(dir, 'index.android.bundle.packager.map');
  const composed = join(dir, 'index.android.bundle.map');
  const id = debugIdFromContent('bundle');
  await writeFile(packager, JSON.stringify({ ...sampleMap(), debugId: id }));
  await writeFile(composed, JSON.stringify({ ...sampleMap(), x_hermes_function_offsets: {} }));

  assert.equal(await copyDebugId(packager, composed), id);
  const out = JSON.parse(await readFile(composed, 'utf8'));
  assert.equal(out.debugId, id);
  assert.deepEqual(out.x_hermes_function_offsets, {}, 'other fields are kept');

  await writeFile(packager, JSON.stringify(sampleMap()));
  assert.equal(await copyDebugId(packager, composed), null, 'no ID to copy');
});

test('finalizeMetroBundle swaps the placeholder without moving anything', () => {
  const bundle = `var __BUNDLE_START_TIME__=0;\n;!function(){var x="${PLACEHOLDER}"}();\n__r(0);\n//# sourceMappingURL=x.map\n//# debugId=00000000-0000-0000-0000-000000000000\n`;
  const { code, map, id } = finalizeMetroBundle(bundle, JSON.stringify(sampleMap()));
  assert.match(id, UUID);
  assert.equal(id.length, PLACEHOLDER.length);
  assert.ok(!code.includes(PLACEHOLDER));
  // Every line before the trailing comments keeps its length, so no mapping shifts.
  const lines = (s) => s.split('\n').slice(0, 3).map((l) => l.length);
  assert.deepEqual(lines(code), lines(bundle));
  assert.equal(JSON.parse(map).debugId, id);
  assert.equal(code.match(/\/\/# debugId=/g).length, 1, 'Expo\'s own debugId comment is replaced');
  assert.ok(code.includes(`//# debugId=${id}`));
});

test('finalizeMetroBundle uses the ID Sentry stamped, so both tools match one bundle', () => {
  const sentryId = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b';
  const bundle = `;!function(){var x="${PLACEHOLDER}"}();\n_sentryDebugIds[s]="${sentryId}";\n__r(0);\n//# debugId=${sentryId}\n//# sourceMappingURL=x.map\n`;
  const map = JSON.stringify({ ...sampleMap(), debugId: sentryId, debug_id: sentryId });
  const out = finalizeMetroBundle(bundle, map);
  assert.equal(out.id, sentryId);
  assert.ok(out.code.includes(`var x="${sentryId}"`));
  assert.equal(out.code.match(/\/\/# debugId=/g).length, 1);
  assert.equal(JSON.parse(out.map).debugId, sentryId);
  assert.equal(JSON.parse(out.map).debug_id, sentryId);
});

test('finalizeMetroBundle finds an existing ID in the map when the bundle has no comment', () => {
  const expoId = '5f0c2a1e-8d3b-4c7a-9e21-3b6f4d8a2c10';
  const bundle = `;!function(){var x="${PLACEHOLDER}"}();\n__r(0);\n`;
  const out = finalizeMetroBundle(bundle, JSON.stringify({ ...sampleMap(), debugId: expoId }));
  assert.equal(out.id, expoId);
  assert.ok(out.code.includes(`//# debugId=${expoId}`));
});

test('finalizeMetroBundle finds the ID in Sentry\'s runtime snippet', () => {
  const sentryId = '5f0c2a1e-8d3b-4c7a-9e21-3b6f4d8a2c10';
  const bundle = `_sentryDebugIdIdentifier="sentry-dbid-${sentryId}";\n;!function(){var x="${PLACEHOLDER}"}();\n__r(0);\n`;
  const out = finalizeMetroBundle(bundle, JSON.stringify(sampleMap()));
  assert.equal(out.id, sentryId);
  assert.equal(JSON.parse(out.map).debugId, sentryId);
});

test('finalizeMetroBundle makes its own ID when no other tool stamped one (Sentry removed)', () => {
  const bundle = `;!function(){var x="${PLACEHOLDER}"}();\n__r(0);\n`;
  const out = finalizeMetroBundle(bundle, JSON.stringify(sampleMap()));
  assert.equal(out.id, debugIdFromContent(bundle));
  assert.equal(JSON.parse(out.map).debugId, out.id);
  assert.equal('debug_id' in JSON.parse(out.map), false);
});

test('copyDebugId sets both ID fields, so no tool reads a stale one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copy-id-'));
  const id = debugIdFromContent('bundle');
  await writeFile(join(dir, 'packager.map'), JSON.stringify({ ...sampleMap(), debugId: id }));
  await writeFile(join(dir, 'final.map'), JSON.stringify({ ...sampleMap(), debug_id: '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b' }));
  assert.equal(await copyDebugId(join(dir, 'packager.map'), join(dir, 'final.map')), id);
  const finalMap = JSON.parse(await readFile(join(dir, 'final.map'), 'utf8'));
  assert.equal(finalMap.debugId, id);
  assert.equal(finalMap.debug_id, id);
});

test('finalizeMetroBundle ignores bundles without the polyfill', () => {
  const out = finalizeMetroBundle('__r(0);', '{}');
  assert.equal(out.id, null);
  assert.equal(out.code, '__r(0);');
});

test('withDebugIds adds the polyfill and finalizes serializer output', async () => {
  const require = createRequire(import.meta.url);
  const { withDebugIds } = require('../src/metro.cjs');
  const config = withDebugIds({
    serializer: {
      getPolyfills: () => ['existing.js'],
      customSerializer: async () => ({ code: `x="${PLACEHOLDER}";`, map: '{"version":3,"mappings":""}' }),
    },
  });
  const polyfills = config.serializer.getPolyfills({ platform: 'android' });
  assert.equal(polyfills[0], 'existing.js');
  assert.equal(await readFile(polyfills[1], 'utf8'), `${registrationSnippet(PLACEHOLDER)}\n`);

  const out = await config.serializer.customSerializer();
  assert.ok(!out.code.includes(PLACEHOLDER));
  assert.match(JSON.parse(out.map).debugId, UUID);
});

test('withDebugIds passes `expo export` asset arrays through untouched', async () => {
  const require = createRequire(import.meta.url);
  const { withDebugIds } = require('../src/metro.cjs');
  const assets = [{ filename: 'a.js', source: 'x' }];
  const config = withDebugIds({ serializer: { customSerializer: async () => assets } });
  assert.equal(await config.serializer.customSerializer(), assets);
});
