import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DdcEntry, DdcEntryStore, ddcOutputDigest } from '../entry-store.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const KEY = 'a'.repeat(64);

const entry = (): DdcEntry => {
  const value = {
    key: KEY,
    guid: GUID,
    payload: { kind: 'texture', width: 2, height: 1 },
    refs: ['019e3969-1d48-7c3b-ac24-6d68f457065e'],
    artifacts: {
      payload: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) },
    },
    receipt: {
      guid: GUID,
      key: KEY,
      producer: 'image-importer@4',
      inputFingerprint: 'input-a',
      outputDigest: '',
    },
  } satisfies DdcEntry;
  return { ...value, receipt: { ...value.receipt, outputDigest: ddcOutputDigest(value) } };
};

describe('immutable DDC entry store', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('keeps staged data invisible until an atomic publish', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    const staged = await store.stage(entry());

    expect(await store.read(KEY)).toBeNull();
    expect(await readdir(join(staged.path, 'artifacts'))).toEqual(['payload.bin']);
    expect(JSON.parse(await readFile(join(staged.path, 'refs.json'), 'utf8'))).toEqual([
      '019e3969-1d48-7c3b-ac24-6d68f457065e',
    ]);

    const published = await store.publish(staged);
    expect(published).toEqual({ result: 'published', key: KEY });
    await expect(store.read(KEY)).resolves.toEqual(entry());
  });

  it('does not expose a partial entry when a required artifact is missing', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    const staged = await store.stage(entry());
    await rm(join(staged.path, 'artifacts', 'payload.bin'));
    await expect(store.publish(staged)).rejects.toMatchObject({ code: 'ddc-entry-incomplete' });
    await expect(store.read(KEY)).resolves.toBeNull();
  });

  it('rejects a receipt or integrity mismatch on reread', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry());
    await writeFile(
      join(root, 'entries', KEY, 'receipt.json'),
      JSON.stringify({ ...entry().receipt, key: 'b'.repeat(64) }),
    );
    await expect(store.read(KEY)).resolves.toBeNull();
  });

  it('returns an existing immutable entry instead of replacing it', async () => {
    const root = join(tmpdir(), `forgeax-ddc-entry-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const store = new DdcEntryStore(root);
    await expect(store.write(entry())).resolves.toEqual({ result: 'published', key: KEY });
    await expect(store.write(entry())).resolves.toEqual({ result: 'existing', key: KEY });
  });
});
