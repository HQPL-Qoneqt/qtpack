import type { Plugin } from 'vite';

export interface SourcemapUploadOptions {
  url?: string;
  token?: string;
  release?: string;
  platform?: 'web' | 'android' | 'ios';
  deleteAfterUpload?: boolean;
  enabled?: boolean;
  /** Fail the build on upload errors. Default false: warn and continue. */
  failOnError?: boolean;
}

export default function sourcemapUploadPlugin(options?: SourcemapUploadOptions): Plugin;
