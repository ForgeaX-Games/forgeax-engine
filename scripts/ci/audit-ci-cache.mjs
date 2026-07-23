#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGhPages } from './parse-gh-pages.mjs';

const activeCacheLimit = 7_918_954_215;
const maxCacheApiAttempts = 3;
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
  try {
    return ghPagesViaCli(repositoryName);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return ghPagesViaFetch(repositoryName);
  }
}

function ghPagesViaCli(repositoryName) {
  const endpoint = `repos/${repositoryName}/actions/caches`;
  for (let attempt = 1; attempt <= maxCacheApiAttempts; attempt += 1) {
    try {
      const text = execFileSync('gh', ['api', '--paginate', endpoint], { encoding: 'utf8' });
      return flattenPages(parseGhPages(text));
    } catch (error) {
      const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n');
      const transient = /HTTP (?:502|503|504)|ECONNRESET|timed out/i.test(detail);
      if (!transient || attempt === maxCacheApiAttempts) throw error;
      execFileSync('sleep', [String(attempt)]);
    }
  }
  throw new Error('ci-cache-pages-unreachable');
}

async function ghPagesViaFetch(repositoryName) {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error('ci-cache-gh-missing-token');
  const apiBase = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const pages = [];
  for (let page = 1; ; page += 1) {
    let response;
    for (let attempt = 1; attempt <= maxCacheApiAttempts; attempt += 1) {
      response = await fetch(
        `${apiBase}/repos/${repositoryName}/actions/caches?per_page=100&page=${page}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );
      if (response.ok) break;
      const transient = [502, 503, 504].includes(response.status);
      if (!transient || attempt === maxCacheApiAttempts) {
        throw new Error(`GitHub cache API HTTP ${response.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
    pages.push(await response.json());
    const entries = pages.flatMap((item) => item.actions_caches ?? []);
    const expected = pages[0]?.total_count;
    if (
      !Number.isInteger(expected) ||
      entries.length >= expected ||
      pages.at(-1)?.actions_caches?.length === 0
    ) {
      return flattenPages(pages);
    }
  }
}

const input = readJson(argument('--input') ? resolve(argument('--input')) : null);
const repositoryName = input
  ? (argument('--repository') ?? process.env.GITHUB_REPOSITORY ?? null)
  : repository();
const entries = input ? flattenPages(input.cachePages) : await ghPages(repositoryName);
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
