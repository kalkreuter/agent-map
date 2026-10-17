import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const directory of ['src', 'public', 'scripts']) {
  for (const file of await readdir(new URL(`../${directory}/`, import.meta.url))) {
    if (!file.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
    if (result.status) process.exit(result.status);
  }
}
