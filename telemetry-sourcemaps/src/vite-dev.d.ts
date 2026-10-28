import type { Plugin } from 'vite';

export interface BuildErrorReporterOptions {
  // Base URL of the telemetry backend, e.g. http://localhost:8080 (no path).
  apiTarget: string;
  // Project slug the SDK reports, e.g. "telemetry" or "my-web-app".
  projectName: string;
  // Release the SDK reports, e.g. "telemetry-0.0.0".
  release: string;
}

export interface BuildErrorPayloadError extends Error {
  loc?: { file?: string; line?: number; column?: number };
  id?: string;
  frame?: string;
}

export function buildErrorPayload(
  err: BuildErrorPayloadError,
  options: { projectName: string; release: string },
): Record<string, string>;

// Dev-only: reports Vite compile failures to /analytics/errors as error_type=BuildError.
export default function buildErrorReporter(options: BuildErrorReporterOptions): Plugin;
