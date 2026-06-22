// tile-layer.test-d - type-level shape assertions for the TileLayer component
// schema + markTileLayerDirty signature (feat-20260608 M0 baseline rebuild).
//
// Anchors: plan-tasks m0-t3; plan-strategy §M0 targetFiles (tile-layer.ts);
// AGENTS.md §Component naming.

import type { EcsError, EntityHandle, World } from '@forgeax/engine-ecs';
import type { Result } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import { markTileLayerDirty, TileLayer } from '../tile-layer';

describe('TileLayer component schema (M0 baseline)', () => {
  it('type-level: 3 schema fields (tiles / layerOrder / dirty)', () => {
    const schema = TileLayer.schema;
    expectTypeOf(schema.tiles).toEqualTypeOf<'array<u32>'>();
    expectTypeOf(schema.layerOrder).toEqualTypeOf<'i32'>();
    expectTypeOf(schema.dirty).toEqualTypeOf<'u8'>();
  });
});

describe('markTileLayerDirty signature (M0 baseline)', () => {
  it('type-level: markTileLayerDirty(world, layerEntity) returns Result<void, EcsError>', () => {
    expectTypeOf(markTileLayerDirty).parameter(0).toMatchTypeOf<World>();
    expectTypeOf(markTileLayerDirty).parameter(1).toMatchTypeOf<EntityHandle>();
    expectTypeOf(markTileLayerDirty).returns.toMatchTypeOf<Result<void, EcsError>>();
  });
});
