import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { findMapFiles } from './upload.js';

// Debug IDs (the TC39 debug ID proposal): a UUID derived from a bundle's
// content, written into its map as "debugId" and registered at runtime by a
// snippet in the bundle. The SDK reports the IDs of the bundles in an error's
// stack, and the backend picks the map by ID, so resolution never depends on
// someone bumping the release.

// The SDK reads this global (telemetry-core.js, _debugIds).
export const REGISTRY = '__telemetryDebugIds';

// Same length as a UUID, so swapping it for the real ID shifts no column in the map.
export const PLACEHOLDER = '__telemetry_debug_id_placeholder____';

const DEBUG_ID_COMMENT = /^\/\/# debugId=.*$/gm;

// One line, no newlines: keys the bundle's own load-time stack (whose first
// frame names the bundle file) to its ID.
export function registrationSnippet(id) {
  return (
    `;!function(){try{var g="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},` +
    `s=(new Error).stack;s&&((g.${REGISTRY}=g.${REGISTRY}||{})[s]="${id}")}catch(e){}}();`
  );
}

// UUID (v4 layout) from a hash of the given strings.
export function debugIdFromContent(...parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  const h = hash.digest('hex');
  const variant = ['8', '9', 'a', 'b'][parseInt(h[16], 16) % 4];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function withDebugIdComment(code, id) {
  const stripped = code.replace(DEBUG_ID_COMMENT, '').replace(/\n+$/, '');
  return `${stripped}\n//# debugId=${id}\n`;
}

// True when the bundle already carries a registration snippet. Looks for the
// snippet's assignment, not the bare REGISTRY name: a bundle that includes the
// SDK mentions the name too (it reads the registry), and must still be stamped.
function hasRegistration(code) {
  return code.includes(`${REGISTRY}=g.${REGISTRY}||{}`);
}

// For bundles already written to disk with a separate map (Vite, webpack, any
// JS output): prepends the registration snippet as a new first line and shifts
// the map down one line to match. Returns the ID, or null if left untouched.
export function injectIntoCode(code, map) {
  if (map.debugId || hasRegistration(code)) return null;
  const id = debugIdFromContent(code, JSON.stringify(map));
  map.debugId = id;
  // One leading ";" adds an empty generated line; every later segment keeps its
  // meaning because columns reset per line and other fields are relative.
  map.mappings = `;${map.mappings}`;
  return { id, code: withDebugIdComment(`${registrationSnippet(id)}\n${code}`, id) };
}

// Injects every .map under dir whose generated file sits next to it as text
// (index-abc.js.map -> index-abc.js). Bytecode or missing bundles are skipped:
// those maps keep working through the release fallback.
export async function injectDebugIds(dir, { log = () => {} } = {}) {
  let injected = 0;
  for (const mapPath of await findMapFiles(dir)) {
    const codePath = mapPath.slice(0, -'.map'.length);
    let code;
    try {
      code = await readFile(codePath, 'utf8');
    } catch {
      continue;
    }
    if (code.includes('\0')) continue;
    const map = JSON.parse(await readFile(mapPath, 'utf8'));
    const result = injectIntoCode(code, map);
    if (!result) continue;
    await writeFile(codePath, result.code);
    await writeFile(mapPath, JSON.stringify(map));
    injected += 1;
  }
  if (injected) log(`injected debug IDs into ${injected} bundle(s)`);
  return injected;
}

// React Native's Hermes step (compose-source-maps) builds a new map from Metro's
// map and the bytecode map and drops "debugId". This copies it back from Metro's
// map. Returns the ID, or null if the source map has none.
export async function copyDebugId(fromMapPath, toMapPath) {
  const from = JSON.parse(await readFile(fromMapPath, 'utf8'));
  if (!from.debugId) return null;
  const to = JSON.parse(await readFile(toMapPath, 'utf8'));
  const updated = withMapDebugId(to, from.debugId);
  if (to.debugId === updated.debugId && to.debug_id === updated.debug_id) return from.debugId;
  await writeFile(toMapPath, JSON.stringify(updated));
  return from.debugId;
}

// Both spellings name the same bundle: "debugId" (what the backend reads first)
// and "debug_id" (older tools such as sentry-cli also read it). If a map has the
// second, it is set to the same ID, so no tool ever sees a stale one.
function withMapDebugId(map, id) {
  return 'debug_id' in map ? { ...map, debugId: id, debug_id: id } : { ...map, debugId: id };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// An ID the bundler or another tool already gave this bundle. Expo's serializer
// computes one for release exports and puts it in the map ("debugId"), in a
// "//# debugId=" comment, and (via Sentry's plugin) in Sentry's runtime snippet
// as "sentry-dbid-<id>". An all-zero stand-in doesn't count.
function existingDebugId(code, map) {
  let parsed = map;
  try {
    if (typeof map === 'string') parsed = JSON.parse(map);
  } catch {
    parsed = null;
  }
  const candidates = [
    code.match(/^\/\/# debugId=(\S+)\s*$/m)?.[1],
    parsed?.debugId,
    parsed?.debug_id,
    code.match(/sentry-dbid-([0-9a-fA-F-]{36})/)?.[1],
  ];
  for (const raw of candidates) {
    const id = typeof raw === 'string' ? raw.toLowerCase() : null;
    if (id && UUID.test(id) && !/^[0-]+$/.test(id)) return id;
  }
  return null;
}

// For Metro: the snippet ships as a polyfill containing PLACEHOLDER, so it is in
// every map Metro builds (including the dev server's .map endpoint, which skips
// custom serializers). This swaps the placeholder for the bundle's real ID.
//
// If the bundle already has an ID (from Expo, which Sentry also uses), telemetry-sourcemaps uses
// that same one, so every tool's map matches the same bundle. Otherwise telemetry-sourcemaps makes
// its own from the bundle's content. Either way nothing depends on Sentry: removing
// it changes nothing here.
export function finalizeMetroBundle(code, map) {
  if (!code.includes(PLACEHOLDER)) return { code, map, id: null };
  const id = existingDebugId(code, map) ?? debugIdFromContent(code);
  const finalCode = withDebugIdComment(code.split(PLACEHOLDER).join(id), id);
  let finalMap = map;
  if (typeof map === 'string') {
    finalMap = JSON.stringify(withMapDebugId(JSON.parse(map), id));
  } else if (map && typeof map === 'object') {
    finalMap = withMapDebugId(map, id);
  }
  return { code: finalCode, map: finalMap, id };
}
