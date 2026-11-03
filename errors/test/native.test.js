// React Native hooks, with stand-ins for ErrorUtils and Hermes (index.native.js
// itself imports 'react-native', which can't load in Node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/core.js';
import { installNativeHandlers } from '../src/native-handlers.js';
import { memoryStorage, stubFetch, tick } from './helpers.js';

const ENDPOINT = 'https://api.example.com/api/cx/errors';

function fakeErrorUtils() {
  const previousCalls = [];
  let handler = (error, isFatal) => previousCalls.push({ error, isFatal });
  return {
    previousCalls,
    getGlobalHandler: () => handler,
    setGlobalHandler: (h) => { handler = h; },
    raise: (error, isFatal) => handler(error, isFatal),
  };
}

function fakeHermes() {
  const h = { tracker: null, hasPromise: () => true };
  h.enablePromiseRejectionTracker = (opts) => { h.tracker = opts; };
  return h;
}

async function setup({ isDev = false, respond, storage = memoryStorage() } = {}) {
  const fetchStub = stubFetch(respond);
  const ErrorUtils = fakeErrorUtils();
  const hermes = fakeHermes();
  const client = createClient({
    platform: 'android',
    install: (config, api) => installNativeHandlers(api, config, { ErrorUtils, hermes, isDev }),
  });
  await client.init({ endpoint: ENDPOINT, storage, trackFailedRequests: false });
  return { client, fetchStub, ErrorUtils, hermes, storage };
}

test('a non-fatal uncaught error is reported and still reaches the previous handler', async () => {
  const { fetchStub, ErrorUtils } = await setup();
  const err = new Error('soft');
  ErrorUtils.raise(err, false);
  await tick();
  assert.equal(fetchStub.calls[0].body.platform, 'android');
  assert.equal(fetchStub.calls[0].body.level, 'error');
  assert.equal(fetchStub.calls[0].body.error_type, 'UncaughtError');
  assert.equal(ErrorUtils.previousCalls[0].error, err);
  fetchStub.restore();
});

test('a fatal crash is reported before the app is allowed to close', async () => {
  const { fetchStub, ErrorUtils, storage } = await setup();
  ErrorUtils.raise(new Error('hard'), true);
  // Not closed yet: the report is still being saved and sent.
  assert.equal(ErrorUtils.previousCalls.length, 0);
  await tick();
  await tick();
  assert.equal(ErrorUtils.previousCalls.length, 1);
  const body = fetchStub.calls[0].body;
  assert.equal(body.level, 'fatal');
  assert.equal(body.is_fatal, true);
  assert.equal(body.error_type, 'FatalError');
  assert.deepEqual(JSON.parse(storage.data._hqe_pending), []);
  fetchStub.restore();
});

test('if the crash report cannot be sent it stays saved and the app still closes', async () => {
  const { fetchStub, ErrorUtils, storage } = await setup({ respond: () => { throw new TypeError('Network request failed'); } });
  ErrorUtils.raise(new Error('offline crash'), true);
  await tick();
  await tick();
  assert.equal(ErrorUtils.previousCalls.length, 1);
  assert.equal(JSON.parse(storage.data._hqe_pending)[0].payload.message, 'offline crash');
  fetchStub.restore();
});

test('in development a fatal error goes straight to the red box', async () => {
  const { fetchStub, ErrorUtils } = await setup({ isDev: true });
  ErrorUtils.raise(new Error('dev'), true);
  assert.equal(ErrorUtils.previousCalls.length, 1);
  // The report is still sent in the background.
  await tick();
  await tick();
  assert.equal(fetchStub.calls[0].body.message, 'dev');
  fetchStub.restore();
});

test('unhandled promise rejections are reported through Hermes', async () => {
  const { fetchStub, hermes } = await setup();
  hermes.tracker.onUnhandled(7, new Error('nobody caught me'));
  hermes.tracker.onUnhandled(8, 'plain reason');
  await tick();
  const bodies = fetchStub.calls.map((c) => c.body);
  assert.equal(bodies[0].error_type, 'UnhandledRejection');
  assert.equal(bodies[0].message, 'nobody caught me');
  assert.equal(bodies[1].message, 'plain reason');
  fetchStub.restore();
});
