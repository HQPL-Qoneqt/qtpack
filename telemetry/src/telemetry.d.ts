export interface TelemetryInitConfig {
  apiBase: string;
  platform: 'web' | 'android' | 'ios' | 'server';
  appVersion?: string;
  release?: string;
  // true: send only error reports. Events, sessions and page views are dropped.
  errorsOnly?: boolean;
  // false: SDK sends nothing (no events, sessions, page views or errors). Default true.
  // e.g. enabled: environment === 'production'.
  enabled?: boolean;
  environment?: string;
  projectName?: string;
  // Async hook returning a bearer token; omit on web when the API uses same-origin cookies.
  getAuthToken?: () => Promise<string | null>;
  // Called with every outgoing payload just before it is sent. Return the payload
  // (edited or not) to send it, or null to drop it. If it throws, the payload is dropped.
  beforeSend?: (payload: Record<string, any>, kind: 'event' | 'error' | 'page_view' | 'session') => Record<string, any> | null;
  // Redact email addresses and tokens (JWTs, Bearer values) from outgoing strings. Default true.
  scrubPii?: boolean;
  // Called when a send fails or events are rejected.
  onError?: (detail: Record<string, unknown>) => void;
  // Wrap window.fetch and report failed API calls. Default true. Web only.
  trackFailedRequests?: boolean;
  // Which responses count as failures. Default: status >= 500.
  failedRequestStatus?: (status: number) => boolean;
  // URL substrings or RegExps that are never reported.
  ignoreRequests?: Array<string | RegExp>;

  // React Native only.
  // Current screen name, used as the source of events and errors.
  getCurrentScreen?: () => string;
  // Device name sent with sessions. Default on Android: brand and model; iOS: none.
  getDevice?: () => string;
  // false leaves ErrorUtils alone (no uncaught error reports). Default true.
  trackUncaughtErrors?: boolean;
  // false leaves Hermes' promise rejection tracker alone. Default true.
  trackUnhandledRejections?: boolean;
}

declare const telemetry: {
  init(config: TelemetryInitConfig): Promise<void>;
  track(eventType: string, payload?: Record<string, any>): void;
  impression(opts: Record<string, any>): void;
  trackPage(pageName: string, pageURL?: string): void;
  trackPermission(permissionType: string, result: string, extra?: Record<string, any>): void;
  trackError(errorOrMessage: unknown, extra?: Record<string, unknown>): void;
  captureException(errorOrMessage: unknown, extra?: Record<string, unknown>): void;
  // Reports a crash that is about to close the app: saved first, sent now, and
  // sent on the next launch if the app closes before that. Settles once sent or saved.
  trackFatal(errorOrMessage: unknown, extra?: Record<string, unknown>): Promise<void>;
  login(userId: string | number): void;
  // Sets the user without recording a login, e.g. for a user already signed in at app start.
  identify(userId: string | number): void;
  logout(): void;
};

// Web only (not exported in React Native builds).
// Pass to createRoot() so render errors caught by a router error component are reported.
export const reactRootErrorHandlers: {
  onCaughtError(error: unknown, info: { componentStack?: string }): void;
  onUncaughtError(error: unknown, info: { componentStack?: string }): void;
  onRecoverableError(error: unknown, info: { componentStack?: string }): void;
};
export function reportRenderError(error: unknown, info?: { componentStack?: string }, extra?: Record<string, unknown>): void;

// Web only. Reports page views for a TanStack Router instance.
export function withTanStackRouter<T>(router: T): void;

export default telemetry;
