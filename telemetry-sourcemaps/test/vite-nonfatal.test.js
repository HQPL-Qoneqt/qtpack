import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sourcemapUploadPlugin from '../src/vite.js';

async function run(options) {
  const dir = await mkdtemp(join(tmpdir(), 'smcli-'));
  await writeFile(join(dir, 'a.js'), 'console.log(1)');
  await writeFile(join(dir, 'a.js.map'), '{"version":3,"sources":[],"mappings":""}');
  const plugin = sourcemapUploadPlugin(options);
  plugin.configResolved({ root: dir, build: { outDir: '.' } });
  const warn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(m);
  try {
    await plugin.closeBundle();
    return { dir, warnings, error: null };
  } catch (error) {
    return { dir, warnings, error };
  } finally {
    console.warn = warn;
  }
}

test('missing config does not fail the build, even in CI', async () => {
  process.env.CI = '1';
  const r = await run({ release: 'x-1.0.0' });
  delete process.env.CI;
  assert.equal(r.error, null);
  assert.match(r.warnings[0], /build continues/);
  await rm(r.dir, { recursive: true });
});

test('failed upload warns, continues, and removes the maps from the output', async () => {
  const r = await run({ release: 'x-1.0.0', url: 'http://127.0.0.1:1', token: 't' });
  assert.equal(r.error, null);
  assert.ok(!(await readdir(r.dir)).some((f) => f.endsWith('.map')));
  await rm(r.dir, { recursive: true });
});

test('failOnError makes the build fail', async () => {
  const r = await run({ release: 'x-1.0.0', url: 'http://127.0.0.1:1', token: 't', failOnError: true });
  assert.ok(r.error);
  await rm(r.dir, { recursive: true });
});

test('does nothing after a failed build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smcli-'));
  const plugin = sourcemapUploadPlugin({ release: 'x-1.0.0' });
  plugin.configResolved({ root: dir, build: { outDir: 'dist' } });
  plugin.buildEnd(new Error('Transform failed'));
  const warn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(m);
  try {
    await plugin.closeBundle();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, []);
  await rm(dir, { recursive: true });
});
