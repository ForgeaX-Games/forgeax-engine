import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DdcEntryStore, ddcOutputDigest } from '../entry-store.js';
import { DdcLifecycle } from '../lifecycle.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

async function writeEntry(root: string, key: string): Promise<void> {
  const base = {
    key,
    guid: GUID,
    payload: { key },
    refs: [],
    artifacts: {},
    receipt: {
      guid: GUID,
      key,
      producer: 'test',
      inputFingerprint: key,
      outputDigest: '',
    },
  } as const;
  await new DdcEntryStore(root).write({
    ...base,
    receipt: { ...base.receipt, outputDigest: ddcOutputDigest(base) },
  });
}

describe('DDC lifecycle head', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('moves missing to cooking and current only after validated commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);

    await expect(lifecycle.inspect(GUID, KEY_A)).resolves.toMatchObject({ state: 'missing' });
    const lease = await lifecycle.begin(GUID, KEY_A);
    await expect(lifecycle.inspect(GUID, KEY_A)).resolves.toMatchObject({ state: 'cooking' });
    await writeEntry(root, KEY_A);
    await expect(lifecycle.commit(lease, KEY_A)).resolves.toEqual({
      result: 'current',
      key: KEY_A,
    });
    await expect(lifecycle.inspect(GUID, KEY_A)).resolves.toMatchObject({
      state: 'current',
      currentKey: KEY_A,
    });
  });

  it('retains last-known-good when recook fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const first = await lifecycle.begin(GUID, KEY_A);
    await writeEntry(root, KEY_A);
    await lifecycle.commit(first, KEY_A);
    const second = await lifecycle.begin(GUID, KEY_B);
    await lifecycle.fail(second, { code: 'producer-failed', detail: 'invalid source' });

    await expect(lifecycle.inspect(GUID, KEY_B)).resolves.toMatchObject({
      state: 'failed',
      lastKnownGoodKey: KEY_A,
      currentKey: KEY_A,
      failure: { code: 'producer-failed' },
    });
  });

  it('does not promote an old result after the desired key changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const first = await lifecycle.begin(GUID, KEY_A);
    await writeEntry(root, KEY_A);
    await lifecycle.commit(first, KEY_A);
    const second = await lifecycle.begin(GUID, KEY_B);

    await expect(lifecycle.inspect(GUID, KEY_B)).resolves.toMatchObject({
      state: 'cooking',
      lastKnownGoodKey: KEY_A,
    });
    await expect(lifecycle.commit(second, KEY_A)).resolves.toEqual({
      result: 'stale',
      key: KEY_A,
    });
    await expect(lifecycle.inspect(GUID, KEY_B)).resolves.toMatchObject({
      state: 'stale',
      lastKnownGoodKey: KEY_A,
      currentKey: KEY_A,
    });
  });

  it('keeps a first cook failure failed without inventing a current or LKG', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-lifecycle-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const lease = await lifecycle.begin(GUID, KEY_A);
    await lifecycle.fail(lease, { code: 'producer-failed', detail: 'missing input' });

    await expect(lifecycle.inspect(GUID, KEY_A)).resolves.toMatchObject({
      state: 'failed',
      currentKey: undefined,
      lastKnownGoodKey: undefined,
    });
  });
});
