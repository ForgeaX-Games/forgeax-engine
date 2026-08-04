import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const start = workflow.indexOf('  post-merge-gate:');
const end = workflow.indexOf('\n  build-artifacts:', start);
assert.ok(start >= 0, 'post-merge-gate job must remain declared');
assert.ok(end > start, 'post-merge-gate section must end before build-artifacts');
const gate = workflow.slice(start, end);

test('post-merge gate can read merged pull-request associations', () => {
  assert.match(gate, /permissions:[\s\S]*contents: read[\s\S]*pull-requests: read/);
  assert.match(gate, /commits\/\$\{GITHUB_SHA\}\/pulls/);
  assert.match(gate, /\.base\.ref == "main" and \.merged_at != null/);
});

test('post-merge gate preserves safe full-CI fallback when no PR is associated', () => {
  assert.match(gate, /if \[ -z "\$PR_NUMBER" \]; then/);
  assert.match(gate, /No associated merged PR found for commit — run full CI/);
  assert.match(gate, /echo "skip_checks=false" >> \$GITHUB_OUTPUT/);
});

test('post-merge gate retains title parsing before the squash fallback', () => {
  const titleParser = gate.indexOf('PR_NUMBER=$(git log -1 --format=%B');
  const associationLookup = gate.indexOf('commits/$' + '{GITHUB_SHA}/pulls');
  assert.ok(titleParser >= 0, 'ordinary merge titles should still be parsed');
  assert.ok(associationLookup > titleParser, 'association lookup must be a fallback');
});
