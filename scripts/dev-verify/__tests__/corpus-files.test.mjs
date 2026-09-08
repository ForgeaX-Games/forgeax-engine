import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  findShardArtifactDirectories,
  mergeDirectoryContents,
} from '../membership-timing/corpus-files.mjs';

test('accepts one current or retry artifact for every deferred membership shard', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-corpus-files-'));
  try {
    for (const name of [
      'deferred-membership-real-corpus-shard-0-a2',
      'deferred-membership-real-corpus-shard-1-a2',
      'deferred-membership-real-corpus-shard-2-a2-retry-1-a2',
      'deferred-membership-real-corpus-shard-3-a2',
    ])
      mkdirSync(join(root, name));
    assert.deepEqual(
      findShardArtifactDirectories(root, 4).map((directory) => directory.split('/').at(-1)),
      [
        'deferred-membership-real-corpus-shard-0-a2',
        'deferred-membership-real-corpus-shard-1-a2',
        'deferred-membership-real-corpus-shard-2-a2-retry-1-a2',
        'deferred-membership-real-corpus-shard-3-a2',
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('merges shard contents while rejecting duplicate evidence paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-corpus-merge-'));
  try {
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    mkdirSync(source);
    mkdirSync(destination);
    writeFileSync(join(source, 'record.json'), '{}\n');
    mergeDirectoryContents(source, destination);
    assert.equal(readFile(destination, 'record.json'), '{}\n');
    assert.throws(() => mergeDirectoryContents(source, destination), /collision/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readFile(directory, name) {
  return readFileSync(join(directory, name), 'utf8');
}
