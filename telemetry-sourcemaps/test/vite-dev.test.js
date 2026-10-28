import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildErrorPayload, codeExcerpt } from '../src/vite-dev.js';

const tempFile = (lines) => {
  const file = join(mkdtempSync(join(tmpdir(), 'excerpt-')), 'a.jsx');
  writeFileSync(file, lines.join('\n'));
  return file;
};

const opts = { projectName: 'my-web-app', release: 'my-web-app-0.0.1' };

test('message is the detail line, not Vite summary', () => {
  const err = Object.assign(new Error('Transform failed with 1 error:\n/app/src/a.tsx: Unexpected token (2:0)'), {
    loc: { file: '/app/src/a.tsx', line: 2, column: 0 },
  });
  const p = buildErrorPayload(err, opts);
  assert.equal(p.message, '/app/src/a.tsx: Unexpected token (2:0)');
  assert.equal(p.endpoint, '/app/src/a.tsx:2:0');
});

test('stack is the code frame when Vite provides one', () => {
  const err = Object.assign(new Error('Unexpected token'), { frame: '1 | export const X =\n> 2 | <div' });
  assert.equal(buildErrorPayload(err, opts).stack, '1 | export const X =\n> 2 | <div');
});

test('stack is only the code frame: Node call stack is left out', () => {
  const err = Object.assign(new Error('x'), { stack: 'Error: x\n    at transformWithOxc (node.js:1)' });
  assert.equal(buildErrorPayload(err, opts).stack, '');
});

test('fingerprint is stable for the same error and differs for another', () => {
  const a = buildErrorPayload(Object.assign(new Error('boom'), { loc: { file: 'a.tsx', line: 1, column: 0 } }), opts);
  const b = buildErrorPayload(Object.assign(new Error('boom'), { loc: { file: 'a.tsx', line: 1, column: 0 } }), opts);
  const c = buildErrorPayload(Object.assign(new Error('boom'), { loc: { file: 'a.tsx', line: 9, column: 0 } }), opts);
  assert.match(a.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test('session, connection and environment fields are filled', () => {
  const p = buildErrorPayload(new Error('boom'), opts);
  assert.match(p.session_id, /^[0-9a-f-]{36}$/);
  assert.equal(p.session_id, buildErrorPayload(new Error('other'), opts).session_id);
  assert.equal(p.connection_type, 'dev-server');
  assert.match(p.user_agent, /^vite-dev \(node /);
  assert.ok(p.timezone);
  assert.equal(p.level, 'error');
});

test('carries project, release and BuildError type', () => {
  const p = buildErrorPayload(new Error('boom'), opts);
  assert.equal(p.project_name, 'my-web-app');
  assert.equal(p.release, 'my-web-app-0.0.1');
  assert.equal(p.app_version, 'my-web-app-0.0.1');
  assert.equal(p.error_type, 'BuildError');
  assert.equal(p.environment, 'development');
  assert.equal(p.platform, 'web');
});

test('file falls back to id when loc is missing', () => {
  const err = Object.assign(new Error('boom'), { id: '/app/src/b.tsx' });
  assert.equal(buildErrorPayload(err, opts).endpoint, '/app/src/b.tsx');
});

test('ANSI color codes are removed from message and stack', () => {
  const colored = '\u001b[31m[PARSE_ERROR]\u001b[0m Unexpected token';
  const err = Object.assign(new Error(colored), { frame: '\u001b[38;5;246m41 │\u001b[0m <div>' });
  const p = buildErrorPayload(err, opts);
  assert.equal(p.message, '[PARSE_ERROR] Unexpected token');
  assert.equal(p.stack, '41 │ <div>');
  assert.ok(!/\u001b/.test(p.stack + p.message));
});

test('oxc-style message: reason is the message, the code box becomes the stack', () => {
  const err = new Error(
    'Transform failed with 1 error:\n[PARSE_ERROR] Unexpected token. Did you mean `{\'>\'}`?\n' +
    '    ╭─[ src/a.jsx:41:48 ]\n    │\n 41 │ foo\n────╯',
  );
  const p = buildErrorPayload(err, opts);
  assert.equal(p.message, '[PARSE_ERROR] Unexpected token. Did you mean `{\'>\'}`?');
  assert.match(p.stack, /╭─\[ src\/a\.jsx:41:48 \]/);
  assert.match(p.stack, / 41 │ foo/);
  assert.ok(!p.stack.includes('Transform failed'));
});

test('codeExcerpt numbers lines around the error and puts a caret under the column', () => {
  const file = tempFile(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`));
  const out = codeExcerpt(file, 10, 3, 2);
  assert.equal(out.split('\n').length, 6); // 2 before, error, caret, 2 after
  assert.match(out, /^ {3}8 \| line 8$/m);
  assert.match(out, /^> 10 \| line 10$/m);
  assert.match(out, /\|\s+\^$/m);
});

test('codeExcerpt clamps to the start and end of the file', () => {
  const file = tempFile(['a', 'b', 'c']);
  const out = codeExcerpt(file, 1, 1, 8);
  assert.equal(out.split('\n')[0].startsWith('> 1 | a'), true);
  assert.equal(out.split('\n').filter((l) => l.includes('|')).length, 4); // 3 lines + caret
});

test('codeExcerpt returns empty when the file is missing', () => {
  assert.equal(codeExcerpt('/nope/missing.jsx', 3, 1), '');
});

test('payload stack is the numbered excerpt read from the file', () => {
  const file = tempFile(['const a = 1;', 'const b = <div>', '};']);
  const err = Object.assign(new Error('Unexpected token'), { loc: { file, line: 3, column: 1 } });
  const p = buildErrorPayload(err, opts);
  assert.match(p.stack, /^> 3 \| };$/m);
  assert.match(p.stack, /^ {2}1 \| const a = 1;$/m);
});

test('oxc errors: position comes from the code box, the excerpt from the file', () => {
  const file = tempFile(['const a = 1;', 'const b = 2;', 'export const Y = <div>', '  {/* broken */']);
  const err = new Error(
    `Transform failed with 1 error:\n[PARSE_ERROR] Unexpected token\n    ╭─[ src/x.jsx:4:17 ]\n    │\n 4 │   {/* broken */`,
  );
  err.id = file;
  const p = buildErrorPayload(err, opts);
  assert.equal(p.endpoint, `${file}:4:17`);
  assert.match(p.stack, /^> 4 \| {3}\{\/\* broken \*\/$/m);
});
