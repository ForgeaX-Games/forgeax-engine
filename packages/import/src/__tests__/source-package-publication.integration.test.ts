import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitImportPublication,
  discardImportPublication,
  type ImportPublicationInput,
  stageImportPublication,
} from '../source-package-publication.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const KEY = 'a'.repeat(64);

function input(root: string, desiredKey = KEY): ImportPublicationInput {
  return {
    root,
    guid: GUID,
    desiredKey,
    pack: {
      schemaVersion: '2.0.0',
      assets: [{ guid: GUID, kind: 'fixture', payload: { value: 'same' }, refs: [] }],
    },
    previousCatalog: [],
    nextCatalog: [],
    publishedGuids: [GUID],
  };
}

describe('source package publication concurrency', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('waits for an equivalent newer owner after a strict stale commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const publicationInput = input(root);
    const first = await stageImportPublication(publicationInput);
    const second = await stageImportPublication(publicationInput);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const winner = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return commitImportPublication(second.candidate);
    })();
    const loser = await commitImportPublication(first.candidate);
    const winnerResult = await winner;

    expect(loser).toMatchObject({ ok: true, head: { state: 'current', currentKey: KEY } });
    expect(winnerResult).toMatchObject({ ok: true, head: { state: 'current', currentKey: KEY } });
  });

  it('keeps a stale publication with a different desired key fail-closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const first = await stageImportPublication(input(root, 'a'.repeat(64)));
    const second = await stageImportPublication(input(root, 'b'.repeat(64)));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const result = await commitImportPublication(first.candidate);
    await discardImportPublication(second.candidate);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'source-package-ddc-failed', detail: 'DDC lifecycle commit returned stale' },
    });
  });
});
