import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { doctorCommand, initCommand, newCommand } from './bootstrap-commands.js';
import { agentOnboardingLines, renderForgeaxUsage, sdkUpdateLines } from './cli-output.js';
import type { CommandEnvelope, ForgeaXCommand } from './types.js';

const rawArgs = process.argv.slice(2);
const args = [...rawArgs];
const commandArg = args.shift();
const command = commandArg as ForgeaXCommand | undefined;
const help = rawArgs.includes('--help') || rawArgs.includes('-h');
const json = args.includes('--json');
const dryRun = args.includes('--dry-run');
const noInstall = args.includes('--no-install');
const templateIndex = args.indexOf('--template');
const template = templateIndex < 0 ? undefined : args[templateIndex + 1];
const positional = args.find(
  (value, index) => !value.startsWith('--') && (templateIndex < 0 || index !== templateIndex + 1),
);
const root =
  command === 'new' || command === 'init' || command === 'doctor'
    ? (positional ?? process.cwd())
    : process.cwd();

if (help) {
  process.stdout.write(renderForgeaxUsage());
} else if (command === 'new' || command === 'init' || command === 'doctor') {
  const result = await (command === 'new'
    ? newCommand({ root, dryRun, ...(template === undefined ? {} : { template }) })
    : command === 'init'
      ? initCommand({ root, dryRun, install: !noInstall })
      : doctorCommand({ root, json }));
  const envelope: CommandEnvelope = result.ok
    ? { schemaVersion: '1.0.0', command, ok: true, value: result.value }
    : { schemaVersion: '1.0.0', command, ok: false, error: result.error };
  if (json) process.stdout.write(`${JSON.stringify(envelope)}\n`);
  else if (result.ok) {
    process.stdout.write(`[forgeax] ${command} ready\n`);
    for (const line of agentOnboardingLines(result.value)) process.stdout.write(`${line}\n`);
    for (const line of sdkUpdateLines(result.value)) process.stdout.write(`${line}\n`);
  } else process.stderr.write(`[forgeax] ${result.error.code}: ${result.error.hint}\n`);
  if (!result.ok) process.exitCode = 1;
} else if (command !== undefined) {
  const localForgeax = resolve(
    root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'forgeax.cmd' : 'forgeax',
  );
  const child = spawn(localForgeax, [command, ...args], {
    cwd: root,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (exitCode !== 0) process.exitCode = exitCode ?? 1;
} else {
  process.stderr.write(renderForgeaxUsage());
  process.exitCode = 2;
}
