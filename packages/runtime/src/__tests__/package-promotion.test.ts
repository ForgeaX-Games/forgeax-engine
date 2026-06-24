// 1->N package promotion idempotence — AC-05 (feat-20260618 w12).
//
// Red-first: written before w11 adds the promotion branch to registerPackage.
//
// Coverage:
//   AC-05 — when a single-asset package gains a second asset, the original
//           asset's derived basename is frozen as its stored name so it keeps
//           the same resolveName (now via the multi-asset branch), with no error
//           and no caller awareness. Promotion is idempotent: re-registering the
//           same path does not overwrite an already-frozen name.
//
// The promotion is observable through `package.xor-invariant-violated`: when the
// original asset already carries a stored name at promotion time (the abnormal
// single-asset-with-name state, D-4), the freeze must not overwrite it and the
// soft-violation counter increments. Without w11 there is no promotion branch,
// so the counter never fires (the falsifying assertion).

import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { SamplerAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { AssetRegistry } from '../asset-registry';
import { createEngineMetrics } from '../engine-metrics';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const G1 = 'c0000000-0000-4000-c000-000000000001';
const G2 = 'c0000000-0000-4000-c000-000000000002';
const PATH = 'assets/scene.glb';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

const sampler: SamplerAsset = { kind: 'sampler' };

describe('1->N package promotion (AC-05)', () => {
  it('single asset derives basename', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(G1), sampler);
    reg._registerPackage(PATH, [G1]);
    expect(reg.resolveName(G1)).toBe('scene.glb');
  });

  it('adding a second asset keeps the original name unchanged, no error', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(G1), sampler);
    reg._registerPackage(PATH, [G1]);
    reg.catalog(parseGuid(G2), sampler);
    reg._registerPackage(PATH, [G2], new Map([[G2, 'SecondAsset']]));

    expect(reg.resolveName(G1)).toBe('scene.glb');
    expect(reg.resolveName(G2)).toBe('SecondAsset');
    expect(reg.packageOf(G1)?.assetCount).toBe(2);
  });

  it('re-registering the same path is idempotent (does not overwrite frozen name)', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(G1), sampler);
    reg._registerPackage(PATH, [G1]);
    reg.catalog(parseGuid(G2), sampler);
    reg._registerPackage(PATH, [G2], new Map([[G2, 'SecondAsset']]));
    reg._registerPackage(PATH, [G1, G2], new Map([[G2, 'SecondAsset']]));

    expect(reg.resolveName(G1)).toBe('scene.glb');
    expect(reg.resolveName(G2)).toBe('SecondAsset');
  });

  it('abnormal single-asset-with-name state bumps the xor counter and is not overwritten', () => {
    const reg = makeRegistry();
    const metrics = createEngineMetrics();
    reg.setMetrics(metrics);
    // Abnormal: a single-asset package whose lone asset already carries a name.
    reg.catalog(parseGuid(G1), sampler);
    reg._registerPackage(PATH, [G1], new Map([[G1, 'PreNamed']]));
    reg.catalog(parseGuid(G2), sampler);
    // Promotion fires: the pre-existing name is preserved (not overwritten by
    // basename) and the soft-violation counter records the abnormal state.
    reg._registerPackage(PATH, [G2], new Map([[G2, 'SecondAsset']]));

    expect(reg.resolveName(G1)).toBe('PreNamed');
    expect(metrics.snapshot()['package.xor-invariant-violated']).toBe(1);
  });
});
