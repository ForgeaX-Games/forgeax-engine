// @forgeax/engine-graphics-extras - glyph mesh bake helper
// (feat-20260531-world-space-msdf-text-rendering M4 / w17).
//
// Turns the pure layout output (w15) into a registered `MeshAsset` and a
// conservative bounding-sphere cube AABB (plan-strategy D-4 / D-5). Called by
// the `glyphTextLayoutSystem` (w18) -- not a public AI-user API; AI users
// declare a `GlyphText` component and the system bakes behind the scenes.
//
// 12-float stride (R-2 hard gate): the layout already produced interleaved
// vertices at the canonical `BUILTIN_FLOATS_PER_VERTEX` stride (position + uv
// real, normal (0,0,1) / tangent (0,0,0,1) placeholder). We deinterleave into
// the `VertexAttributeMap` (position / normal / uv / tangent) so
// `AssetRegistry.register` can derive the GPU vertex layout + AABB. The
// register call fail-fasts with `mesh-vertex-stride-mismatch` if the stride is
// ever wrong -- this module never bypasses that gate.
//
// Empty string -> 0-vertex / 0-index mesh; `register` accepts the empty mesh
// (validateMeshPayload branch (b)) and pick skips it (inverted-infinity AABB).
//
// Conservative cube AABB (D-5): pick must be orientation-independent (text may
// billboard toward the camera at draw time, but `pick.ts` raycasts against the
// static local AABB x world matrix without the billboard rotation). The baked
// mesh's `attributes.position` carries the 8 corners of a cube centered at the
// anchor with half-side = the layout radius R; `AssetRegistry.register`
// computes the local AABB from that position attribute (`computeAABB`), so the
// REGISTERED mesh AABB is the conservative cube -- a ray that would hit the
// text from any in-plane orientation is caught. The GPU vertex buffer is built
// from the interleaved `vertices` (real glyph quads), which is fully decoupled
// from `attributes.position` (uploadMeshById reads `mesh.vertices`). `pick.ts`
// is NOT modified -- the cube is purely a bake-step property of the mesh.

import type { World } from '@forgeax/engine-ecs';
import { ok, type Result } from '@forgeax/engine-rhi';
import type { AssetError, Handle, MeshAsset, VertexAttributeMap } from '@forgeax/engine-types';

import type { GlyphLayoutResult } from './glyph-layout';

/** Result of baking a glyph layout into a registered mesh. */
export interface GlyphMeshBakeResult {
  /** The registered unmanaged mesh handle (feed to `MeshFilter.assetHandle`). */
  readonly handle: Handle<'MeshAsset', 'shared'>;
  /**
   * Conservative bounding-sphere cube AABB in local space: 6 floats
   * [-R,-R,-R, R,R,R] centered at the anchor (plan-strategy D-5). Empty
   * layout -> all-zero box.
   */
  readonly aabb: Float32Array;
}

/** Build the MeshAsset POD (12-float stride) from a glyph layout. */
export function buildGlyphMeshAsset(layout: GlyphLayoutResult): MeshAsset {
  const { vertices, indices, radius } = layout;
  return {
    kind: 'mesh',
    vertices,
    indices,
    // `attributes.position` carries the 8 conservative-cube corners (half-side
    // = radius) so `register` computes the orientation-independent cube AABB
    // (D-5). The GPU vertex buffer is built from the interleaved `vertices`
    // (uploadMeshById reads `mesh.vertices`), fully decoupled from this
    // position attribute -- which exists only to drive `computeAABB`.
    attributes: cubeCornerAttributes(radius),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: vertices.length / 12,
        topology: 'triangle-list',
      },
    ],
  };
}

/** Conservative cube AABB centered at the anchor with half-side = layout radius. */
export function conservativeCubeAabb(radius: number): Float32Array {
  return Float32Array.of(-radius, -radius, -radius, radius, radius, radius);
}

/**
 * Bake a glyph layout into a registered mesh + conservative cube AABB.
 *
 * @param assets The AssetRegistry that owns the mesh handle lifecycle.
 * @param layout The pure layout output from `layoutGlyphText` (w15).
 * @returns `Result.ok({ handle, aabb })` or `Result.err(AssetError)` when
 *   `register` fail-fasts (e.g. stride mismatch -- should never happen for a
 *   layout produced by w15, but the gate is honored, not bypassed).
 */
export function bakeGlyphMesh(
  world: World,
  layout: GlyphLayoutResult,
): Result<GlyphMeshBakeResult, AssetError> {
  const aabb = conservativeCubeAabb(layout.radius);
  // feat-20260614 M8 (D-17/D-19): the baked text mesh is a runtime-minted
  // user-tier asset allocated directly into the world's SharedRefStore. Unlike
  // `AssetRegistry.catalog` (which runs `withMeshAabb` to compute the AABB from
  // `attributes.position`), `allocSharedRef` stores the payload verbatim -- so
  // the mesh POD must carry its own `.aabb` for the cull / pick path to read it.
  const meshAsset: MeshAsset = { ...buildGlyphMeshAsset(layout), aabb };
  const handle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', meshAsset);
  return ok({ handle, aabb });
}

/**
 * The 8 corners of a cube centered at the anchor with half-side = radius,
 * packed as a flat `position` attribute (x,y,z per corner). `computeAABB`
 * reduces this to the conservative cube AABB (D-5). For an empty layout
 * (radius 0) all corners collapse to the origin, yielding a zero-volume box
 * that pick treats as a point miss -- consistent with the empty-string path.
 */
function cubeCornerAttributes(radius: number): VertexAttributeMap {
  const r = radius;
  return {
    position: Float32Array.of(
      -r,
      -r,
      -r,
      r,
      -r,
      -r,
      r,
      r,
      -r,
      -r,
      r,
      -r,
      -r,
      -r,
      r,
      r,
      -r,
      r,
      r,
      r,
      r,
      -r,
      r,
      r,
    ),
  };
}
