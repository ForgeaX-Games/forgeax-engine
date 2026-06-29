// resolveName single / multi asset package — AC-01 + AC-02 (feat-20260618 w16).
//
// Red-first: written before w10 implements resolveName. Constructs the package
// state directly through registerPackage (Risk-2: no pack-index fetch needed).
//
// Coverage:
//   AC-01 — single-asset package: resolveName === basename(path); the stored
//           Asset POD carries no `name` property (name is never on the payload).
//   AC-02 — multi-asset package: resolveName returns each entry's stored name.

import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { SamplerAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { AssetRegistry } from '../asset-registry';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const SINGLE_GUID = 'a0000000-0000-4000-a000-000000000001';
const MULTI_A_GUID = 'a0000000-0000-4000-a000-000000000002';
const MULTI_B_GUID = 'a0000000-0000-4000-a000-000000000003';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

const sampler: SamplerAsset = { kind: 'sampler' };

describe('resolveName single-asset package (AC-01)', () => {
  it('returns basename(path) and the POD has no name property', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(SINGLE_GUID), sampler);
    reg._registerPackage('assets/hero.glb', [SINGLE_GUID]);

    expect(reg.resolveName(SINGLE_GUID)).toBe('hero.glb');

    const stored = reg.lookup(SINGLE_GUID);
    expect(stored).toBeDefined();
    expect(Object.hasOwn(stored as object, 'name')).toBe(false);
  });
});

describe('resolveName multi-asset package (AC-02)', () => {
  it('returns each entry stored name', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(MULTI_A_GUID), sampler);
    reg.catalog(parseGuid(MULTI_B_GUID), sampler);
    reg._registerPackage(
      'assets/char.glb',
      [MULTI_A_GUID, MULTI_B_GUID],
      new Map([
        [MULTI_A_GUID, 'Body'],
        [MULTI_B_GUID, 'Head'],
      ]),
    );

    expect(reg.resolveName(MULTI_A_GUID)).toBe('Body');
    expect(reg.resolveName(MULTI_B_GUID)).toBe('Head');
  });
});
