import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveUploadConfig } from './config.js';
import { injectDebugIds } from './debug-id.js';
import { describeError, findMapFiles, uploadSourcemaps } from './upload.js';

// Uploads a Vite build's .map files right after the bundle is written, the
// same way a bundler plugin would. Options:
//   url                telemetry backend base URL; defaults to SOURCEMAP_UPLOAD_URL.
//   token              upload token; defaults to SOURCEMAP_UPLOAD_TOKEN.
//   release            defaults to RELEASE. Must match the release passed to the SDK's init().
//   platform           defaults to "web".
//   deleteAfterUpload  defaults to true, so maps never end up in the deployed dist/.
//   enabled            set false to turn the plugin off entirely.
//   failOnError        defaults to false (or SOURCEMAP_FAIL_ON_ERROR=1). By default a
//                      missing config or failed upload only logs a warning, so the
//                      deploy is never blocked by this plugin. Set true to fail the
//                      build instead (e.g. a CI job that must not ship without maps).
//
// On failure the maps are still removed from dist/ (when deleteAfterUpload is
// on), because they contain original source and must never be deployed. The
// cost is that errors from that build get no code frame.
export default function sourcemapUploadPlugin(options = {}) {
  const enabled = options.enabled !== false;
  const platform = options.platform ?? 'web';
  const deleteAfterUpload = options.deleteAfterUpload ?? true;
  const failOnError = options.failOnError ?? ['1', 'true'].includes(process.env.SOURCEMAP_FAIL_ON_ERROR);

  const credentials = () => {
    const env = {
      ...process.env,
      SOURCEMAP_UPLOAD_URL: options.url ?? process.env.SOURCEMAP_UPLOAD_URL,
      SOURCEMAP_UPLOAD_TOKEN: options.token ?? process.env.SOURCEMAP_UPLOAD_TOKEN,
    };
    return { release: options.release ?? process.env.RELEASE, upload: resolveUploadConfig(env) };
  };

  let outDir = null;
  let buildFailed = false;

  return {
    name: 'telemetry-sourcemaps',
    apply: 'build',

    config(userConfig) {
      if (!enabled) return;
      const { release, upload } = credentials();
      if (!upload.configured || !release) return;
      // Generate maps for upload only. 'hidden' leaves out the
      // sourceMappingURL comment, so browsers never fetch them.
      if (userConfig.build?.sourcemap === undefined) {
        return { build: { sourcemap: 'hidden' } };
      }
    },

    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },

    // Vite still calls closeBundle after a failed build, when there is no
    // output to upload and the real error is already being reported.
    buildEnd(error) {
      buildFailed = Boolean(error);
    },

    async closeBundle() {
      if (!enabled || buildFailed) return;

      try {
        const { release, upload } = credentials();
        if (!upload.configured) {
          throw new Error(`skipping upload: missing ${upload.missing.join(', ')}`);
        }
        if (!release) {
          throw new Error('release is required: pass the release option or set RELEASE');
        }

        const log = (line) => console.log(`[telemetry-sourcemaps] ${line}`);
        await injectDebugIds(outDir, { log });
        await uploadSourcemaps({
          dir: outDir,
          platform,
          release,
          url: upload.url,
          token: upload.token,
          deleteAfterUpload,
          log,
        });
      } catch (err) {
        if (failOnError) throw err;
        console.warn(`[telemetry-sourcemaps] sourcemaps not uploaded, build continues: ${describeError(err)}`);
        await removeMaps(outDir, deleteAfterUpload);
      }
    },
  };
}

// Maps hold the original source, so a failed upload must not leave them in the
// directory that gets deployed.
async function removeMaps(dir, deleteAfterUpload) {
  if (!deleteAfterUpload || !dir) return;
  try {
    const maps = await findMapFiles(dir);
    await Promise.all(maps.map((file) => rm(file, { force: true })));
    if (maps.length) console.warn(`[telemetry-sourcemaps] removed ${maps.length} map file(s) from ${dir} so they are not deployed`);
  } catch (err) {
    console.warn(`[telemetry-sourcemaps] could not clean up map files: ${err.message}`);
  }
}
