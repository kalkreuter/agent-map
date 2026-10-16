import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCI, workflowChecks } from '../src/ci.js';
const check = (id, conclusion, status = 'completed') => ({ id, name: 'test', app: { id: 1 }, conclusion, status });
test('no CI is unknown', () => assert.equal(summarizeCI([], []).state, 'unknown'));
test('latest reruns and status contexts replace historical failures', () => {
  const result = summarizeCI([check(1, 'failure'), check(2, 'success')], [
    { id: 1, context: 'build', state: 'failure' }, { id: 2, context: 'build', state: 'success' },
  ]);
  assert.equal(result.state, 'success'); assert.equal(result.total, 2);
});
test('failed, pending, and cancelled checks', () => {
  assert.equal(summarizeCI([check(1, null, 'queued')], []).state, 'pending');
  assert.equal(summarizeCI([check(1, 'cancelled')], []).state, 'failure');
  assert.equal(summarizeCI([check(1, 'failure')], [{ id: 2, context: 'build', state: 'pending' }]).state, 'failure');
});
test('Actions picks latest run/attempt per workflow, preserving workflows with identical names', () => {
  const runs = [
    { id: 1, workflow_id: 10, name: 'Test', run_attempt: 1, status: 'completed', conclusion: 'failure' },
    { id: 1, workflow_id: 10, name: 'Test', run_attempt: 2, status: 'completed', conclusion: 'success' },
    { id: 2, workflow_id: 11, name: 'Test', status: 'queued' },
  ];
  const checks = workflowChecks(runs); assert.equal(checks.length, 2);
  const result = summarizeCI(checks, []); assert.equal(result.state, 'pending'); assert.equal(result.failed, 0);
});
