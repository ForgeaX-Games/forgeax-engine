// scanner-mount-cycle.test - scanner step-6 mount-asset cycle coverage
// (feat-20260608-scene-nesting-ecs-fication M1 / w13).
//
// Coverage (AC-12; plan-strategy D-1):
//   (a) acyclic mount chain A -> B -> C: scanner returns Ok (no cycle).
//   (b) two-asset cycle A -> B -> A: scanner returns
//       Err(PackError{ code: 'pack-cyclic-reference', detail.kind: 'mount-asset',
//       detail.cycle: GUID[] }) with the GUIDs in cycle order (first === last).
//   (c) three-asset cycle A -> B -> C -> A: same, longer cycle.
//   (d) self-mount A -> A: same, single-element cycle.
//
// The fixtures are hand-authored scene .pack.json files in a tmpdir;
// each scene asset uses `payload.mounts[].source` as an integer index into
// the parent scene's `refs[]` (D-1 + research Finding 11). The mount window
// (memberFirst / memberCount) is set conservatively so the scanner step-6
// cycle pass triggers before any mount-window collision check.
//
// TDD red signal: until w14 wires `payload.mounts[].source` -> `refsByGuid`
// edge into scanner step-6, the scanner does NOT see the mount edge in the
// DFS and the cycle assertions miss. With w14 the cycle producer surfaces
// `pack-cyclic-reference + detail.kind: 'mount-asset'` (w8 landed the
// detail.kind tagging at the producer).

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scan } from '../scanner.js';

const GUID_A = 'aa000000-0000-4000-8000-000000000aaa';
const GUID_B = 'bb000000-0000-4000-8000-000000000bbb';
const GUID_C = 'cc000000-0000-4000-8000-000000000ccc';

interface MountSpec {
  readonly localId: number;
  readonly source: number;
  readonly memberFirst: number;
  readonly memberCount: number;
}

interface SceneAssetSpec {
  readonly guid: string;
  /** GUIDs the scene asset's `payload.mounts[].source` integers index into. */
  readonly refs: readonly string[];
  readonly mounts: readonly MountSpec[];
}

function sceneAssetPack(spec: SceneAssetSpec): unknown {
  return {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: spec.guid,
        kind: 'scene',
        refs: [...spec.refs],
        payload: {
          kind: 'scene',
          entities: [{ localId: 0, components: {} }],
          mounts: spec.mounts.map((m) => ({
            localId: m.localId,
            source: m.source,
            memberFirst: m.memberFirst,
            memberCount: m.memberCount,
          })),
        },
      },
    ],
  };
}

interface CycleErrorShape {
  readonly code: string;
  readonly detail: {
    readonly code?: string;
    readonly kind?: string;
    readonly cycle?: readonly string[];
  };
}

describe('scanner step-6 mount-asset cycle detection (AC-12; D-1)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pack-mount-cycle-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('(a) accepts an acyclic mount chain A -> B -> C', async () => {
    // A mounts B (source=0 in A.refs) -> B mounts C (source=0 in B.refs) ->
    // C mounts nothing.
    await writeFile(
      join(dir, 'a.pack.json'),
      JSON.stringify(
        sceneAssetPack({
          guid: GUID_A,
          refs: [GUID_B],
          mounts: [{ localId: 1, source: 0, memberFirst: 2, memberCount: 1 }],
        }),
      ),
      'utf-8',
    );
    await writeFile(
      join(dir, 'b.pack.json'),
      JSON.stringify(
        sceneAssetPack({
          guid: GUID_B,
          refs: [GUID_C],
          mounts: [{ localId: 1, source: 0, memberFirst: 2, memberCount: 1 }],
        }),
      ),
      'utf-8',
    );
    await writeFile(
      join(dir, 'c.pack.json'),
      JSON.stringify(sceneAssetPack({ guid: GUID_C, refs: [], mounts: [] })),
      'utf-8',
    );

    const result = await scan([dir]);
    expect(result.ok).toBe(true);
  });

  it('(b) rejects a two-asset cycle A -> B -> A with kind: mount-asset', async () => {
    await writeFile(
      join(dir, 'a.pack.json'),
      JSON.stringify(
        sceneAssetPack({
          guid: GUID_A,
          refs: [GUID_B],
          mounts: [{ localId: 1, source: 0, memberFirst: 2, memberCount: 1 }],
        }),
      ),
      'utf-8',
    );
    await writeFile(
      join(dir, 'b.pack.json'),
      JSON.stringify(
        sceneAssetPack({
          guid: GUID_B,
          refs: [GUID_A],
          mounts: [{ localId: 1, source: 0, memberFirst: 2, memberCount: 1 }],
        }),
      ),
      'utf-8',
    );

    const result = await scan([dir]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result.error as unknown as CycleErrorShape;
    expect(err.code).toBe('pack-cyclic-reference');
    expect(err.detail.kind).toBe('mount-asset');
    const cycle = err.detail.cycle ?? [];
    expect(cycle.length).toBeGreaterThanOrEqual(2);
    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
    // Both GUIDs participate in the cycle (case-insensitive compare; scanner
    // lowercases before storing).
    const lower = cycle.map((g) => g.toLowerCase());
    expect(lower).toContain(GUID_A.toLowerCase());
    expect(lower).toContain(GUID_B.toLowerCase());
  });

  it('(c) rejects a three-asset cycle A -> B -> C -> A with kind: mount-asset', async () => {
    await writeFile(
      join(dir, 'a.pack.json'),
      JSON.stringify(
        sceneAssetPack({
          guid: GUID_A,
          refs: [GUID_B],
          mounts: [{ localId: 1, source: 0, memberFirst: 2, memberCount: 1 }],
        }),
      ),
      'utf-8',
    );
    await writeFile(
      join(dir, 'b.pack.json'),
      JSON.stringify(
        sceneAssetPack({
          guid: GUID_B,
          refs: [GUID_C],
          mounts: [{ localId: 1, source: 0, memberFirst: 2, memberCount: 1 }],
        }),
      ),
      'utf-8',
    );
    await writeFile(
      join(dir, 'c.pack.json'),
      JSON.stringify(
        sceneAssetPack({
          guid: GUID_C,
          refs: [GUID_A],
          mounts: [{ localId: 1, source: 0, memberFirst: 2, memberCount: 1 }],
        }),
      ),
      'utf-8',
    );

    const result = await scan([dir]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result.error as unknown as CycleErrorShape;
    expect(err.code).toBe('pack-cyclic-reference');
    expect(err.detail.kind).toBe('mount-asset');
    const cycle = err.detail.cycle ?? [];
    expect(cycle.length).toBeGreaterThanOrEqual(3);
    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
  });

  it('(d) rejects a self-mount A -> A', async () => {
    await writeFile(
      join(dir, 'a.pack.json'),
      JSON.stringify(
        sceneAssetPack({
          guid: GUID_A,
          refs: [GUID_A],
          mounts: [{ localId: 1, source: 0, memberFirst: 2, memberCount: 1 }],
        }),
      ),
      'utf-8',
    );
    const result = await scan([dir]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result.error as unknown as CycleErrorShape;
    expect(err.code).toBe('pack-cyclic-reference');
    expect(err.detail.kind).toBe('mount-asset');
  });
});
