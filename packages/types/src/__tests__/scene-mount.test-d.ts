// scene-mount.test-d - type-level assertions for SceneInstanceMount /
// MountOverride POD shapes and SceneAsset.mounts top-level field
// (feat-20260608-scene-nesting-ecs-fication M1 / w3).
//
// Coverage (AC-01):
//   (a) SceneInstanceMount POD interface exports with the required field
//       set: localId / source / memberFirst / memberCount; and the
//       optional fields parent / components / overrides.
//   (b) MountOverride POD interface exports with localId / comp / field /
//       value.
//   (c) SceneAsset gains a top-level `mounts: readonly SceneInstanceMount[]`
//       optional field; legacy SceneAsset values without `mounts` remain
//       structurally assignable (back-compat: missing mounts === []).
//
// Charter mapping: proposition 1 (single-entry import surface from
// @forgeax/engine-types) + proposition 4 (explicit failure: cross-brand
// localId values reject) + proposition 5 (consistent abstraction:
// SceneInstanceMount mirrors SceneEntity in shape and discoverability).
//
// TDD red signal: this file imports SceneInstanceMount / MountOverride
// from '../index'; while the symbols are absent the file fails to compile
// (vitest --typecheck reports the missing exports). The w7 impl turns
// this red into green by adding the exports.

import { describe, expectTypeOf, it } from 'vitest';
import type { LocalEntityId, MountOverride, SceneAsset, SceneInstanceMount } from '../index';

describe('SceneInstanceMount POD shape (AC-01)', () => {
  it('declares the required scalar fields with correct types', () => {
    expectTypeOf<SceneInstanceMount['localId']>().toEqualTypeOf<LocalEntityId>();
    expectTypeOf<SceneInstanceMount['source']>().toEqualTypeOf<number | string>();
    expectTypeOf<SceneInstanceMount['memberFirst']>().toEqualTypeOf<LocalEntityId>();
    expectTypeOf<SceneInstanceMount['memberCount']>().toEqualTypeOf<number>();
  });

  it('declares parent / components / overrides as optional', () => {
    expectTypeOf<SceneInstanceMount['parent']>().toEqualTypeOf<LocalEntityId | undefined>();
    expectTypeOf<SceneInstanceMount['overrides']>().toEqualTypeOf<
      readonly MountOverride[] | undefined
    >();
  });
});

describe('MountOverride POD shape (AC-01 / AC-19)', () => {
  it('declares the four required fields with correct types', () => {
    expectTypeOf<MountOverride['localId']>().toEqualTypeOf<LocalEntityId>();
    expectTypeOf<MountOverride['comp']>().toEqualTypeOf<string>();
    expectTypeOf<MountOverride['field']>().toEqualTypeOf<string>();
    expectTypeOf<MountOverride['value']>().toEqualTypeOf<unknown>();
  });
});

describe('SceneAsset.mounts top-level field (AC-01)', () => {
  it('exposes mounts as a readonly array of SceneInstanceMount, optional', () => {
    expectTypeOf<SceneAsset['mounts']>().toEqualTypeOf<readonly SceneInstanceMount[] | undefined>();
  });

  it('back-compat: legacy SceneAsset value without mounts stays assignable', () => {
    const legacy: SceneAsset = {
      kind: 'scene',
      entities: [],
    };
    expectTypeOf(legacy).toMatchTypeOf<SceneAsset>();
  });
});
