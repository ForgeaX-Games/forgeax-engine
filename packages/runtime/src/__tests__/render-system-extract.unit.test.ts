// render-system-extract.unit.test.ts
// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M3 / w8.
//
// TDD-RED tests for the `SpriteInstances` extract entry. The plan-strategy
// §2 D-6 contract:
//
//   When the render-system extract walks the MeshRenderer query, an entity
//   carrying `SpriteInstances` must fire one of three structured `EcsError`
//   codes (declared at packages/ecs/src/errors.ts, M1 / w2) and skip the
//   renderable (no dispatch entry):
//
//     'sprite-instances-mutually-exclusive-with-instances'
//       — same entity has both Instances and SpriteInstances.
//     'sprite-instances-requires-sprite-shader'
//       — MaterialAsset's first-pass materialShaderId resolved by the extract
//         pipeline is not 'forgeax::sprite'.
//     'sprite-instances-count-mismatch'
//       — transforms.length / 16 !== regions.length / 4 (stride pair).
//
//   The zero-instance case (transforms.length === 0 && regions.length === 0)
//   is the explicit non-fire boundary from requirements (Edge Cases) — the entity
//   passes extract validation (no error) but produces no draw call.
//
// The 4 sub-assertions below RED before w10 lands the 3 _routeError fires
// + SpriteInstancesSnapshot population in `render-system-extract.ts`. They
// GO GREEN once w10 wires the validation into the queryRun callback at the
// same layer as the existing 'instance-transforms-stride-mismatch' fail-fast
// (see packages/runtime/src/__tests__/render-system-mega.test.ts §w14 for
// the structural sibling).
//
// Anchors:
//   - requirements AC-03 (3 sprite-instances error codes fire at extract)
//   - requirements (Edge Cases) (transforms.length === 0 lawful — non-fire)
//   - plan-strategy §2 D-6 (3 fires at extract entry, not at spawn)
//   - plan-strategy §3.2 sequence (extract: snap + validate + skip)
//   - research §Q-R-2.5 (extract-stage SpriteInstances sniff + validate)

import { type EcsErrorCode, World } from '@forgeax/engine-ecs';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import type {
  Handle,
  MaterialAsset,
  MaterialPassDescriptor,
  MeshAsset,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import {
  Camera,
  DirectionalLight,
  Instances,
  MeshFilter,
  MeshRenderer,
  Transform,
} from '../components';
import { SpriteInstances } from '../components/sprite-instances';
import { extractFrame } from '../render-system-extract';

interface CollectedError {
  readonly code: EcsErrorCode;
  readonly detail: unknown;
}

function identityTransform(): {
  posX: number;
  posY: number;
  posZ: number;
  quatX: number;
  quatY: number;
  quatZ: number;
  quatW: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
} {
  return {
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
  };
}

function makeShaderRegistryWithSpriteAndPbr(): ShaderRegistry {
  const mockDevice: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true,
        value: undefined,
        unwrap: () => undefined,
        unwrapOr: (d: unknown) => d,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  const sr = new ShaderRegistry({ device: mockDevice, manifestUrl: undefined });
  sr.registerMaterialShader('forgeax::sprite', {
    source: 'fn main() {}',
    paramSchema: [
      { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
      { name: 'region', type: 'vec4', default: [0.0, 0.0, 1.0, 1.0] },
      { name: 'pivot', type: 'vec2', default: [0.5, 0.5] },
      { name: 'flipX', type: 'f32', default: 0.0 },
      { name: 'flipY', type: 'f32', default: 0.0 },
      { name: 'slices', type: 'vec4', default: [0.0, 0.0, 0.0, 0.0] },
      { name: 'sliceMode', type: 'f32', default: 0.0 },
    ],
  });
  sr.registerMaterialShader('forgeax::default-unlit', {
    source: 'fn main() {}',
    paramSchema: [{ name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] }],
  });
  return sr;
}

const SPRITE_PASS: MaterialPassDescriptor = {
  name: 'Sprite',
  shader: 'forgeax::sprite',
  queue: 3000,
};

const UNLIT_PASS: MaterialPassDescriptor = {
  name: 'Forward',
  shader: 'forgeax::default-unlit',
};

function registerSpriteMesh(world: World): Handle<'MeshAsset', 'shared'> {
  return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
    kind: 'mesh',
    vertices: new Float32Array([
      0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0,
      1, 0, 0, 0, 0,
    ]),
    indices: new Uint16Array([0, 1, 2]),
    attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    aabb: new Float32Array([0, 0, 0, 1, 1, 1]),
    submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
  });
}

function spawnCameraAndLight(world: World): void {
  world
    .spawn({
      component: Camera,
      data: {
        fov: 1.0,
        aspect: 1.0,
        near: 0.1,
        far: 100.0,
        projection: 0,
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
      },
    })
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        directionX: 0,
        directionY: -1,
        directionZ: 0,
        colorR: 1,
        colorG: 1,
        colorB: 1,
        intensity: 1,
      },
    })
    .unwrap();
}

function makeScene(): {
  world: World;
  assets: AssetRegistry;
  collected: CollectedError[];
  mesh: Handle<'MeshAsset', 'shared'>;
  spriteMat: Handle<'MaterialAsset', 'shared'>;
  unlitMat: Handle<'MaterialAsset', 'shared'>;
} {
  const collected: CollectedError[] = [];
  const world = new World();
  const assets = new AssetRegistry(makeShaderRegistryWithSpriteAndPbr());
  world.setErrorHandler((err) => {
    const e = err as { code?: EcsErrorCode; detail?: unknown };
    if (e.code !== undefined) collected.push({ code: e.code, detail: e.detail });
  });
  spawnCameraAndLight(world);
  const mesh = registerSpriteMesh(world);
  const spriteMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [SPRITE_PASS],
    paramValues: {},
  } as MaterialAsset);
  const unlitMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [UNLIT_PASS],
    paramValues: {},
  } as MaterialAsset);
  return { world, assets, collected, mesh, spriteMat, unlitMat };
}

describe('render-system-extract SpriteInstances validation (w8, AC-03 + Edge Cases)', () => {
  it('(a) entity carries both Instances + SpriteInstances -> fires sprite-instances-mutually-exclusive-with-instances + entity skipped', () => {
    const { world, assets, collected, mesh, spriteMat } = makeScene();
    const transforms = new Float32Array(16);
    const regions = new Float32Array(4);
    world
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [spriteMat] } },
        { component: Instances, data: { transforms } },
        { component: SpriteInstances, data: { transforms, regions } },
      )
      .unwrap();
    const frame = extractFrame(world, assets);
    const fired = collected.filter(
      (c) => c.code === 'sprite-instances-mutually-exclusive-with-instances',
    );
    expect(fired.length).toBe(1);
    const detail = fired[0]?.detail as { entityId: number };
    expect(typeof detail.entityId).toBe('number');
    expect(detail.entityId).toBeGreaterThan(0);
    // entity skipped: zero renderables (camera/light do not produce a renderable)
    expect(frame.renderables.length).toBe(0);
  });

  it('(b) SpriteInstances on non-sprite materialShaderId -> fires sprite-instances-requires-sprite-shader + entity skipped', () => {
    const { world, assets, collected, mesh, unlitMat } = makeScene();
    const transforms = new Float32Array(16);
    const regions = new Float32Array(4);
    world
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [unlitMat] } },
        { component: SpriteInstances, data: { transforms, regions } },
      )
      .unwrap();
    const frame = extractFrame(world, assets);
    const fired = collected.filter((c) => c.code === 'sprite-instances-requires-sprite-shader');
    expect(fired.length).toBe(1);
    const detail = fired[0]?.detail as { entityId: number; observedMaterialShaderId: string };
    expect(typeof detail.entityId).toBe('number');
    expect(detail.entityId).toBeGreaterThan(0);
    // observedMaterialShaderId surfaces the actual resolved shader id string
    // for the AI user's debug; the unlit material resolves to
    // 'forgeax::default-unlit', which is != 'forgeax::sprite'.
    expect(typeof detail.observedMaterialShaderId).toBe('string');
    expect(detail.observedMaterialShaderId).not.toBe('forgeax::sprite');
    expect(frame.renderables.length).toBe(0);
  });

  it('(c) transforms.length=320, regions.length=40 (20 vs 10 instance count) -> fires sprite-instances-count-mismatch with detail + entity skipped', () => {
    const { world, assets, collected, mesh, spriteMat } = makeScene();
    const transforms = new Float32Array(320);
    const regions = new Float32Array(40);
    world
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [spriteMat] } },
        { component: SpriteInstances, data: { transforms, regions } },
      )
      .unwrap();
    const frame = extractFrame(world, assets);
    const fired = collected.filter((c) => c.code === 'sprite-instances-count-mismatch');
    expect(fired.length).toBe(1);
    const detail = fired[0]?.detail as {
      transformsLength: number;
      regionsLength: number;
      expectedStride: { transforms: 16; regions: 4 };
    };
    expect(detail.transformsLength).toBe(320);
    expect(detail.regionsLength).toBe(40);
    expect(detail.expectedStride.transforms).toBe(16);
    expect(detail.expectedStride.regions).toBe(4);
    expect(frame.renderables.length).toBe(0);
  });

  it('(d) zero-instance lawful: transforms.length=0 + regions.length=0 -> no fire + entity NOT skipped on validation grounds', () => {
    // requirements (Edge Cases): the zero-instance shape is the explicit
    // non-fire boundary. The entity passes extract validation; no draw call
    // is produced downstream because the instance count is zero.
    const { world, assets, collected, mesh, spriteMat } = makeScene();
    const transforms = new Float32Array(0);
    const regions = new Float32Array(0);
    world
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [spriteMat] } },
        { component: SpriteInstances, data: { transforms, regions } },
      )
      .unwrap();
    const frame = extractFrame(world, assets);
    // No sprite-instances error fires. (Note: the count-mismatch path must
    // NOT fire for 0/0 — `0/16 === 0/4 === 0` is the equality the validator
    // honours; the count-mismatch fire requires unequal derived counts.)
    expect(collected.filter((c) => String(c.code).startsWith('sprite-instances-')).length).toBe(0);
    // Renderable still surfaces (extract does not skip the entity on
    // validation grounds); whether the draw call is emitted is downstream
    // record-stage concern (instance count = 0 -> drawIndexed(..., 0, ...) skip).
    expect(frame.renderables.length).toBe(1);
  });
});
