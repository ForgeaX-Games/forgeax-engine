import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { doctorCommand, initCommand, newCommand } from './bootstrap-commands.js';
import type { CommandEnvelope, ForgeaXCommand } from './types.js';

const args = process.argv.slice(2);
const command = args.shift() as ForgeaXCommand | undefined;
const json = args.includes('--json');
const dryRun = args.includes('--dry-run');
const noInstall = args.includes('--no-install');
const positional = args.find((value) => !value.startsWith('--'));
const root = positional ?? process.cwd();

if (command === 'new' || command === 'init' || command === 'doctor') {
  const result = await (command === 'new'
    ? newCommand({ root, dryRun })
    : command === 'init'
      ? initCommand({ root, dryRun, install: !noInstall })
      : doctorCommand({ root, json }));
  const envelope: CommandEnvelope = result.ok
    ? { schemaVersion: '1.0.0', command, ok: true, value: result.value }
    : { schemaVersion: '1.0.0', command, ok: false, error: result.error };
  if (json) process.stdout.write(`${JSON.stringify(envelope)}\n`);
  else if (result.ok) process.stdout.write(`[forgeax] ${command} ready\n`);
  else process.stderr.write(`[forgeax] ${result.error.code}: ${result.error.hint}\n`);
  if (!result.ok) process.exitCode = 1;
} else if (command !== undefined) {
  const cli = resolve(root, 'node_modules', '@forgeax', 'engine-devkit', 'dist', 'cli.mjs');
  await import(pathToFileURL(cli).href);
} else {
  process.stderr.write('Usage: forgeax <new|init|doctor|test|dev|build|preview> [directory]\n');
  process.exitCode = 2;
}
