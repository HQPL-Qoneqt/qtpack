// Dev-only build error reporting for Vite. Compile and transform failures (e.g. a
// JSX syntax error) are sent to the telemetry backend as error_type=BuildError.
// The browser SDK can't do this for a broken module: the module stops the app
// bundle before telemetry.init() runs. Vite logs these failures through its logger
// with the error attached, so hooking the logger sees every one.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// One session per dev-server run, so the dashboard's Session field groups a run.
const SESSION_ID = randomUUID();
const USER_AGENT = `vite-dev (node ${process.version}, ${process.platform})`;

// A page load requests the same broken module several times within a second or two.
// Collapse that burst, but send every later reload.
const DEDUPE_MS = 2_000;

// Vite's first line for a transform failure is only a summary, not the reason.
const SUMMARY_LINE = /^Transform failed with \d+ error/;

// Vite colors its terminal output (ESC[31m … ESC[0m). Those codes are meaningless in
// the dashboard, so remove them.
const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (text) => String(text ?? '').replace(ANSI, '');

// Lines of code to show on each side of the error.
const EXCERPT_CONTEXT = 8;

// Numbered source lines around the error, with a caret under the column, read from the
// file on disk. Returns '' when the file can't be read. Exported for tests.
export function codeExcerpt(file, line, column = 0, context = EXCERPT_CONTEXT) {
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    return '';
  }
  const start = Math.max(1, line - context);
  const end = Math.min(lines.length, line + context);
  const width = String(end).length;
  const out = [];
  for (let n = start; n <= end; n++) {
    out.push(`${n === line ? '>' : ' '} ${String(n).padStart(width)} | ${lines[n - 1]}`);
    if (n === line) {
      out.push(`  ${' '.repeat(width)} | ${' '.repeat(Math.max(0, column - 1))}^`);
    }
  }
  return out.join('\n');
}

// Builds the telemetry payload for one compile error. Exported for tests.
export function buildErrorPayload(err, { projectName, release }) {
  // Split Vite's message into the reason and the code box. Babel puts the file and
  // reason on one line; oxc puts the reason on one line, then the code box below it.
  const lines = plain(err.message).split('\n');
  const detail = lines.filter((line) => line.trim() && !SUMMARY_LINE.test(line.trim()));
  const reasonIndex = detail.findIndex((line) => line.trim());
  const message = (detail[reasonIndex] ?? plain(err.message)).trim() || 'Build error';
  const boxLines = detail.slice(reasonIndex + 1).join('\n').trimEnd();

  // Position: Babel sets err.loc; oxc only names it in the code box ("[ file:line:col ]").
  const box = plain(err.message).match(/\[\s*[^\]]*?:(\d+):(\d+)\s*\]/);
  const file = err.loc?.file ?? err.id ?? '';
  const line = err.loc?.line ?? (box ? Number(box[1]) : undefined);
  const column = err.loc?.column ?? (box ? Number(box[2]) : 0);
  const endpoint = line ? `${file}:${line}:${column}` : file;

  // The code frame: the source around the error, read from the file (numbered, with a
  // caret). If the file can't be read, use Vite's own frame or the code box in the message.
  const excerpt = line ? codeExcerpt(file, line, column) : '';
  const stack = excerpt || plain(err.frame).trimEnd() || boxLines;

  // Same error at the same place groups together in the dashboard.
  const fingerprint = createHash('sha1')
    .update(`${projectName}|BuildError|${endpoint}|${message}`)
    .digest('hex')
    .slice(0, 16);

  return {
    platform: 'web',
    release,
    app_version: release,
    project_name: projectName,
    environment: 'development',
    level: 'error',
    error_type: 'BuildError',
    message,
    endpoint,
    fingerprint,
    // Vite's code frame: the source lines around the error, with a caret. Node's own
    // call stack is left out, since it only shows Vite internals.
    stack,
    source: 'vite-dev',
    session_id: SESSION_ID,
    user_agent: USER_AGENT,
    connection_type: 'dev-server',
    language: 'en',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// The Vite plugin. Pass the telemetry base URL (where /analytics/errors lives), the
// project slug and the release the app's SDK reports.
export default function buildErrorReporter({ apiTarget, projectName, release }) {
  const lastSent = new Map();

  return {
    name: 'telemetry-build-error-reporter',
    apply: 'serve',
    configureServer(server) {
      const logger = server.config.logger;
      const logError = logger.error;
      logger.error = (msg, options) => {
        if (options?.error) {
          const payload = buildErrorPayload(options.error, { projectName, release });
          const key = `${payload.endpoint}|${payload.message}`;
          const now = Date.now();
          if (now - (lastSent.get(key) ?? 0) >= DEDUPE_MS) {
            lastSent.set(key, now);
            fetch(`${apiTarget}/analytics/errors`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }).catch(() => {
              // The telemetry backend being down must never break the dev server.
            });
          }
        }
        return logError(msg, options);
      };
    },
  };
}
