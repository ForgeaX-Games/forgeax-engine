import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProductionRouteBridge } from '../dev/production-bridge.js';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(status = 'accepted') {
  const folder = mkdtempSync(join(tmpdir(), 'source-import-'));
  directories.push(folder);
  const root = join(folder, 'assets');
  mkdirSync(root);
  const source = join(root, 'example.pack.ts');
  writeFileSync(source, 'export default {};');
  const changes: unknown[] = [];
  const entry = {
    guid: '1073cc16-2533-53dc-a63f-cbd45527b75d',
    kind: 'scene',
    sourcePath: relative(process.cwd(), source).replace(/\\/g, '/'),
  };
  const bridge = createProductionRouteBridge({
    roots: [root],
    callbacks: {},
    producerReadiness: 'eager',
    state: { catalogProjection: { entries: [entry] } },
    activeDevSession: {
      track: (task: Promise<unknown>) => task,
      rebuildProduction: async (input: unknown) => {
        changes.push(input);
        return { status, error: new Error('collision') };
      },
    },
  } as unknown as Parameters<typeof createProductionRouteBridge>[0]);
  const rebuildSource = bridge.rebuildSource;
  expect(rebuildSource).toBeTypeOf('function');
  if (!rebuildSource) throw new Error('source import bridge must expose rebuildSource');
  return { rebuildSource, source, root, folder, entry, changes };
}
describe('source import authority', () => {
  it('rescans the full declared root and returns Engine identities', async () => {
    const f = fixture();
    expect(await f.rebuildSource(f.source)).toEqual([f.entry]);
    expect(f.changes).toEqual([[{ sourceKey: f.root }]]);
  });
  it.each([
    'stale',
    'failed',
  ])('never reports old Catalog rows after %s discovery', async (status) => {
    const f = fixture(status);
    await expect(f.rebuildSource(f.source)).rejects.toThrow();
  });
  it('rejects outside-root and symlink escapes before rebuilding', async () => {
    const f = fixture();
    const outside = join(f.folder, 'outside.pack.ts');
    writeFileSync(outside, 'export default {};');
    const link = join(f.root, 'escape.pack.ts');
    symlinkSync(outside, link);
    await expect(f.rebuildSource(outside)).rejects.toThrow('outside-roots');
    await expect(f.rebuildSource(link)).rejects.toThrow('outside-roots');
    expect(f.changes).toEqual([]);
  });
});
