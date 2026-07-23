#!/usr/bin/env node
// Compare the repository required-check manifest with GitHub's active Protect ruleset.
// The ruleset remains external enforcement; this command makes drift fail loudly instead
// of leaving two silently diverging lists.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('./required-ci-checks.json', import.meta.url), 'utf8'),
);

export function compareRequiredChecks(localNames, remoteNames) {
  const local = [...new Set(localNames)].sort();
  const remote = [...new Set(remoteNames)].sort();
  return {
    ok: local.length === remote.length && local.every((name, index) => name === remote[index]),
    local,
    remote,
    missingRemotely: local.filter((name) => !remote.includes(name)),
    extraRemotely: remote.filter((name) => !local.includes(name)),
  };
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8' }));
}

function repositoryName() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    encoding: 'utf8',
  }).trim();
}

export function main() {
  const repo = repositoryName();
  const rulesets = ghJson([`repos/${repo}/rulesets`]);
  const protect = rulesets.find(
    (ruleset) => ruleset.name === 'Protect' && ruleset.enforcement === 'active',
  );
  if (!protect) throw new Error(`active Protect ruleset not found for ${repo}`);
  const detail = ghJson([`repos/${repo}/rulesets/${protect.id}`]);
  const rule = detail.rules?.find((candidate) => candidate.type === 'required_status_checks');
  const remote = rule?.parameters?.required_status_checks?.map(({ context }) => context) ?? [];
  const result = compareRequiredChecks(manifest, remote);
  console.log(JSON.stringify({ repo, ruleset: protect.id, ...result }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
