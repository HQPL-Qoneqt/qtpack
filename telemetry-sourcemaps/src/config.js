// Env var names are the ones CI sets. The token comes only from the environment,
// never a flag, so it doesn't end up in shell history or `ps` output.
export const REQUIRED_UPLOAD_ENV = ['SOURCEMAP_UPLOAD_TOKEN', 'SOURCEMAP_UPLOAD_URL'];

export function resolveUploadConfig(env = process.env) {
  const missing = REQUIRED_UPLOAD_ENV.filter((name) => !env[name]);
  if (missing.length > 0) {
    return { configured: false, missing };
  }
  return {
    configured: true,
    token: env.SOURCEMAP_UPLOAD_TOKEN,
    url: env.SOURCEMAP_UPLOAD_URL.replace(/\/+$/, ''),
  };
}
