import { readdir, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';

// Must match the platforms the backend accepts.
export const PLATFORMS = ['web', 'android', 'ios'];
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
// Files per HTTP request; matches MaxFilesPerRequest on the server.
const BATCH_SIZE = 20;
const UPLOAD_CONCURRENCY = 4;

// Flattens an error and its `cause` chain into one line. Node's fetch throws a bare
// "fetch failed" and keeps the real reason (ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT,
// ENOTFOUND, a TLS error...) in `cause`, so without this the build log says nothing useful.
export function describeError(err) {
  const parts = [];
  const seen = new Set();
  let cur = err;
  while (cur && typeof cur === 'object' && !seen.has(cur) && parts.length < 6) {
    seen.add(cur);
    const bits = [cur.name && cur.name !== 'Error' ? cur.name : null, cur.message || null];
    const extra = ['code', 'errno', 'syscall', 'address', 'port']
      .filter((k) => cur[k] !== undefined)
      .map((k) => `${k}=${cur[k]}`);
    if (extra.length) bits.push(`[${extra.join(' ')}]`);
    // Happy-eyeballs connects try every address and report them as an AggregateError.
    if (Array.isArray(cur.errors) && cur.errors.length) {
      bits.push(`{${cur.errors.map((e) => describeError(e)).join(' | ')}}`);
    }
    parts.push(bits.filter(Boolean).join(' '));
    cur = cur.cause;
  }
  if (!parts.length) return String(err);
  return parts.join(' <- caused by: ');
}

// Where this build is running, for telling "wrong network" from "wrong URL". Proxy
// values are reduced to host:port because they can carry credentials; the token is never logged.
function environmentSummary() {
  const proxyHost = (value) => {
    try {
      return new URL(value).host;
    } catch {
      return 'set (unparseable)';
    }
  };
  const proxies = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'NO_PROXY', 'no_proxy']
    .filter((k) => process.env[k])
    .map((k) => `${k}=${k.toLowerCase().includes('no_') ? process.env[k] : proxyHost(process.env[k])}`);
  return [
    `host=${hostname()}`,
    `node=${process.version}`,
    `docker=${existsSync('/.dockerenv')}`,
    `proxy=${proxies.length ? proxies.join(',') : 'none'}`,
  ].join(' ');
}

// Reaches the backend's /health before any map is sent, and logs how it went. Never
// throws: it exists to explain a later upload failure, not to cause one.
async function preflight({ url, fetchImpl, log }) {
  log(`diagnostics: ${environmentSummary()}`);
  const started = Date.now();
  try {
    const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
    log(`diagnostics: GET ${url}/health -> HTTP ${res.status} in ${Date.now() - started}ms`);
  } catch (err) {
    log(`diagnostics: GET ${url}/health FAILED after ${Date.now() - started}ms: ${describeError(err)}`);
  }
}

export async function findMapFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findMapFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith('.map')) {
      files.push(path);
    }
  }
  return files.sort();
}

// Uploads every .map under dir (or just `files`) to the telemetry backend, which
// stores them. Local files are deleted only after every batch has succeeded.
export async function uploadSourcemaps({
  dir,
  files: only,
  platform,
  release,
  url,
  token,
  fetchImpl = globalThis.fetch,
  deleteAfterUpload = false,
  dryRun = false,
  log = () => {},
}) {
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`invalid platform "${platform}" — must be one of ${PLATFORMS.join(', ')}`);
  }
  if (!RELEASE_PATTERN.test(release ?? '')) {
    throw new Error(`release "${release}" must be 1-128 chars of letters, digits, . _ + - (must match the SDK init() release)`);
  }

  for (const file of only ?? []) {
    if (!file.endsWith('.map') || !existsSync(file)) throw new Error(`no sourcemap at ${file}`);
  }
  const files = only ?? (await findMapFiles(dir));
  if (files.length === 0) {
    throw new Error(`no .map files found under ${dir} — did the build emit sourcemaps?`);
  }

  // Two maps with the same basename would overwrite each other on the server.
  const seen = new Map();
  for (const file of files) {
    const name = basename(file);
    if (seen.has(name)) {
      throw new Error(`duplicate map name "${name}" in ${seen.get(name)} and ${file}`);
    }
    seen.set(name, file);
  }

  if (dryRun) {
    for (const file of files) log(`would upload ${platform}/${release}/${basename(file)}`);
    return { uploaded: 0 };
  }
  if (!url || !token) {
    throw new Error('missing upload URL or token (SOURCEMAP_UPLOAD_URL, SOURCEMAP_UPLOAD_TOKEN)');
  }

  log(`uploading ${files.length} map(s) for ${platform} ${release} to ${url}`);
  await preflight({ url, fetchImpl, log });
  const batches = [];
  for (let i = 0; i < files.length; i += BATCH_SIZE) batches.push(files.slice(i, i + BATCH_SIZE));

  // Batches go up in parallel (a few at a time),:
  // a big app has hundreds of maps and one request at a time makes the build wait
  // on every round trip. On the first failure, workers stop taking new batches
  // and the error is thrown, so local files are kept (nothing is deleted below).
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < batches.length) {
      const batch = batches[next++];
      try {
        const form = new FormData();
        form.append('platform', platform);
        form.append('release', release);
        for (const file of batch) {
          const bytes = await readFile(file);
          form.append('file', new Blob([bytes], { type: 'application/json' }), basename(file));
        }
        await postBatch({ url, token, form, fetchImpl });
        for (const file of batch) log(`  ✓ ${basename(file)}`);
      } catch (err) {
        failure ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, batches.length) }, worker));
  if (failure) throw failure;

  if (deleteAfterUpload) {
    // Maps carry sourcesContent: left in a deployed dist/, they hand the
    // original source to anyone with DevTools. See scripts/README.md.
    await Promise.all(files.map((file) => unlink(file)));
    log(`deleted ${files.length} local map file(s)`);
  }

  return { uploaded: files.length };
}

const UPLOAD_TIMEOUT_MS = 60_000;

async function postBatch({ url, token, form, fetchImpl }) {
  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(`${url}/analytics/sourcemaps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      // A hung backend must not stall the build: the timeout turns into a normal
      // upload error, which the Vite plugin logs as a warning and moves on.
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    // No HTTP response at all (refused, timed out, DNS, TLS, reset). Say which, and where.
    throw new Error(
      `POST ${url}/analytics/sourcemaps failed after ${Date.now() - started}ms`,
      { cause: err },
    );
  }
  if (!res.ok) {
    let message = '';
    try {
      message = (await res.json()).message ?? '';
    } catch {
      // Non-JSON error body (e.g. a proxy page); the status is enough.
    }
    throw new Error(`upload failed: HTTP ${res.status}${message ? ` — ${message}` : ''}`);
  }
}
