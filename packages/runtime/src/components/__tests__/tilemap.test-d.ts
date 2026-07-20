// tilemap.test-d - type-level shape assertions for the Tilemap component schema
// (feat-20260608 M0 baseline rebuild).
//
// Anchors: plan-tasks m0-t3; plan-strategy §M0 targetFiles (tilemap.ts);
// AGENTS.md §Component naming (single-semantic component drops Component suffix).

import { createQueryState } from '@forgeax/engine-ecs';
import { describe, expectTypeOf, it } from 'vitest';
import { ChildOf } from '../child-of';
import { Tilemap } from '../tilemap';

describe('Tilemap component schema (M0 baseline)', () => {
  it('type-level: 5 schema fields (cols / rows / tileSize / tileset / chunkSize)', () => {
    const schema = Tilemap.schema;
    expectTypeOf(schema.cols).toEqualTypeOf<'u32'>();
    expectTypeOf(schema.rows).toEqualTypeOf<'u32'>();
    // feat-20260709 M3: tileSizeX/tileSizeY collapsed into one inline
    // array<f32,2> column (tileSize).
    expectTypeOf(schema.tileSize).toEqualTypeOf<'array<f32, 2>'>();
    expectTypeOf(schema.chunkSize).toEqualTypeOf<'u32'>();
    expectTypeOf(schema.tileset).toEqualTypeOf<'shared<TilesetAsset>'>();
  });

  it('type-level: Tilemap is consumable by createQueryState({ with: [...] })', () => {
    const state = createQueryState({ with: [Tilemap, ChildOf] });
    expectTypeOf(state).not.toBeNever();
  });
});
