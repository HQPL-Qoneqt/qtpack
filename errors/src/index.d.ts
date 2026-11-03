export type Level = 'fatal' | 'error' | 'warning' | 'info';
export type Platform = 'web' | 'android' | 'ios' | 'server';

export interface ErrorsInitConfig {
  // Full URL of the error ingest endpoint, e.g. 'https://api.example.com/api/cx/errors'.
  endpoint?: string;
  // Or the base of a proxy that serves cx/errors (must end with '/'): endpoint = apiBase + 'cx/errors'.
  apiBase?: string;
  // Registered analytics project (an entry in the server's SOURCEMAP_PROJECT_TOKENS; a-z, 0-9,
  // _ or -, at most 64). The server refuses reports without one. Same as the qtpack upload project.
  projectName: string;
  // Must match the release qtpack uploaded the sourcemaps under. Defaults to appVersion.
  release?: string;
  appVersion?: string;
  environment?: string;
  // Default: 'web' on web, Platform.OS on React Native.
  platform?: Platform;
  // false: nothing is captured or sent and no handlers are installed. Default true.
  enabled?: boolean;

  // Extra headers on every report (e.g. a project ingest key).
  headers?: Record<string, string>;
  // Returns a bearer token, or null to send none. Omit on web when same-origin cookies authenticate.
  getAuthToken?: () => string | null | undefined | Promise<string | null | undefined>;
  // Last look at every report. Return it (edited or not) to send it, or null to drop it.
  // A throwing beforeSend drops the report.
  beforeSend?: (payload: ErrorPayload) => ErrorPayload | null;
  // Redact email addresses, JWTs and Bearer values from every string. Default true.
  scrubPii?: boolean;
  // Called when a report could not be sent.
  onSendError?: (detail: { status?: number; error?: string }) => void;
  // Where each report happened (`source`). Default on web: location.pathname; on React Native: none.
  getCurrentScreen?: () => string;
  // Async key-value store for fatal crash reports that must survive the restart.
  // Default on web: localStorage. On React Native pass AsyncStorage; without it a
  // crash report that couldn't be sent before the app closed is lost.
  storage?: { getItem(key: string): Promise<string | null> | string | null; setItem(key: string, value: string): Promise<void> | void };

  // Report uncaught errors (window 'error' / ErrorUtils). Default true.
  trackUncaughtErrors?: boolean;
  // Report unhandled promise rejections (window 'unhandledrejection' / Hermes). Default true.
  trackUnhandledRejections?: boolean;
  // Wrap the global fetch and report failed calls. Default true.
  trackFailedRequests?: boolean;
  // Which responses count as failures. Default: status >= 500.
  failedRequestStatus?: (status: number) => boolean;
  // URL substrings or RegExps never reported as failed requests.
  ignoreRequests?: Array<string | RegExp>;
}

// Fields of a report. `extra` may set any of them; unknown fields are ignored by the server.
export interface ErrorPayload {
  platform: Platform;
  message: string;
  level?: Level;
  is_fatal?: boolean;
  error_type?: string;
  error_code?: string;
  error_name?: string;
  stack?: string;
  cause?: string;
  component_stack?: string;
  fingerprint?: string;
  status?: string;
  method?: string;
  endpoint?: string;
  source?: string;
  release?: string;
  app_version?: string;
  environment?: string;
  project_name?: string;
  user_id?: number;
  session_id?: string;
  session_seq?: number;
  user_agent?: string;
  connection_type?: string;
  language?: string;
  timezone?: string;
  breadcrumbs?: Breadcrumb[];
  debug_ids?: Record<string, string>;
  [key: string]: unknown;
}

export interface Breadcrumb {
  category: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export interface FailedRequest {
  method?: string;
  url: string;
  // 0 or omitted: the request never got a response (offline, DNS, CORS, timeout).
  status?: number;
  error?: unknown;
}

export interface ErrorsClient {
  init(config: ErrorsInitConfig): Promise<void>;
  captureException(errorOrMessage: unknown, extra?: Partial<ErrorPayload>): void;
  // Alias of captureException.
  trackError(errorOrMessage: unknown, extra?: Partial<ErrorPayload>): void;
  captureMessage(message: string, level?: Level, extra?: Partial<ErrorPayload>): void;
  // A crash about to close the app: saved first, then sent; resent on the next
  // init() if the app closed first. Settles once sent or saved.
  trackFatal(errorOrMessage: unknown, extra?: Partial<ErrorPayload>): Promise<void>;
  // For axios or other non-fetch clients. Only the URL path is sent.
  trackFailedRequest(request: FailedRequest): void;
  // Numeric user ID, or null on logout.
  setUser(userId: number | string | null): void;
  addBreadcrumb(category: string, message: string, data?: Record<string, unknown>): void;
  // Sends reports queued while offline or after a failed send.
  flush(): Promise<void>;
  isEnabled(): boolean;
}

declare const errors: ErrorsClient;
export default errors;

export const init: ErrorsClient['init'];
export const captureException: ErrorsClient['captureException'];
export const trackError: ErrorsClient['trackError'];
export const captureMessage: ErrorsClient['captureMessage'];
export const trackFatal: ErrorsClient['trackFatal'];
export const trackFailedRequest: ErrorsClient['trackFailedRequest'];
export const setUser: ErrorsClient['setUser'];
export const addBreadcrumb: ErrorsClient['addBreadcrumb'];
export const flush: ErrorsClient['flush'];
export const isEnabled: ErrorsClient['isEnabled'];

export function reportRenderError(error: unknown, info?: { componentStack?: string | null }, extra?: Partial<ErrorPayload>): void;
// React 19 (react-dom): createRoot(el, reactRootErrorHandlers).
export const reactRootErrorHandlers: {
  onCaughtError(error: unknown, info: { componentStack?: string }): void;
  onUncaughtError(error: unknown, info: { componentStack?: string }): void;
  onRecoverableError(error: unknown, info: { componentStack?: string }): void;
};
