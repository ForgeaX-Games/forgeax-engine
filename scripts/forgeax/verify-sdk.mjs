import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import { artifact, filesUnder, SDK_CAPABILITIES, sha256 } from './sdk-lib.mjs';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const index = args.indexOf('--archive');
if (index < 0 || args[index + 1] === undefined)
  throw new Error('Usage: pnpm sdk:verify --archive <path>');
const archive = resolve(args[index + 1]);
const unpackRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-verify-'));
await execFileAsync('unzip', ['-q', archive, '-d', unpackRoot]);
const sdkRoot = resolve(unpackRoot, 'forgeax-sdk');
const manifest = JSON.parse(await readFile(resolve(sdkRoot, 'sdk-manifest.json'), 'utf8'));
const schema = JSON.parse(
  await readFile(resolve(sdkRoot, 'schemas', 'sdk-manifest.schema.json'), 'utf8'),
);
const validate = new Ajv2020({ allErrors: true }).compile(schema);
if (!validate(manifest)) throw new Error(`sdk-manifest-schema: ${JSON.stringify(validate.errors)}`);
if (JSON.stringify(manifest.capabilities) !== JSON.stringify(SDK_CAPABILITIES))
  throw new Error('sdk-capability-closure');
for (const expected of manifest.artifacts) {
  const actual = await artifact(sdkRoot, resolve(sdkRoot, expected.path));
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
    throw new Error(`sdk-artifact-mismatch: ${expected.path}`);
}
const files = await filesUnder(sdkRoot);
if (files.length !== manifest.artifacts.length + 1) throw new Error('sdk-unmanifested-artifact');
for (const entry of manifest.packages) {
  const declared = manifest.artifacts.find((item) => item.path === entry.path);
  if (declared === undefined || declared.sha256 !== entry.sha256)
    throw new Error(`sdk-package-closure: ${entry.name}`);
}
const checkPath = resolve(dirname(archive), 'SHA256SUMS');
const checksums = await readFile(checkPath, 'utf8');
const digest = sha256(await readFile(archive));
if (!checksums.includes(`${digest}  ${basename(archive)}`)) throw new Error('sdk-archive-checksum');
const project = resolve(unpackRoot, 'game');
const toolBin = resolve(unpackRoot, 'tool-bin');
await mkdir(toolBin);
const pnpmShim = resolve(toolBin, 'pnpm');
await writeFile(pnpmShim, '#!/bin/sh\nexec corepack pnpm@10.33.2 "$@"\n');
await chmod(pnpmShim, 0o755);
const offlineEnv = {
  ...process.env,
  PATH: `${toolBin}:${process.env.PATH ?? ''}`,
  FORGEAX_SDK_ROOT: sdkRoot,
  npm_config_offline: 'true',
  CI: 'true',
};
await execFileAsync('node', [resolve(sdkRoot, 'bin', 'forgeax.mjs'), 'new', project, '--json'], {
  env: offlineEnv,
  maxBuffer: 64 * 1024 * 1024,
});
for (const script of ['doctor', 'test', 'build']) {
  await execFileAsync('pnpm', ['run', script, '--', '--json'], {
    cwd: project,
    env: offlineEnv,
    maxBuffer: 128 * 1024 * 1024,
  });
}

async function verifyPreview() {
  const child = spawn('pnpm', ['run', 'preview', '--', '--json'], {
    cwd: project,
    env: offlineEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    const deadline = Date.now() + 30_000;
    let envelope;
    while (Date.now() < deadline) {
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const candidate = JSON.parse(line);
          if (candidate.command === 'preview') envelope = candidate;
        } catch {}
      }
      if (envelope !== undefined) break;
      if (child.exitCode !== null) throw new Error(`sdk-preview-exited: ${stderr}`);
      await new Promise((accept) => setTimeout(accept, 100));
    }
    if (envelope?.ok !== true) throw new Error(`sdk-preview-not-ready: ${stdout}\n${stderr}`);
    const url = envelope.value?.urls?.local?.[0] ?? envelope.value?.urls?.network?.[0];
    if (typeof url !== 'string') throw new Error('sdk-preview-url-missing');
    const response = await fetch(url);
    const html = await response.text();
    if (!response.ok || !html.includes('<canvas id="app"'))
      throw new Error('sdk-preview-static-closure');
    return url;
  } finally {
    child.kill('SIGTERM');
  }
}

const previewUrl = await verifyPreview();
const result = {
  ok: true,
  archive,
  sha256: digest,
  sdkVersion: manifest.sdkVersion,
  engineCommit: manifest.engineCommit,
  capabilities: manifest.capabilities,
  offlineProject: project,
  commands: ['new', 'doctor', 'test', 'build', 'preview'],
  previewUrl,
};
await writeFile(
  resolve(dirname(archive), 'sdk-verify-result.json'),
  `${JSON.stringify(result, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(result)}\n`);
