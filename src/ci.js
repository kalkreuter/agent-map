// Keep the latest attempt for each check/app and status context. Historical
// failures must not override successful reruns of the same check.
export function summarizeCI(checkRuns, statuses) {
  const latest = new Map();
  for (const run of checkRuns) {
    const key = `check:${run.app?.id ?? ''}:${run.name}`;
    if (!latest.has(key) || run.id > latest.get(key).id) latest.set(key, run);
  }
  const contexts = new Map();
  for (const status of statuses) {
    if (!contexts.has(status.context) || status.id > contexts.get(status.context).id) contexts.set(status.context, status);
  }
  const runs = [...latest.values()];
  const signals = [
    ...runs.map(run => run.status !== 'completed' ? 'pending'
      : ['success', 'neutral', 'skipped'].includes(run.conclusion) ? 'success' : 'failure'),
    ...[...contexts.values()].map(status => ['failure', 'error'].includes(status.state) ? 'failure' : status.state),
  ];
  const state = signals.includes('failure') ? 'failure' : signals.includes('pending') ? 'pending'
    : signals.length && signals.every(signal => signal === 'success') ? 'success' : 'unknown';
  return { state, total: signals.length, passed: signals.filter(signal => signal === 'success').length,
    pending: signals.filter(signal => signal === 'pending').length,
    failed: signals.filter(signal => signal === 'failure').length, runs };
}

export function workflowChecks(workflowRuns) {
  const latest = new Map();
  for (const run of workflowRuns) {
    const key = run.workflow_id ?? run.path ?? run.name;
    const previous = latest.get(key);
    if (!previous || run.id > previous.id || (run.id === previous.id && (run.run_attempt ?? 1) > (previous.run_attempt ?? 1))) latest.set(key, run);
  }
  return [...latest].map(([key, run]) => ({ id: run.id, name: run.name ?? String(key),
    app: { id: key }, status: run.status, conclusion: run.conclusion }));
}
