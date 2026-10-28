import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveUploadConfig } from '../src/config.js';
import { findMapFiles, uploadSourcemaps } from '../src/upload.js';

const URL_BASE = 'https://telemetry.example.com';
const TOKEN = 'tok_123';

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'sm-test-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  return dir;
}

// Fake fetch that records each request and answers with status (default 201).
function fakeFetch({ status = 201, message = '' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, files: init.body.getAll('file').map((f) => f.name) });
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      json: async () => ({ success: ok, message }),
    };
  };
  return { calls, fetchImpl };
}

test('resolveUploadConfig reports missing vars and strips trailing slashes', () => {
  assert.deepEqual(resolveUploadConfig({}).missing, ['SOURCEMAP_UPLOAD_TOKEN', 'SOURCEMAP_UPLOAD_URL']);
  const cfg = resolveUploadConfig({ SOURCEMAP_UPLOAD_TOKEN: 't', SOURCEMAP_UPLOAD_URL: 'https://x.test//' });
  assert.equal(cfg.url, 'https://x.test');
  assert.equal(cfg.token, 't');
});

test('findMapFiles walks recursively and ignores non-map files', async () => {
  const dir = await fixture({ 'a.js.map': '{}', 'nested/b.js.map': '{}', 'a.js': 'x' });
  const files = await findMapFiles(dir);
  assert.deepEqual(files.map((f) => f.replace(dir + '/', '')), ['a.js.map', 'nested/b.js.map']);
  await rm(dir, { recursive: true });
});

test('posts platform, release and files to the backend with a bearer token', async () => {
  const dir = await fixture({ 'assets/index.js.map': '{}', 'assets/vendor.js.map': '{}' });
  const { calls, fetchImpl } = fakeFetch();
  const { uploaded } = await uploadSourcemaps({
    dir, platform: 'web', release: '1.2.3', url: URL_BASE, token: TOKEN, fetchImpl,
  });

  assert.equal(uploaded, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${URL_BASE}/analytics/sourcemaps`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.body.get('platform'), 'web');
  assert.equal(calls[0].init.body.get('release'), '1.2.3');
  assert.deepEqual(calls[0].files.sort(), ['index.js.map', 'vendor.js.map']);
  assert.ok(existsSync(join(dir, 'assets/index.js.map')), 'maps stay by default');
  await rm(dir, { recursive: true });
});

test('splits large builds into batches of 20 files', async () => {
  const files = {};
  for (let i = 0; i < 45; i++) files[`chunk-${i}.js.map`] = '{}';
  const dir = await fixture(files);
  const { calls, fetchImpl } = fakeFetch();
  await uploadSourcemaps({ dir, platform: 'android', release: '9', url: URL_BASE, token: TOKEN, fetchImpl });
  // Batches upload in parallel, so arrival order is not fixed.
  assert.deepEqual(calls.map((c) => c.files.length).sort((a, b) => b - a), [20, 20, 5]);
  await rm(dir, { recursive: true });
});

test('a server rejection surfaces its message and deletes nothing', async () => {
  const dir = await fixture({ 'a.js.map': '{}', 'b.js.map': '{}' });
  const { fetchImpl } = fakeFetch({ status: 401, message: 'invalid token' });
  await assert.rejects(
    uploadSourcemaps({ dir, platform: 'web', release: '1', url: URL_BASE, token: 'bad', fetchImpl, deleteAfterUpload: true }),
    /HTTP 401 — invalid token/,
  );
  assert.deepEqual((await readdir(dir)).sort(), ['a.js.map', 'b.js.map']);
  await rm(dir, { recursive: true });
});

test('deleteAfterUpload removes local maps only after success', async () => {
  const dir = await fixture({ 'a.js.map': '{}' });
  const { fetchImpl } = fakeFetch();
  await uploadSourcemaps({ dir, platform: 'web', release: '1', url: URL_BASE, token: TOKEN, fetchImpl, deleteAfterUpload: true });
  assert.deepEqual(await readdir(dir), []);
  await rm(dir, { recursive: true });
});

test('rejects bad platform, bad release, empty dirs and duplicate basenames before any request', async () => {
  const dir = await fixture({ 'a.js.map': '{}', 'x/a.js.map': '{}' });
  const { calls, fetchImpl } = fakeFetch();
  const base = { url: URL_BASE, token: TOKEN, fetchImpl };

  await assert.rejects(uploadSourcemaps({ ...base, dir, platform: 'server', release: '1' }), /invalid platform/);
  await assert.rejects(uploadSourcemaps({ ...base, dir, platform: 'web', release: 'a/b' }), /must be 1-128/);
  await assert.rejects(uploadSourcemaps({ ...base, dir, platform: 'web', release: '' }), /must be 1-128/);
  await assert.rejects(uploadSourcemaps({ ...base, dir, platform: 'web', release: '1' }), /duplicate map name/);

  const empty = await fixture({ 'readme.txt': 'hi' });
  await assert.rejects(uploadSourcemaps({ ...base, dir: empty, platform: 'web', release: '1' }), /no .map files/);
  assert.equal(calls.length, 0);
  await rm(dir, { recursive: true });
  await rm(empty, { recursive: true });
});

test('dry run lists files without any request or delete', async () => {
  const dir = await fixture({ 'a.js.map': '{}' });
  const logs = [];
  const { calls, fetchImpl } = fakeFetch();
  const { uploaded } = await uploadSourcemaps({
    dir, platform: 'android', release: '9', fetchImpl, deleteAfterUpload: true, dryRun: true, log: (l) => logs.push(l),
  });
  assert.equal(uploaded, 0);
  assert.equal(calls.length, 0);
  assert.ok(existsSync(join(dir, 'a.js.map')));
  assert.match(logs[0], /would upload android\/9\/a.js.map/);
  await rm(dir, { recursive: true });
});
