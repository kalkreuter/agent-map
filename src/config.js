const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function validateRepos(repos) {
  if (!Array.isArray(repos) || !repos.length || repos.some(repo => !repo
    || !/^[\w.-]+\/[\w.-]+$/.test(repo.repo) || typeof repo.name !== 'string'
    || !/^#[\da-f]{6}$/i.test(repo.color))) {
    throw new Error('config/repos.json must contain repo, name, and a six-digit hex color for each project.');
  }
  const targets = new Set();
  for (const repo of repos) {
    if (repo.railway === undefined) continue;
    if (!Array.isArray(repo.railway)) throw new Error('Each railway setting must be an array of deployment targets.');
    for (const target of repo.railway) {
      if (!target || !['projectId', 'environmentId', 'serviceId'].every(key => uuid.test(target[key] ?? ''))
        || !['name', 'environmentName', 'branch'].every(key => target[key] === undefined
          || typeof target[key] === 'string' && target[key].trim().length > 0
          && target[key].length <= 255 && !/[\u0000-\u001f\u007f]/.test(target[key]))) {
        throw new Error('Railway targets need valid projectId, environmentId, serviceId, and optional nonempty labels/branch.');
      }
      const id = `${target.projectId}:${target.environmentId}:${target.serviceId}`.toLowerCase();
      if (targets.has(id)) throw new Error('Each Railway service/environment may appear only once in config/repos.json.');
      targets.add(id);
    }
  }
  return repos;
}
