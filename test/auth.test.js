import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIP, createLoginLimiter } from '../src/auth.js';
const config = { maxFailures: 3, windowMs: 60_000, lockoutMs: 1000, maxLockoutMs: 4000, maxEntries: 3 };
test('lockout starts at threshold and backoff grows after expiry', () => {
  let clock = 1000;
  const limiter = createLoginLimiter({ config, now: () => clock });
  assert.equal(limiter.fail('a'), 0); assert.equal(limiter.fail('a'), 0);
  assert.equal(limiter.fail('a'), 1); assert.equal(limiter.retryAfter('b'), 0);
  clock += 1000; assert.equal(limiter.retryAfter('a'), 0);
  assert.equal(limiter.fail('a'), 2);
  clock += 2000; assert.equal(limiter.fail('a'), 4);
  clock += 4000; assert.equal(limiter.fail('a'), 4);
});
test('successful login reset clears the failure counter', () => {
  const limiter = createLoginLimiter({ config, now: () => 1000 });
  limiter.fail('a'); limiter.fail('a'); limiter.reset('a');
  assert.equal(limiter.size(), 0);
  assert.equal(limiter.fail('a'), 0); assert.equal(limiter.fail('a'), 0);
});
test('expired attempt windows are removed and tracker memory is bounded', () => {
  let clock = 1000;
  const limiter = createLoginLimiter({ config, now: () => clock });
  for (let i = 0; i < 100; i++) limiter.fail(String(i));
  assert.equal(limiter.size(), 3);
  clock += config.windowMs;
  assert.equal(limiter.retryAfter('99'), 0); assert.equal(limiter.size(), 2);
  assert.equal(limiter.fail('99'), 0);
});
test('forwarded IP is ignored unless proxy hops are explicitly trusted', () => {
  const request = { socket: { remoteAddress: '::ffff:10.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.8' } };
  assert.equal(clientIP(request), '10.0.0.1');
  assert.equal(clientIP(request, 1), '203.0.113.8');
  assert.equal(clientIP(request, 2), '198.51.100.99');
  request.headers['x-forwarded-for'] = 'spoofed';
  assert.equal(clientIP(request, 1), '10.0.0.1');
});
