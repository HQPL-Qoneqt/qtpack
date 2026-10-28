// Metro config wrapper that stamps a debug ID into every bundle and its map:
//
//   // metro.config.js
//   const { getDefaultConfig } = require('expo/metro-config');
//   const { withDebugIds } = require('@hqpl/qtpack/metro');
//   module.exports = withDebugIds(getDefaultConfig(__dirname));
//
// CommonJS because metro.config.js is loaded with require(); debug-id.js is ESM,
// which require() loads on Node 20.19+ / 22.12+ (Expo's minimum).

const path = require('node:path');
const { finalizeMetroBundle } = require('./debug-id.js');

// registrationSnippet(PLACEHOLDER) as a file, since Metro only takes polyfills
// from disk (test/debug-id.test.js checks the two stay identical).
const POLYFILL = path.join(__dirname, 'debug-id-polyfill.js');

// Metro's own serializer, for configs (bare React Native) that don't set one.
function defaultSerializer() {
  for (const base of ['metro/private', 'metro/src']) {
    try {
      const bundleToString = require(`${base}/lib/bundleToString`);
      const baseJSBundle = require(`${base}/DeltaBundler/Serializers/baseJSBundle`);
      const unwrap = (m) => m.default ?? m;
      return (entryPoint, preModules, graph, options) =>
        unwrap(bundleToString)(unwrap(baseJSBundle)(entryPoint, preModules, graph, options)).code;
    } catch {}
  }
  throw new Error('[qtpack] could not load Metro\'s default serializer');
}

// Mutates config in place: Expo's serializer keeps a reference to the original
// config object, so a copy would leave it reading stale settings.
function withDebugIds(config) {
  config.serializer ??= {};
  const serializer = config.serializer;
  const getPolyfills = serializer.getPolyfills ?? (() => []);
  const original = serializer.customSerializer ?? defaultSerializer();

  // Metro only reads files it watches; a copy of this tool outside the project
  // (e.g. shared from another repo) has to be added.
  const root = config.projectRoot ?? process.cwd();
  if (path.relative(root, __dirname).startsWith('..')) {
    config.watchFolders = [...(config.watchFolders ?? []), __dirname];
  }

  serializer.getPolyfills = (ctx) => [...getPolyfills(ctx), POLYFILL];
  serializer.customSerializer = async (entryPoint, preModules, graph, options) => {
    const output = await original(entryPoint, preModules, graph, options);
    if (typeof output === 'string') return finalizeMetroBundle(output, null).code;
    // `expo export` (EAS Update, web) returns an array of assets, not one bundle.
    if (!output || typeof output.code !== 'string') return output;
    const { code, map } = finalizeMetroBundle(output.code, output.map);
    return { ...output, code, map };
  };
  return config;
}

module.exports = { withDebugIds };
