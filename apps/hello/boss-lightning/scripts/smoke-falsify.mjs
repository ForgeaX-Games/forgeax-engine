import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smoke = resolve(appRoot, 'scripts/smoke-browser.mjs');

function run(mode) {
  return spawnSync('node', [smoke], {
    env: { ...process.env, BOSS_LIGHTNING_FALSIFY: mode },
    encoding: 'utf8',
  });
}

const cases = ['disable-billboard', 'disable-vfx', 'emitter-zero', 'material-empty'];
const failures = [];
for (const mode of cases) {
  const result = run(mode);
  if (result.status === 0) failures.push(`${mode} unexpectedly passed`);
  else console.log(`[smoke-falsify] ${mode} correctly failed (${result.status})`);
}
if (failures.length > 0) {
  console.error(`[smoke-falsify] FAIL ${failures.join('; ')}`);
  process.exit(1);
}
console.log('[smoke-falsify] PASS both particle falsifiers retained non-zero semantics');
