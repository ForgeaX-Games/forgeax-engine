import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DdcEntry, DdcEntryStore, ddcOutputDigest } from '../entry-store.js';
import { DdcLifecycle } from '../lifecycle.js';
import { DdcGenerationSession } from '../session.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const KEY = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);

function entry(key = KEY): DdcEntry {
  const value = {
    key,
    guid: GUID,
    payload: { kind: 'fixture', key },
    refs: [],
    artifacts: {},
    receipt: {
      guid: GUID,
      key,
      producer: 'fixture',
      inputFingerprint: 'sha256:source',
      outputDigest: '',
    },
  } satisfies DdcEntry;
  return { ...value, receipt: { ...value.receipt, outputDigest: ddcOutputDigest(value) } };
}

describe('DDC generation session integration', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('accepts one validated candidate and keeps a later generation isolated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-session-'));
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry());

    const first = new DdcGenerationSession(root, { generation: 1 });
    const candidate = await first.beginCandidate(GUID, KEY);
    await expect(first.commitCandidate(candidate, KEY)).resolves.toMatchObject({
      result: 'current',
    });
    await expect(first.inspect(GUID, KEY)).resolves.toMatchObject({
      state: 'current',
      currentKey: KEY,
    });
    await first.close();

    const second = new DdcGenerationSession(root, { generation: 2 });
    expect(second.metrics().hitCount).toBe(0);
    await expect(second.inspect(GUID, KEY)).resolves.toMatchObject({ state: 'current' });
    expect(second.metrics().hitCount).toBe(1);
    await second.close();
  });

  it('heartbeats staged candidates during a long generation before commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-session-'));
    roots.push(root);
    const session = new DdcGenerationSession(root, { generation: 1, leaseTtlMs: 100 });
    try {
      const candidate = await session.stageEntry(entry());
      await new Promise((resolve) => setTimeout(resolve, 250));
      await expect(session.commitEntry(candidate, KEY)).resolves.toMatchObject({
        result: 'current',
      });
    } finally {
      await session.close();
    }
  });

  it('does not let a stale rollback restore over a newer active lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-session-'));
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry());

    const first = new DdcGenerationSession(root, { generation: 1 });
    const firstCandidate = await first.stageEntry(entry());
    const second = new DdcGenerationSession(root, { generation: 2 });
    const secondCandidate = await second.stageEntry(entry());

    await expect(first.commitEntry(firstCandidate, KEY)).resolves.toMatchObject({
      result: 'stale',
    });
    await expect(first.restoreEntry(firstCandidate)).resolves.toMatchObject({
      result: 'not-owner',
    });

    await expect(second.commitEntry(secondCandidate, KEY)).resolves.toMatchObject({
      result: 'current',
    });
    await expect(first.restoreEntry(firstCandidate)).resolves.toMatchObject({
      result: 'not-owner',
    });
    await expect(second.inspect(GUID, KEY)).resolves.toMatchObject({
      state: 'current',
      currentKey: KEY,
    });
    await first.close();
    await second.close();
  });

  it('restores an own active candidate without regressing revision or generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-session-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const { lease, previousHead } = await lifecycle.beginWithSnapshot(GUID, KEY);

    expect('activeLease' in previousHead).toBe(false);
    await expect(lifecycle.restoreIfCurrent(previousHead, lease)).resolves.toMatchObject({
      result: 'restored',
      revision: 1,
      generation: lease.generation,
    });
    await expect(lifecycle.inspect(GUID, KEY)).resolves.toMatchObject({
      state: 'missing',
      revision: 1,
    });

    const next = await lifecycle.begin(GUID, KEY);
    expect(next.expectedRevision).toBe(1);
    expect(next.generation).toBeGreaterThan(lease.generation);
    await lifecycle.close(next);
  });

  it('restores an own terminal mutation while preserving the accepted head', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-session-'));
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry(KEY));
    const lifecycle = new DdcLifecycle(root);
    const accepted = await lifecycle.begin(GUID, KEY);
    await expect(lifecycle.commit(accepted, KEY)).resolves.toMatchObject({ result: 'current' });

    const { lease, previousHead } = await lifecycle.beginWithSnapshot(GUID, KEY_B);
    await store.write(entry(KEY_B));
    const committed = await lifecycle.commit(lease, KEY_B);
    expect(committed.restoreFence).toMatchObject({ outcome: 'current' });
    await expect(
      lifecycle.restoreIfCurrent(previousHead, lease, committed.restoreFence),
    ).resolves.toMatchObject({ result: 'restored' });
    await expect(lifecycle.inspect(GUID, KEY_B)).resolves.toMatchObject({
      state: 'stale',
      currentKey: KEY,
      revision: (committed.revision ?? 0) + 1,
      generation: lease.generation,
    });
  });

  it('rolls back a newer cooking candidate without reviving its superseded writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-session-'));
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry(KEY));
    const lifecycle = new DdcLifecycle(root);
    const accepted = await lifecycle.begin(GUID, KEY);
    await lifecycle.commit(accepted, KEY);

    const first = new DdcGenerationSession(root, { generation: 1 });
    const firstCandidate = await first.stageEntry(entry(KEY_B));
    const second = new DdcGenerationSession(root, { generation: 2 });
    const secondCandidate = await second.stageEntry(entry(KEY_C));

    await expect(second.restoreEntry(secondCandidate)).resolves.toMatchObject({
      result: 'restored',
    });
    await expect(first.restoreEntry(firstCandidate)).resolves.toMatchObject({
      result: 'not-owner',
    });
    await expect(second.inspect(GUID, KEY_C)).resolves.toMatchObject({
      state: 'stale',
      currentKey: KEY,
    });
    await first.close();
    await second.close();
  });

  it('fences a failed terminal mutation before restoring accepted content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-session-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const { lease, previousHead } = await lifecycle.beginWithSnapshot(GUID, KEY);
    const failed = await lifecycle.fail(lease, { code: 'producer-failed', detail: 'fixture' });

    expect(failed).toMatchObject({ outcome: 'failed', revision: 1 });
    await expect(lifecycle.restoreIfCurrent(previousHead, lease, failed)).resolves.toMatchObject({
      result: 'restored',
      revision: 2,
    });
    await expect(lifecycle.inspect(GUID, KEY)).resolves.toMatchObject({
      state: 'missing',
      revision: 2,
    });
  });
});
