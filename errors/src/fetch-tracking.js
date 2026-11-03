// Failed API calls. A 502 or a dropped connection is a normal fetch() result, not
// an exception, so no error handler ever sees it. This wraps the global fetch
// once so every call is covered. Used on web and React Native; apps on axios
// report from an interceptor with trackFailedRequest instead.
//
// init() options (all optional):
//   trackFailedRequests  false turns it off. Default true.
//   failedRequestStatus  (status) => boolean. Default: 500 and above (4xx are usually expected).
//   ignoreRequests       strings or RegExps matched against the URL (applied in core).
// Aborted requests are not reported. Bodies, headers and query strings are never read or sent.

const MARK = '__hqplErrorsWrapped';

export function installFetchTracking(client, config = {}) {
  const g = globalThis;
  if (config.trackFailedRequests === false || typeof g.fetch !== 'function' || g.fetch[MARK]) return;

  const isFailure = typeof config.failedRequestStatus === 'function' ? config.failedRequestStatus : (status) => status >= 500;
  const nativeFetch = g.fetch;

  const wrapped = async function hqplErrorsFetch(input, init) {
    const url = _urlOf(input);
    const method = String(init?.method || (input && typeof input === 'object' && input.method) || 'GET');
    let response;
    try {
      // Called on globalThis: browsers throw "Illegal invocation" otherwise.
      response = await nativeFetch.call(g, input, init);
    } catch (error) {
      if (error?.name !== 'AbortError') client.trackFailedRequest({ method, url, status: 0, error });
      throw error;
    }
    try {
      if (response && isFailure(response.status)) client.trackFailedRequest({ method, url, status: response.status });
    } catch { /* a broken failedRequestStatus must not break the app's request */ }
    return response;
  };
  wrapped[MARK] = true;
  g.fetch = wrapped;
}

function _urlOf(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url; // Request
  return String(input ?? ''); // URL
}
