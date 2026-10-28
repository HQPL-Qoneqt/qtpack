import { createHash, randomBytes } from 'node:crypto';

// Project names are slugs, the same rule the backend applies to SOURCEMAP_PROJECT_TOKENS
// and to project_name on error ingest.
export const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// 32 random bytes as 64 hex chars, the same shape `openssl rand -hex 32` gives.
export function newToken() {
  return randomBytes(32).toString('hex');
}

// The backend stores and compares sha256(token) as lowercase hex. Only this
// hash goes into SOURCEMAP_PROJECT_TOKENS; the token itself never does.
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function assertProjectName(name) {
  if (!PROJECT_NAME_PATTERN.test(name ?? '')) {
    throw new Error(`project "${name}" must be a slug: 1-64 chars of a-z, 0-9, _ or -`);
  }
}
