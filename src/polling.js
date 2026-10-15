import { rules } from '../config/rules.js';

export function pollInterval({ repoCount = 0, prCount = 0, requests = 0, remaining, limit,
  resetAt = 0, retryAt = 0, now = Date.now() }, config = rules.polling) {
  // Two PR-list calls per repo + seven detail calls per PR. Actual observed
  // requests account for pagination and the first Checks -> Actions fallback.
  const cost = Math.max(repoCount * 2 + prCount * 7, requests, 1);
  const hourlyLimit = Math.min(limit || config.hourlyLimit, config.hourlyLimit);
  const budget = hourlyLimit * config.budgetFraction;
  let interval = Math.max(rules.pollMs, Math.ceil(cost * 3_600_000 / budget));
  if (remaining !== undefined && remaining < hourlyLimit * config.lowRemainingFraction && (!resetAt || resetAt > now)) {
    interval = Math.max(interval, resetAt > now
      ? remaining < cost ? resetAt - now + 1000
        : Math.min(resetAt - now + 1000, Math.ceil((resetAt - now) * cost / Math.max(1, remaining * config.budgetFraction)))
      : config.fallbackBackoffMs);
  }
  return Math.max(interval, retryAt - now);
}

export function startPolling(cache, { schedule = setTimeout, cancel = clearTimeout, onError = () => {} } = {}) {
  let timer, stopped = false;
  async function tick() {
    try { await cache.refresh(); } catch { onError(); }
    if (!stopped) {
      timer = schedule(tick, cache.view().pollMs);
      timer?.unref?.();
    }
  }
  void tick();
  return () => { stopped = true; if (timer !== undefined) cancel(timer); };
}
