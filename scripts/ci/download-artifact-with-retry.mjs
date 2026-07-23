#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const RETRY_DELAYS_SECONDS = [0, 5, 15];

function errorText(error) {
  const messages = [];
  for (let current = error; current; current = current.cause) {
    if (typeof current.message === 'string') messages.push(current.message);
    if (typeof current.code === 'string') messages.push(current.code);
  }
  return messages.join(' ');
}

export function isRetryableTransportError(error) {
  const text = errorText(error);
  return (
    /ECONNRESET|Failed to GetSignedArtifactURL|socket hang up|HTTP (?:408|429|5\d\d) /i.test(
      text,
    ) ||
    (error instanceof TypeError && /fetch failed/i.test(text))
  );
}

export function parseArtifactIds(value) {
  const ids = String(value ?? '')
    .split(',')
    .map((id) => id.trim());
  if (ids.length === 0 || ids.some((id) => !/^[1-9]\d*$/.test(id)))
    throw new Error('artifact IDs must be a non-empty comma-separated list of positive integers');
  return ids;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function sleep(seconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, seconds * 1000));
}

export async function retryArtifact(operation, { sleepFn = sleep, onRetry = () => {} } = {}) {
  for (const [attemptIndex, delay] of RETRY_DELAYS_SECONDS.entries()) {
    if (delay > 0) await sleepFn(delay);
    try {
      return { attempt: attemptIndex + 1, value: await operation() };
    } catch (error) {
      if (!isRetryableTransportError(error) || attemptIndex === RETRY_DELAYS_SECONDS.length - 1)
        throw error;
      await onRetry({ attempt: attemptIndex + 1, error });
    }
  }
  throw new Error('artifact retry exhausted');
}

function headers() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function responseFor(url) {
  const response = await fetch(url, { headers: headers() });
  if (!response.ok) throw new Error(`HTTP ${response.status} while reading artifact service`);
  return response;
}

async function metadataFor(repository, artifactId) {
  const response = await responseFor(
    `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}`,
  );
  const metadata = await response.json();
  if (metadata.expired) throw new Error(`artifact ${artifactId} has expired`);
  if (typeof metadata.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(metadata.digest))
    throw new Error(`artifact ${artifactId} has invalid digest metadata`);
  return metadata;
}

async function downloadArtifact(repository, artifactId, destination) {
  const metadata = await metadataFor(repository, artifactId);
  const response = await responseFor(
    `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`,
  );
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  if (digest !== metadata.digest) throw new Error(`artifact ${artifactId} digest mismatch`);
  await writeFile(destination, archive);
  return archive.byteLength;
}

export async function ensureArtifactDestination(path) {
  await mkdir(path, { recursive: true });
}

async function hydrateArtifact(repository, artifactId, path) {
  const root = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'forgeax-artifact-'));
  const archive = join(root, `${artifactId}.zip`);
  try {
    await ensureArtifactDestination(path);
    const hydrated = await retryArtifact(
      async () => {
        const bytes = await downloadArtifact(repository, artifactId, archive);
        execFileSync('unzip', ['-q', '-o', archive, '-d', path], { stdio: 'inherit' });
        return bytes;
      },
      {
        onRetry: async ({ attempt, error }) => {
          await rm(archive, { force: true });
          process.stdout.write(
            `artifact ${artifactId} transport retry ${attempt}/${RETRY_DELAYS_SECONDS.length}: ${errorText(error)}\n`,
          );
        },
      },
    );
    process.stdout.write(
      `artifact ${artifactId} hydrated on attempt ${hydrated.attempt} (${hydrated.value} bytes)\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const ids = parseArtifactIds(argument('--artifact-ids'));
  const path = resolve(argument('--path') ?? '.');
  const staggerSeconds = Number(argument('--stagger-seconds') ?? '0');
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  if (!Number.isInteger(staggerSeconds) || staggerSeconds < 0)
    throw new Error('stagger seconds must be a non-negative integer');
  if (staggerSeconds > 0) {
    process.stdout.write(`staggering core artifact transfer for ${staggerSeconds} seconds\n`);
    await sleep(staggerSeconds);
  }
  for (const artifactId of ids) await hydrateArtifact(repository, artifactId, path);
}

if (import.meta.main) {
  main().catch((error) => {
    fail(errorText(error));
  });
}
