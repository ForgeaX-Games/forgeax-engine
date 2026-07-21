#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const activeCacheLimit = 7_918_954_215;
function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}
function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
function flattenPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('ci-cache-pages-missing');
  const expected = pages[0]?.total_count;
  const entries = pages.flatMap((page) => page.actions_caches ?? []);
  if (!Number.isInteger(expected) || entries.length !== expected)
    throw new Error('ci-cache-pages-incomplete');
  return entries;
}
function isLowValue(entry) {
  return /(?:^|-)tsup-dist-/.test(entry.key);
}
function repository() {
  const explicit = argument('--repository') ?? process.env.GITHUB_REPOSITORY;
  if (explicit) return explicit;
  return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    encoding: 'utf8',
  }).trim();
}
function ghPages(repositoryName) {
  const endpoint = `repos/${repositoryName}/actions/caches`;
  const text = execFileSync('gh', ['api', '--paginate', '--slurp', endpoint], { encoding: 'utf8' });
  try {
    return flattenPages(JSON.parse(text));
  } catch {
    throw new Error('ci-cache-pages-invalid');
  }
}

const input = readJson(argument('--input') ? resolve(argument('--input')) : null);
const repositoryName = input
  ? (argument('--repository') ?? process.env.GITHUB_REPOSITORY ?? null)
  : repository();
const entries = input ? flattenPages(input.cachePages) : ghPages(repositoryName);
const timings = input?.restoreSaveTimings ?? {};
const reports = entries.map((entry) => ({
  id: entry.id,
  key: entry.key,
  bytes: entry.size_in_bytes,
  lastAccessedAt: entry.last_accessed_at,
  restoreSeconds: timings[entry.key]?.restoreSeconds ?? null,
  saveSeconds: timings[entry.key]?.saveSeconds ?? null,
  lowValue: isLowValue(entry),
}));
const lowValueCaches = reports.filter((entry) => entry.lowValue);
const activeBytesBefore = reports.reduce((sum, entry) => sum + entry.bytes, 0);
const activeBytesAfter = reports
  .filter((entry) => !entry.lowValue)
  .reduce((sum, entry) => sum + entry.bytes, 0);
if (process.argv.includes('--confirm-delete') && !input) {
  for (const cache of lowValueCaches)
    execFileSync(
      'gh',
      ['api', '--method', 'DELETE', `repos/${repositoryName}/actions/caches/${cache.id}`],
      { stdio: 'inherit' },
    );
}
const report = {
  repository: repositoryName,
  activeBytesBefore,
  activeBytesAfter,
  activeCacheLimit,
  thresholdStatus: activeBytesAfter <= activeCacheLimit ? 'pass' : 'fail',
  entries: reports,
  lowValueCaches,
  deletionApplied: process.argv.includes('--confirm-delete') && !input,
  preservedFamilies: ['ddc'],
};
process.stdout.write(`${JSON.stringify(report)}\n`);
