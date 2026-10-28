import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertProjectName, hashToken, newToken } from '../src/token.js';

const BIN = fileURLToPath(new URL('../bin/telemetry-sourcemaps.js', import.meta.url));

function run(args, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

test('newToken is 64 lowercase hex chars and never repeats', () => {
  const a = newToken();
  const b = newToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('hashToken is sha256 of the token bytes, matching `printf %s TOKEN | sha256sum`', () => {
  assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hashToken('abc'), createHash('sha256').update('abc').digest('hex'));
});

test('assertProjectName accepts the three app slugs and rejects everything else', () => {
  for (const name of ['telemetry', 'my-web-app', 'my-mobile-app', 'a_1']) {
    assert.doesNotThrow(() => assertProjectName(name));
  }
  for (const name of ['', 'Dashboard', '-web', 'my web', 'my@web', 'x'.repeat(65)]) {
    assert.throws(() => assertProjectName(name), /must be a slug/);
  }
});

test('token new prints only the token on stdout and the matching hash entry on stderr', async () => {
  const { code, stdout, stderr } = await run(['token', 'new', '--project', 'my-web-app']);
  assert.equal(code, 0);
  const token = stdout.trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(stderr.includes(`my-web-app:${hashToken(token)}`), stderr);
  assert.ok(!stderr.includes(token), 'the token itself must not be printed to stderr');
});

test('token new refuses a missing or invalid project name', async () => {
  const missing = await run(['token', 'new']);
  assert.notEqual(missing.code, 0);
  const invalid = await run(['token', 'new', '--project', 'My Web']);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /must be a slug/);
});

test('token hash reads the token from stdin and prints its hash', async () => {
  const { code, stdout } = await run(['token', 'hash'], 'abc\n');
  assert.equal(code, 0);
  assert.equal(stdout.trim(), hashToken('abc'));
});
