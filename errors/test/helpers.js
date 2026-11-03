// Replaces globalThis.fetch with a recorder. respond(url, init, n) returns
// { status } or throws to simulate a network failure.
export function stubFetch(respond = () => ({ status: 202 })) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = await respond(String(url), init, calls.length);
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

export function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async getItem(key) { return key in data ? data[key] : null; },
    async setItem(key, value) { data[key] = value; },
  };
}

// Lets fire-and-forget sends settle.
export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
