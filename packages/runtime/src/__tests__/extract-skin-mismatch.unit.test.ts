// feat-20260611-fox-skinning-vertex-attribute-chain M4 / w19 (AC-07).
//
// Asserts the bidirectional Skin <-> pbr-skin material fail-fast added to
// `render-system-extract.ts` (w17 / D-5):
//
//   (a) Skin component on entity + first-pass shader != forgeax::pbr-skin
//       -> _routeError fires `SkinMaterialMismatchError` (.code
//       === 'skin-material-mismatch') and the entity is skipped (continue),
//       leaving sibling entities in the same frame to render normally.
//
//   (b) First-pass shader === forgeax::pbr-skin + mesh.attributes missing
//       skinIndex / skinWeight -> _routeError fires
//       `MaterialSkinAttrMissingError` (.code === 'material-skin-attr-missing')
//       and the entity is skipped.
//
//   (c) Skin + pbr-skin material + 6-attribute mesh -> NO error routed
//       (positive control).
//
// Plan-strategy D-5: extract uses `_routeError` + `continue` (one entity's
// misconfiguration must NOT abort the whole frame's draw list); this test
// also asserts that a sibling unlit entity in the same frame still extracts
// to a renderable entry alongside the bad-skin one.

import { type Handle, Severity, World } from '@forgeax/engine-ecs';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset, MeshAsset, SkeletonAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { Camera, MeshFilter, MeshRenderer, Skin, Transform } from '../components';
import { extractFrame } from '../render-system-extract';
import { propagateTransforms } from '../systems/propagate-transforms';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// ── helpers ──────────────────────────────────────────────────────────────

const UNIT_AABB = new Float32Array([-1, -1, -1, 1, 1, 1]);
// Unskinned: 12 floats / vertex × 3 vertices = 36 (position vec3 + normal vec3 + uv vec2 + tangent vec4).
const TRIANGLE_VERTICES = new Float32Array([
  0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0,
  0, 0, 0,
]);
// Skinned: 18 floats / vertex × 3 vertices = 54 (12 base + skinIndex u16x4 packed in 2 floats at slots 12-13 + skinWeight vec4 at slots 14-17).
// validateMeshPayload (asset-registry feat: validateMeshPayload skin-aware stride) rejects skin meshes at the 12F stride.
// Trailing 6 floats per vertex are placeholder (extract path reads attributes.skinIndex/Weight directly, not from interleaved buffer).
const TRIANGLE_VERTICES_SKINNED = new Float32Array([
  // v0: pos (0,0,0) | normal (0,0,1) | uv (0,0) | tangent (0,0,0,1) | skin (0,0) | weight (0,0,0,0)
  0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  // v1: pos (1,0,0) | normal (0,0,1) | uv (1,0) | tangent (0,0,0,1) | skin (0,0) | weight (0,0,0,0)
  1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  // v2: pos (0,1,0) | normal (0,0,1) | uv (0,1) | tangent (0,0,0,1) | skin (0,0) | weight (0,0,0,0)
  0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
]);
const TRIANGLE_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

function makeAssetRegistry(): AssetRegistry {
  const shaderRegistry: ShaderRegistry = makeMockShaderRegistry();
  // The shared mock registry omits forgeax::pbr-skin (it is the
  // engine-shipped skin shader registered at boot time elsewhere). The
  // mismatch path under test needs MaterialAsset register-time validation
  // to accept first-pass shader === 'forgeax::pbr-skin', so we register a
  // minimal entry here. paramSchema mirrors the standard PBR family head
  // (baseColor / metallic / roughness) since this test does not exercise
  // skin-specific param overlay.
  shaderRegistry.registerMaterialShader('forgeax::pbr-skin', {
    source: 'fn main() {}',
    paramSchema: [
      { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
      { name: 'metallic', type: 'f32', default: 0.0 },
      { name: 'roughness', type: 'f32', default: 0.5 },
    ],
  });
  return new AssetRegistry(shaderRegistry);
}

function registerSkinnedMesh(world: World): Handle<'MeshAsset', 'shared'> {
  return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
    kind: 'mesh',
    vertices: TRIANGLE_VERTICES_SKINNED,
    indices: new Uint16Array([0, 1, 2]),
    attributes: {
      position: TRIANGLE_POSITIONS,
      // pbr-skin requires skinIndex + skinWeight in attributes; values are
      // irrelevant here -- key presence is what extract reads.
      skinIndex: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    },
    aabb: UNIT_AABB,
    submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
  });
}

function registerUnskinnedMesh(world: World): Handle<'MeshAsset', 'shared'> {
  return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
    kind: 'mesh',
    vertices: TRIANGLE_VERTICES,
    indices: new Uint16Array([0, 1, 2]),
    attributes: { position: TRIANGLE_POSITIONS },
    aabb: UNIT_AABB,
    submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
  });
}

function registerPbrSkinMaterial(world: World): Handle<'MaterialAsset', 'shared'> {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::pbr-skin',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: { baseColor: [1, 1, 1] },
  });
}

function registerUnlitMaterial(world: World): Handle<'MaterialAsset', 'shared'> {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-unlit',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: { baseColor: [1, 1, 1] },
  });
}

function registerSkeleton(world: World): Handle<'SkeletonAsset', 'shared'> {
  return world.allocSharedRef<'SkeletonAsset', SkeletonAsset>('SkeletonAsset', {
    kind: 'skeleton',
    inverseBindMatrices: new Float32Array(16),
    jointCount: 1,
  });
}

function spawnCamera(world: World): void {
  world
    .spawn(
      {
        component: Transform,
        data: {
          posX: 0,
          posY: 0,
          posZ: 5,
          quatX: 0,
          quatY: 0,
          quatZ: 0,
          quatW: 1,
          scaleX: 1,
          scaleY: 1,
          scaleZ: 1,
        },
      },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
    )
    .unwrap();
}

const IDENTITY_TRANSFORM = {
  posX: 0,
  posY: 0,
  posZ: 0,
  quatX: 0,
  quatY: 0,
  quatZ: 0,
  quatW: 1,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
} as const;

function spawnRenderable(
  world: World,
  meshHandle: Handle<'MeshAsset', 'shared'>,
  matHandle: Handle<'MaterialAsset', 'shared'>,
): void {
  world
    .spawn(
      { component: Transform, data: IDENTITY_TRANSFORM },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    )
    .unwrap();
}

function spawnSkinnedRenderable(
  world: World,
  meshHandle: Handle<'MeshAsset', 'shared'>,
  matHandle: Handle<'MaterialAsset', 'shared'>,
  skeletonHandle: Handle<'SkeletonAsset', 'shared'>,
): void {
  // feat-20260612 M2 / m2-6: Skin.joints[] now validated against
  // SkeletonAsset.jointCount (=1 here) at extract time; spawn one joint
  // Entity bearing Transform so the count matches and the new
  // `joint-count-mismatch` / `joint-entity-dangling` checks pass for the
  // bidirectional Skin <-> pbr-skin mismatch happy path (test (c)).
  const jointEntity = world.spawn({ component: Transform, data: IDENTITY_TRANSFORM }).unwrap();
  world
    .spawn(
      { component: Transform, data: IDENTITY_TRANSFORM },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
      {
        component: Skin,
        data: {
          skeleton: skeletonHandle,
          joints: new Uint32Array([jointEntity as unknown as number]),
        },
      },
    )
    .unwrap();
}

// ── tests ────────────────────────────────────────────────────────────────

describe('render-system-extract Skin / pbr-skin mismatch (AC-07 / w19)', () => {
  it('(a) Skin + non-pbr-skin material -> SkinMaterialMismatchError routed + entity skipped', () => {
    const world = new World();
    const assets = makeAssetRegistry();
    const meshHandle = registerSkinnedMesh(world);
    const unlitMatHandle = registerUnlitMaterial(world);
    const skeletonHandle = registerSkeleton(world);
    spawnCamera(world);
    spawnSkinnedRenderable(world, meshHandle, unlitMatHandle, skeletonHandle);
    propagateTransforms(world);

    const errorSpy = vi.fn();
    world.setErrorHandler(errorSpy);

    const frame = extractFrame(world, assets);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [errArg, ctxArg] = errorSpy.mock.calls[0] ?? [];
    expect((errArg as { code: string }).code).toBe('skin-material-mismatch');
    expect((errArg as { detail: { actualShader: string | undefined } }).detail.actualShader).toBe(
      'forgeax::default-unlit',
    );
    expect((ctxArg as { severity: number }).severity).toBe(Severity.Error);

    // entity skipped -> no renderable entry
    expect(frame.renderables).toHaveLength(0);
  });

  it('(b) pbr-skin material + non-skin mesh -> MaterialSkinAttrMissingError routed + entity skipped', () => {
    const world = new World();
    const assets = makeAssetRegistry();
    const meshHandle = registerUnskinnedMesh(world);
    const skinMatHandle = registerPbrSkinMaterial(world);
    spawnCamera(world);
    spawnRenderable(world, meshHandle, skinMatHandle);
    propagateTransforms(world);

    const errorSpy = vi.fn();
    world.setErrorHandler(errorSpy);

    const frame = extractFrame(world, assets);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [errArg] = errorSpy.mock.calls[0] ?? [];
    expect((errArg as { code: string }).code).toBe('material-skin-attr-missing');
    expect(
      (errArg as { detail: { missing: 'skinIndex' | 'skinWeight' | 'both' } }).detail.missing,
    ).toBe('both');

    expect(frame.renderables).toHaveLength(0);
  });

  it('(c) Skin + pbr-skin material + skinned mesh -> no error routed', () => {
    const world = new World();
    const assets = makeAssetRegistry();
    const meshHandle = registerSkinnedMesh(world);
    const skinMatHandle = registerPbrSkinMaterial(world);
    const skeletonHandle = registerSkeleton(world);
    spawnCamera(world);
    spawnSkinnedRenderable(world, meshHandle, skinMatHandle, skeletonHandle);
    propagateTransforms(world);

    const errorSpy = vi.fn();
    world.setErrorHandler(errorSpy);

    extractFrame(world, assets);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('(d) D-5 continue semantics: bad-skin entity skipped does NOT abort sibling extract', () => {
    const world = new World();
    const assets = makeAssetRegistry();
    const skinnedMesh = registerSkinnedMesh(world);
    const unskinnedMesh = registerUnskinnedMesh(world);
    const unlitMat = registerUnlitMaterial(world);
    const skeletonHandle = registerSkeleton(world);
    spawnCamera(world);
    // bad-skin entity (Skin + unlit material) -> mismatch -> skipped
    spawnSkinnedRenderable(world, skinnedMesh, unlitMat, skeletonHandle);
    // sibling well-formed entity (no Skin, unlit material, unskinned mesh)
    spawnRenderable(world, unskinnedMesh, unlitMat);
    propagateTransforms(world);

    const errorSpy = vi.fn();
    world.setErrorHandler(errorSpy);

    const frame = extractFrame(world, assets);

    // exactly one mismatch error (the bad-skin entity), and the sibling
    // emerges as a renderable -- proving `continue` did not turn into
    // `return Result.err` for the whole frame.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [errArg] = errorSpy.mock.calls[0] ?? [];
    expect((errArg as { code: string }).code).toBe('skin-material-mismatch');
    expect(frame.renderables.length).toBeGreaterThanOrEqual(1);
  });
});
