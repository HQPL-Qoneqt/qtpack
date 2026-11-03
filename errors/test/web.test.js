// The web entry, against a stand-in window. Set up before the module is imported,
// because index.js reads `typeof window` at load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch, tick } from './helpers.js';

const win = new EventTarget();
win.location = { pathname: '/feed', href: 'https://app.example/feed' };
globalThis.window = win;

const ENDPOINT = 'https://api.example.com/api/cx/errors';
const fetchStub = stubFetch((url) => ({ status: url.includes('/broken') ? 503 : 202 }));
const errors = (await import('../src/index.js')).default;
await errors.init({ endpoint: ENDPOINT, projectName: 'web-app', release: 'web-app-1.0.0' });

const reports = () => fetchStub.calls.filter((c) => c.url === ENDPOINT).map((c) => c.body);

test('uncaught errors are reported as fatal, once', async () => {
  const error = new RangeError('bad index');
  for (let i = 0; i < 2; i++) {
    const event = new Event('error');
    Object.assign(event, { error, message: error.message, filename: 'https://app.example/assets/index.js', lineno: 3, colno: 9 });
    win.dispatchEvent(event);
  }
  await tick();
  const sent = reports().filter((r) => r.message === 'bad index');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].level, 'fatal');
  assert.equal(sent[0].error_type, 'UncaughtError');
  assert.equal(sent[0].source, '/feed');
  assert.equal(sent[0].endpoint, 'https://app.example/assets/index.js:3:9');
});

test('unhandled rejections with a non-Error reason are reported', async () => {
  const event = new Event('unhandledrejection');
  event.reason = { code: 42 };
  win.dispatchEvent(event);
  await tick();
  const sent = reports().find((r) => r.error_type === 'UnhandledRejection');
  assert.equal(sent.message, '{"code":42}');
});

test('failed fetch calls are reported; the SDK\'s own sends are not', async () => {
  const res = await globalThis.fetch('https://api.example.com/api/broken?id=1', { method: 'post' });
  assert.equal(res.status, 503);
  await globalThis.fetch('https://api.example.com/api/ok');
  await tick();
  const sent = reports().filter((r) => r.error_type === 'HttpError');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message, 'HTTP 503: POST /api/broken');
  // The report itself went through the wrapped fetch without reporting itself.
  assert.ok(reports().every((r) => r.endpoint !== '/api/cx/errors'));
});

test('reports use keepalive so they survive page unload', () => {
  const call = fetchStub.calls.find((c) => c.url === ENDPOINT);
  assert.equal(call.init.keepalive, true);
});
