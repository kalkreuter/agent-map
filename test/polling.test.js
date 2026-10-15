import test from 'node:test';
import assert from 'node:assert/strict';
import { pollInterval, startPolling } from '../src/polling.js';
import { rules } from '../config/rules.js';
test('small workloads retain a 60-second minimum', () => assert.equal(pollInterval({ repoCount: 2, prCount: 1 }), 60_000));
test('large workloads stay within half the configured hourly budget', () => {
  const cost = 10 * 2 + 100 * 7;
  const interval = pollInterval({ repoCount: 10, prCount: 100 });
  assert.ok(interval > 60_000);
  assert.ok(cost * 3_600_000 / interval <= 2500);
  assert.ok(pollInterval({ repoCount: 10, prCount: 100, requests: 1500 }) > interval);
});
test('low remaining quota and exhausted quota defer requests toward reset', () => {
  const now = 1000, resetAt = now + 3600_000;
  assert.ok(pollInterval({ repoCount: 2, prCount: 10, remaining: 100, resetAt, now }) > 60_000);
  assert.equal(pollInterval({ remaining: 0, resetAt, now }), 3601_000);
  assert.equal(pollInterval({ remaining: 0, resetAt: now - 1, now }), 60_000);
  assert.equal(pollInterval({ remaining: 0 }), rules.polling.fallbackBackoffMs);
  assert.equal(pollInterval({ retryAt: now + 120_000, now }), 120_000);
  assert.equal(pollInterval({ prCount: 10, remaining: 80, resetAt, now }), resetAt - now + 1000);
});
test('scheduler waits for each refresh, uses its interval, and cancels on shutdown', async () => {
  let finish, scheduled, cancelled;
  const cache = { refresh: () => new Promise(resolve => { finish = resolve; }), view: () => ({ pollMs: 240_000 }) };
  const stop = startPolling(cache, { schedule: (callback, delay) => { scheduled = { callback, delay }; return 7; }, cancel: timer => { cancelled = timer; } });
  assert.equal(scheduled, undefined);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduled.delay, 240_000); stop(); assert.equal(cancelled, 7);
});
test('stopping during an in-flight poll prevents rescheduling', async () => {
  let finish, scheduled = false;
  const stop = startPolling({ refresh: () => new Promise(resolve => { finish = resolve; }), view: () => ({ pollMs: 60_000 }) },
    { schedule: () => { scheduled = true; } });
  stop(); finish(); await new Promise(resolve => setImmediate(resolve)); assert.equal(scheduled, false);
});
