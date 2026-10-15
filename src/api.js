export class ApiError extends Error {
  constructor(service, status) {
    super(`${service} request failed (${status}). Check access, permissions, or rate limits.`);
    this.status = status;
  }
}

// Fixed origins + GET-only transport: no caller can issue a service mutation or
// redirect an authorization header to another origin. Never expose API bodies.
export function createReader({ origin, headers, service, fetchImpl = fetch, now = Date.now }) {
  const conditional = new Map();
  let requests = 0, rateLimit = {}, retryAt = 0;
  async function get(path) {
    const url = new URL(path, origin);
    if (url.origin !== origin || !path.startsWith('/')) throw new Error('Invalid API path');
    const cached = conditional.get(path);
    if (rateLimit.remaining === 0 && rateLimit.resetAt > now()) throw new ApiError(service, 429);
    if (retryAt > now()) throw new ApiError(service, 429);
    requests++;
    const response = await fetchImpl(url, { method: 'GET', headers: { ...headers,
      ...(cached ? { 'If-None-Match': cached.etag } : {}) }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    if (remaining !== null && (!rateLimit.resetAt || reset >= rateLimit.resetAt)) {
      rateLimit = { remaining: reset === rateLimit.resetAt ? Math.min(rateLimit.remaining, Number(remaining)) : Number(remaining),
        limit: Number(response.headers.get('x-ratelimit-limit')) || 5000, resetAt: reset };
    }
    const retry = response.headers.get('retry-after');
    if (retry && [403, 429].includes(response.status)) retryAt = Math.max(retryAt,
      /^\d+$/.test(retry) ? now() + Number(retry) * 1000 : Date.parse(retry) || 0);
    if (response.status === 304 && cached) return cached.result;
    if (!response.ok) throw new ApiError(service, response.status);
    const result = { data: await response.json(), hasNext: /rel="next"/.test(response.headers.get('link') ?? '') };
    const etag = response.headers.get('etag');
    if (etag) {
      conditional.delete(path);
      conditional.set(path, { etag, result });
      if (conditional.size > 2000) conditional.delete(conditional.keys().next().value);
    } else conditional.delete(path);
    return result;
  }
  async function list(path, key, stop) {
    const items = [];
    for (let page = 1; ; page++) {
      const { data, hasNext } = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = key ? data[key] : data;
      if (!Array.isArray(batch)) throw new Error(`Invalid ${service} list response`);
      items.push(...batch);
      if (!hasNext || stop?.(batch)) return items;
    }
  }
  return { get, list, beginCycle: () => { requests = 0; }, usage: () => ({ requests, ...rateLimit, retryAt }) };
}

export async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}
