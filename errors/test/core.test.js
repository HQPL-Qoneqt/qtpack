import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, getClient, reportRenderError, reactRootErrorHandlers } from '../src/core.js';
import { memoryStorage, stubFetch, tick } from './helpers.js';

const ENDPOINT = 'https://api.example.com/api/cx/errors';
let fetchStub;
afterEach(() => {
  fetchStub?.restore();
  delete globalThis.__telemetryDebugIds;
});

function client(adapters = {}) {
  return createClient({ platform: 'web', getLocation: () => '/feed?token=abc', getUserAgent: () => 'UA', ...adapters });
}

test('sends a report the server accepts: required fields, string fields, no query strings', async () => {
  fetchStub = stubFetch();
  const c = client();
  await c.init({ endpoint: ENDPOINT, projectName: 'my-app', release: 'my-app-1.0.0', environment: 'production' });
  const err = new TypeError('x is undefined');
  c.captureException(err, { status: 503, endpoint: '/api/feed?page=2' });
  await tick();

  assert.equal(fetchStub.calls.length, 1);
  const { url, init, body } = fetchStub.calls[0];
  assert.equal(url, ENDPOINT);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(body.platform, 'web');
  assert.equal(body.message, 'x is undefined');
  assert.equal(body.error_name, 'TypeError');
  assert.equal(body.project_name, 'my-app');
  assert.equal(body.release, 'my-app-1.0.0');
  assert.equal(body.level, 'error');
  assert.equal(body.is_fatal, false);
  assert.equal(body.status, '503');
  assert.equal(body.endpoint, '/api/feed');
  assert.equal(body.source, '/feed');
  assert.equal(body.session_seq, 1);
  assert.ok(body.session_id);
  assert.ok(body.stack.includes('x is undefined'));
  assert.match(body.fingerprint, /^TypeError@/);
});

test('apiBase keeps the proxy path the existing apps use', async () => {
  fetchStub = stubFetch();
  const c = client();
  await c.init({ apiBase: '/api/' });
  c.captureException('boom');
  await tick();
  assert.equal(fetchStub.calls[0].url, '/api/cx/errors');
  assert.equal(fetchStub.calls[0].body.message, 'boom');
  assert.equal(fetchStub.calls[0].body.fingerprint, 'Error:boom');
});

test('enabled: false and a missing endpoint send nothing and install nothing', async () => {
  fetchStub = stubFetch();
  let installs = 0;
  const off = client({ install: () => { installs++; } });
  await off.init({ endpoint: ENDPOINT, enabled: false });
  off.captureException(new Error('a'));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const noEndpoint = client({ install: () => { installs++; } });
    await noEndpoint.init({});
    noEndpoint.captureException(new Error('b'));
  } finally {
    console.warn = warn;
  }
  await tick();
  assert.equal(fetchStub.calls.length, 0);
  assert.equal(installs, 0);
});

test('fatal level sets is_fatal; extra overrides fields', async () => {
  fetchStub = stubFetch();
  const c = client();
  await c.init({ endpoint: ENDPOINT });
  c.captureException(new Error('dead'), { level: 'fatal', fingerprint: 'custom' });
  await tick();
  assert.equal(fetchStub.calls[0].body.is_fatal, true);
  assert.equal(fetchStub.calls[0].body.fingerprint, 'custom');
});

test('the same error more than 3 times a minute is dropped', async () => {
  fetchStub = stubFetch();
  const c = client();
  await c.init({ endpoint: ENDPOINT });
  for (let i = 0; i < 6; i++) c.captureException('same thing');
  await tick();
  assert.equal(fetchStub.calls.length, 3);
});

test('scrubs emails and tokens, then beforeSend can edit or drop', async () => {
  fetchStub = stubFetch();
  const c = client();
  await c.init({
    endpoint: ENDPOINT,
    beforeSend: (p) => (p.message.includes('drop') ? null : { ...p, environment: 'edited' }),
  });
  c.addBreadcrumb('auth', 'login a@b.com');
  c.captureException('failed for jane@example.com with Bearer abcdefghijklmnop');
  c.captureException('please drop me');
  await tick();
  assert.equal(fetchStub.calls.length, 1);
  const body = fetchStub.calls[0].body;
  assert.equal(body.message, 'failed for [email] with Bearer [token]');
  assert.equal(body.breadcrumbs[0].message, 'login [email]');
  assert.equal(body.environment, 'edited');
});

test('a throwing beforeSend drops the report', async () => {
  fetchStub = stubFetch();
  const c = client();
  await c.init({ endpoint: ENDPOINT, beforeSend: () => { throw new Error('bug'); } });
  c.captureException('x');
  await tick();
  assert.equal(fetchStub.calls.length, 0);
});

test('auth token and headers are sent', async () => {
  fetchStub = stubFetch();
  const c = client();
  await c.init({ endpoint: ENDPOINT, headers: { 'X-Ingest-Key': 'pk_1' }, getAuthToken: async () => 'tok' });
  c.captureException('x');
  await tick();
  assert.equal(fetchStub.calls[0].init.headers['X-Ingest-Key'], 'pk_1');
  assert.equal(fetchStub.calls[0].init.headers.Authorization, 'Bearer tok');
});

test('network failures and 5xx are queued and resent on retry; 4xx are not', async () => {
  let fail = true;
  fetchStub = stubFetch((url, init) => {
    const msg = JSON.parse(init.body).message;
    if (msg === 'bad request') return { status: 400 };
    if (fail) throw new TypeError('Failed to fetch');
    return { status: 202 };
  });
  let retry;
  const sendErrors = [];
  const c = client({ onRetry: (cb) => { retry = cb; } });
  await c.init({ endpoint: ENDPOINT, onSendError: (d) => sendErrors.push(d) });
  c.captureException('offline one');
  c.captureException('bad request');
  await tick();
  assert.equal(fetchStub.calls.length, 2);
  assert.equal(sendErrors.length, 2);

  fail = false;
  retry();
  await tick();
  await tick();
  const resent = fetchStub.calls.slice(2).map((c) => c.body.message);
  assert.deepEqual(resent, ['offline one']);
});

test('offline reports wait for flush()', async () => {
  fetchStub = stubFetch();
  let online = false;
  const c = client({ isOnline: () => online });
  await c.init({ endpoint: ENDPOINT });
  c.captureException('later');
  await tick();
  assert.equal(fetchStub.calls.length, 0);
  online = true;
  await c.flush();
  assert.equal(fetchStub.calls.length, 1);
});

test('trackFatal saves the report until it is sent, and init() resends a saved one', async () => {
  const storage = memoryStorage();
  fetchStub = stubFetch(() => { throw new TypeError('Network request failed'); });
  const crashed = client();
  await crashed.init({ endpoint: ENDPOINT, storage });
  await crashed.trackFatal(new Error('crash'));
  const saved = JSON.parse(storage.data._hqe_pending);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].payload.level, 'fatal');
  assert.equal(saved[0].payload.is_fatal, true);
  fetchStub.restore();

  // Next launch.
  fetchStub = stubFetch();
  const next = client();
  await next.init({ endpoint: ENDPOINT, storage });
  await tick();
  await tick();
  assert.equal(fetchStub.calls.length, 1);
  assert.equal(fetchStub.calls[0].body.message, 'crash');
  assert.deepEqual(JSON.parse(storage.data._hqe_pending), []);
});

test('trackFailedRequest: path only, one issue per route, dedupes, skips own endpoint and ignored URLs', async () => {
  fetchStub = stubFetch();
  const c = client();
  await c.init({ endpoint: ENDPOINT, ignoreRequests: ['/health', /analytics\.example/] });
  c.trackFailedRequest({ method: 'get', url: 'https://api.example.com/api/users/41?token=secret', status: 502 });
  c.trackFailedRequest({ method: 'GET', url: 'https://api.example.com/api/users/42', status: 502 });
  c.trackFailedRequest({ method: 'POST', url: '/api/posts', error: new TypeError('Failed to fetch') });
  c.trackFailedRequest({ url: ENDPOINT, status: 500 });
  c.trackFailedRequest({ url: 'https://api.example.com/health', status: 503 });
  c.trackFailedRequest({ url: 'https://analytics.example/x', status: 503 });
  await tick();

  assert.equal(fetchStub.calls.length, 2);
  const [http, network] = fetchStub.calls.map((c) => c.body);
  assert.equal(http.message, 'HTTP 502: GET /api/users/41');
  assert.equal(http.endpoint, '/api/users/41');
  assert.equal(http.fingerprint, 'HttpError:GET /api/users/:id 502');
  assert.equal(http.status, '502');
  assert.equal(http.level, 'error');
  assert.ok(!JSON.stringify(http).includes('secret'));
  assert.equal(network.error_type, 'NetworkError');
  assert.equal(network.error_code, 'TypeError');
  assert.equal(network.fingerprint, 'NetworkError:POST /api/posts network');

  // The failed request is a breadcrumb on the next report.
  c.captureException('later');
  await tick();
  const crumbs = fetchStub.calls.at(-1).body.breadcrumbs.map((b) => b.message);
  assert.ok(crumbs.includes('GET /api/users/41 failed'));
});

test('setUser accepts numeric IDs only', async () => {
  fetchStub = stubFetch();
  const c = client();
  await c.init({ endpoint: ENDPOINT });
  c.setUser('21277');
  c.captureException('a');
  const warn = console.warn;
  console.warn = () => {};
  c.setUser('user_abc');
  console.warn = warn;
  c.captureException('b');
  await tick();
  assert.equal(fetchStub.calls[0].body.user_id, 21277);
  assert.equal(fetchStub.calls[1].body.user_id, 0);
});

test('debug IDs of the bundles in the stack are sent', async () => {
  fetchStub = stubFetch();
  globalThis.__telemetryDebugIds = {
    'Error\n    at https://x.example/assets/index-abc.js:1:10': 'id-index',
    'Error\n    at https://x.example/assets/vendor-def.js:1:10': 'id-vendor',
  };
  const c = client();
  await c.init({ endpoint: ENDPOINT });
  const err = new Error('boom');
  err.stack = 'Error: boom\n    at f (https://x.example/assets/index-abc.js?v=1:3:7)\n    at g (https://x.example/assets/other.js:1:1)';
  c.captureException(err);
  await tick();
  assert.deepEqual(fetchStub.calls[0].body.debug_ids, { 'index-abc.js': 'id-index' });
});

test('long fields are truncated so a report stays small', async () => {
  fetchStub = stubFetch();
  const c = client();
  await c.init({ endpoint: ENDPOINT });
  const err = new Error('m'.repeat(5000));
  err.stack = 's'.repeat(50000);
  c.captureException(err);
  await tick();
  const body = fetchStub.calls[0].body;
  assert.ok(body.message.length < 2100);
  assert.ok(body.stack.length < 16100);
});

test('render errors report once per Error through the registered client', async () => {
  fetchStub = stubFetch();
  const c = client();
  assert.equal(getClient(), c);
  await c.init({ endpoint: ENDPOINT });
  const err = new Error('render');
  reactRootErrorHandlers.onCaughtError(err, { componentStack: '\n    in Feed\n' });
  reportRenderError(err, {});
  await tick();
  assert.equal(fetchStub.calls.length, 1);
  assert.equal(fetchStub.calls[0].body.component_stack, 'in Feed');
  assert.equal(fetchStub.calls[0].body.error_type, 'RenderError');
});
