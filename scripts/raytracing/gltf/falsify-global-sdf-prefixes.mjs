import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [input, frozen, section, outputArg, selected, factor = '1'] = process.argv.slice(2);
assert(input && frozen && /^[a-z0-9-]+$/.test(section) && outputArg && selected);
const output = resolve(outputArg);
await mkdir(output);
const manifest = JSON.parse(await readFile(resolve(input, 'composition.json'), 'utf8'));
const row = manifest.cases.find((r) => r.name === section);
const cohort = JSON.parse(await readFile(resolve(input, row.queryFile), 'utf8'));
const observed = selected.split(',').map(Number);
const unobserved = cohort.rays.findIndex((_, i) => !observed.includes(i));
assert(unobserved >= 0, 'requires a non-selected ray to test whole-cohort admission');
const results = [];
for (const [name, file, offset, expected] of [
  ['composition', `${section}.bin`, 0, 'original composition differs'],
  [
    'unselected-ray',
    `${section}-query.bin`,
    unobserved * 64 + 8,
    'original full-cohort query differs',
  ],
]) {
  const changed = resolve(output, `${name}-frozen`),
    capture = resolve(output, name);
  await mkdir(changed);
  for (const f of [`${section}.bin`, `${section}-query.bin`])
    await copyFile(resolve(frozen, f), resolve(changed, f));
  const bytes = await readFile(resolve(changed, file));
  bytes[offset] ^= 1;
  await writeFile(resolve(changed, file), bytes);
  const run = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./trace-global-sdf-prefixes.mjs', import.meta.url)),
      input,
      changed,
      section,
      capture,
      selected,
      factor,
    ],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
  );
  await writeFile(resolve(output, `${name}.log`), `${run.stdout ?? ''}\n${run.stderr ?? ''}`);
  assert(!run.error && run.status !== 0, `${name} did not fail normally`);
  const failure = JSON.parse(await readFile(resolve(capture, 'failure.json'), 'utf8'));
  assert(failure.message.includes(expected), `${name}: ${failure.message}`);
  results.push({
    name,
    expected,
    rejected: true,
    ...(name === 'unselected-ray' ? { unobserved } : {}),
  });
}
await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
