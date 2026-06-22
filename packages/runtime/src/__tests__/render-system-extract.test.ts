// Consolidated by feat-20260608-ci-time-cut M5 w13/w14: merges
//   - render-system-extract.test.ts
//   - render-system-extract-material-inheritance.test.ts
//   - render-system-extract-sprite-slices.test.ts
//   - render-system-clear-camera.test.ts
// Each original file body sits in its own block-scope so helper names
// cannot collide; describe() inside still registers globally with vitest.

import { World } from '@forgeax/engine-ecs';
import { mat4, vec3 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import type {
  Handle,
  MaterialAsset,
  MaterialPassDescriptor,
  MeshAsset,
} from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import {
  Camera,
  ChildOf,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  PointLight,
  SpotLight,
  Transform,
} from '../components';
import { HANDLE_CUBE } from '../index';
import { extractFrame } from '../render-system-extract';
import { propagateTransforms } from '../systems/propagate-transforms';
import { createDefaultLoaderRegistry } from '../wire-default-loaders';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// ─── from render-system-extract.test.ts ───
{
  // w9 -- render-system-extract consumer migration unit tests (M3, AC-07 / AC-15).
  //
  // Post-migration extract reads the single resolved `Transform.world` mat4
  // (written by propagateTransforms) for every world-space consumer; the legacy
  // GlobalTransform-column-switch + per-snapshot `mat4.compose` are gone.
  //
  // Five consumer classes covered:
  //   1. mesh-walk     -> RenderableSnapshot.transform.world is the 16-float
  //      column-major world mat4 (parent x child), copied straight from the
  //      Transform.world view; no per-snapshot compose.
  //   2. frustum cull  -> the cull AABB follows the world mat4 (a child placed
  //      off-screen by its parent is culled; in-screen is kept) -- same-source
  //      with the rendered world (AC-05 carried forward).
  //   3. camera view   -> CameraSnapshot.position is the world-space translation
  //      (mat4.getTranslation of Transform.world); a child camera reflects
  //      parent x child.
  //   4. light position -> point / spot light position is the world-space
  //      translation extracted from Transform.world (mat4.getTranslation).
  //   5. AC-15 zero-materialization -> the mesh-walk reads world through the
  //      column-level array view; it does NOT call `world.get` per renderable
  //      to materialize a `{}` whole-component object.
  //
  // extractFrame + propagateTransforms are pure CPU functions; no GPU is touched.

  function identity() {
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

  const cameraData = {
    fov: 1.0,
    aspect: 1.0,
    near: 0.1,
    far: 100.0,
    projection: 0,
    left: -1,
    right: 1,
    bottom: -1,
    top: 1,
  };

  function perspectiveCameraData() {
    return {
      fov: Math.PI / 4,
      aspect: 1,
      near: 0.1,
      far: 100,
      projection: 0,
      left: -1,
      right: 1,
      bottom: -1,
      top: 1,
    };
  }

  function spawnCamera(world: World): void {
    world
      .spawn({ component: Transform, data: identity() }, { component: Camera, data: cameraData })
      .unwrap();
  }

  function registerMesh(world: World): Handle<'MeshAsset', 'shared'> {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
      kind: 'mesh',
      vertices: new Float32Array([
        0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0,
        1, 0, 0, 0, 0,
      ]),
      indices: new Uint16Array([0, 1, 2]),
      attributes: { position: positions },
      aabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 36,
          topology: 'triangle-list',
        },
      ],
    });
  }

  function registerMaterial(world: World): Handle<'MaterialAsset', 'shared'> {
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

  describe('render-system-extract consumer migration (w9, AC-07 / AC-15)', () => {
    it('mesh-walk: RenderableSnapshot.transform.world is the resolved world mat4 (parent x child), zero per-snapshot compose', () => {
      const world = new World();
      spawnCamera(world);
      const parent = world
        .spawn({ component: Transform, data: { ...identity(), posX: 10, posY: 0, posZ: 0 } })
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { ...identity(), posX: 2, posY: 3, posZ: 0 } },
          { component: ChildOf, data: { parent } },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { frustumCulled: 0 } as never },
        )
        .unwrap();

      expect(propagateTransforms(world).ok).toBe(true);
      const frame = extractFrame(world);
      expect(frame.renderables.length).toBe(1);

      const w = frame.renderables[0]?.transform.world;
      expect(w).toBeInstanceOf(Float32Array);
      expect(w?.length).toBe(16);
      // world translation column (col3 = m[12,13,14]) = parent (10,0,0) + child local (2,3,0).
      expect(w?.[12]).toBeCloseTo(12, 5);
      expect(w?.[13]).toBeCloseTo(3, 5);
      expect(w?.[14]).toBeCloseTo(0, 5);
      // The snapshot world must equal the entity's Transform.world column byte-for-byte.
    });

    it('mesh-walk: flat root world mat4 equals compose(local)', () => {
      const world = new World();
      spawnCamera(world);
      world
        .spawn(
          { component: Transform, data: { ...identity(), posX: 5, posY: 6, posZ: 7, scaleX: 2 } },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { frustumCulled: 0 } as never },
        )
        .unwrap();

      expect(propagateTransforms(world).ok).toBe(true);
      const frame = extractFrame(world);
      expect(frame.renderables.length).toBe(1);
      const w = frame.renderables[0]?.transform.world as Float32Array;
      const expected = mat4.create();
      mat4.compose(expected, vec3.create(5, 6, 7), [0, 0, 0, 1], vec3.create(2, 1, 1));
      for (let i = 0; i < 16; i++) {
        expect(w[i]).toBeCloseTo((expected as unknown as number[])[i] as number, 5);
      }
    });

    it('camera view: child camera position reflects world translation (parent x child)', () => {
      const world = new World();
      const rig = world
        .spawn({ component: Transform, data: { ...identity(), posX: 0, posY: 5, posZ: 0 } })
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { ...identity(), posX: 1, posY: 0, posZ: 2 } },
          { component: ChildOf, data: { parent: rig } },
          { component: Camera, data: cameraData },
        )
        .unwrap();

      expect(propagateTransforms(world).ok).toBe(true);
      const frame = extractFrame(world);
      expect(frame.cameras.length).toBe(1);
      const pos = frame.cameras[0]?.position;
      // rig (0,5,0) x camera local (1,0,2) -> world (1,5,2).
      expect(pos?.[0]).toBeCloseTo(1, 5);
      expect(pos?.[1]).toBeCloseTo(5, 5);
      expect(pos?.[2]).toBeCloseTo(2, 5);
    });

    it('light position: child point + spot light position reflects world translation', () => {
      const world = new World();
      const rig = world
        .spawn({ component: Transform, data: { ...identity(), posX: 0, posY: 0, posZ: 7 } })
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { ...identity(), posX: 3, posY: 0, posZ: 0 } },
          { component: ChildOf, data: { parent: rig } },
          { component: PointLight, data: { intensity: 1 } },
        )
        .unwrap();
      const spotRig = world
        .spawn({ component: Transform, data: { ...identity(), posX: 0, posY: 4, posZ: 0 } })
        .unwrap();
      world
        .spawn(
          { component: Transform, data: identity() },
          { component: ChildOf, data: { parent: spotRig } },
          {
            component: SpotLight,
            data: { directionX: 0, directionY: -1, directionZ: 0, intensity: 1 },
          },
        )
        .unwrap();

      expect(propagateTransforms(world).ok).toBe(true);
      const frame = extractFrame(world);
      expect(frame.lights.point.length).toBe(1);
      expect(frame.lights.point[0]?.position?.[0]).toBeCloseTo(3, 5);
      expect(frame.lights.point[0]?.position?.[2]).toBeCloseTo(7, 5);
      expect(frame.lights.spot.length).toBe(1);
      expect(frame.lights.spot[0]?.position?.[1]).toBeCloseTo(4, 5);
      // D-6 carried forward: spot direction stays from the SpotLight component.
      expect(frame.lights.spot[0]?.direction?.[1]).toBeCloseTo(-1, 5);
    });

    it('directional light snapshot is unchanged regardless of hierarchy (no Transform dependency)', () => {
      const world = new World();
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
      expect(propagateTransforms(world).ok).toBe(true);
      const frame = extractFrame(world);
      expect(frame.lights.directional).toBeDefined();
      expect(frame.lights.directional?.direction?.[1]).toBeCloseTo(-1, 5);
    });

    it('AC-05: cull AABB follows the world mat4 (parent off-screen -> child culled; in-screen -> kept)', () => {
      {
        const world = new World();
        const mesh = registerMesh(world);
        const mat = registerMaterial(world);
        world
          .spawn(
            { component: Transform, data: { ...identity(), posX: 0, posY: 0, posZ: 5 } },
            { component: Camera, data: perspectiveCameraData() },
          )
          .unwrap();
        const parent = world
          .spawn({ component: Transform, data: { ...identity(), posX: 0, posY: 0, posZ: 100 } })
          .unwrap();
        world
          .spawn(
            { component: Transform, data: identity() },
            { component: ChildOf, data: { parent } },
            { component: MeshFilter, data: { assetHandle: mesh } },
            { component: MeshRenderer, data: { materials: [mat] } },
          )
          .unwrap();
        expect(propagateTransforms(world).ok).toBe(true);
        const frame = extractFrame(world);
        expect(frame.renderables).toHaveLength(0);
      }
      {
        const world = new World();
        const mesh = registerMesh(world);
        const mat = registerMaterial(world);
        world
          .spawn(
            { component: Transform, data: { ...identity(), posX: 0, posY: 0, posZ: 5 } },
            { component: Camera, data: perspectiveCameraData() },
          )
          .unwrap();
        const parent = world.spawn({ component: Transform, data: identity() }).unwrap();
        world
          .spawn(
            { component: Transform, data: identity() },
            { component: ChildOf, data: { parent } },
            { component: MeshFilter, data: { assetHandle: mesh } },
            { component: MeshRenderer, data: { materials: [mat] } },
          )
          .unwrap();
        expect(propagateTransforms(world).ok).toBe(true);
        const frame = extractFrame(world);
        expect(frame.renderables).toHaveLength(1);
      }
    });

    it('AC-15: mesh-walk reads world via the column array view, not a per-renderable world.get materialization', () => {
      const world = new World();
      spawnCamera(world);
      world
        .spawn(
          { component: Transform, data: { ...identity(), posX: 1, posY: 2, posZ: 3 } },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { frustumCulled: 0 } as never },
        )
        .unwrap();
      expect(propagateTransforms(world).ok).toBe(true);

      const getSpy = vi.spyOn(world, 'get');
      extractFrame(world);
      // The mesh-walk must NOT call world.get(entity, Transform) to read the
      // resolved world mat4 -- it goes through the zero-materialization column
      // array view (_getArrayView). Any Transform materialization here would
      // re-introduce the per-frame `{}` allocation AC-15 forbids.
      const transformGets = getSpy.mock.calls.filter((c) => {
        const comp = c[1] as { name?: string } | undefined;
        return comp?.name === 'Transform';
      });
      expect(transformGets.length).toBe(0);
      getSpy.mockRestore();
    });
  });
}

// ─── from render-system-extract-material-inheritance.test.ts ───
{
  // render-system-extract-material-inheritance.test.ts — M3 / w10 (TDD red)
  //
  // feat-20260529-material-parent-inheritance-read-through-drop-reso
  //
  // Integration tests for material parent-chain inheritance through the
  // extract stage. These tests intentionally FAIL (red) because w11 has not
  // yet wired extract:976 to consume passesOf/paramValueOf — extract still
  // reads asset.passes directly without walking the parent chain.
  //
  // Coverage:
  //   (a) inherit-passes: child with no passes, parent ref — snapshot passes
  //       come from parent (AC-05 core signal)
  //   (b) shoot-76-equivalent: 1 parent + 76 children — extract produces
  //       materials with inherited passes (AC-06: non-empty hull.passes)
  //   (c) paramValues-merge: child key overrides parent, parent-only key
  //       retained (AC-06 shallow-merge)
  //   (d) no-parent-regression: material with no parent — extract still works
  //
  // Anchors: requirements AC-05 (extract inheritance core signal) /
  // AC-06 (76 materials equivalent reproduction); plan-strategy D-6
  // (extract:976-999 transformation scope); research Finding 2 (L976 is the
  // sole direct-read point + dataflow).

  // ── Fixture constants ────────────────────────────────────────────────────────

  const FORWARD_PBR_PASS: MaterialPassDescriptor = {
    name: 'Forward',
    shader: 'forgeax::default-standard-pbr',
  };

  const FORWARD_UNLIT_PASS: MaterialPassDescriptor = {
    name: 'Forward',
    shader: 'forgeax::default-unlit',
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function makeWorldWithComponents(): World {
    const world = new World();
    return world;
  }

  function registerTestMesh(world: World): Handle<'MeshAsset', 'shared'> {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
      kind: 'mesh',
      vertices: new Float32Array([
        0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0,
        1, 0, 0, 0, 0,
      ]),
      indices: new Uint16Array([0, 1, 2]),
      attributes: { position: positions },
      aabb: new Float32Array([0, 0, 0, 1, 1, 1]),
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 36,
          topology: 'triangle-list',
        },
      ],
    });
  }

  // D-19: a material's parent is an embedded AssetGuid resolved through the
  // registry catalogue (registry.lookup), while the material itself is
  // resolved from a column handle via world.sharedRefs. So a parent material is
  // catalogued by GUID (lookupable during the walk) and the child references
  // that GUID; the returned handle is what MeshRenderer.materials carries.
  function registerMaterial(
    world: World,
    assets: AssetRegistry,
    passes: MaterialPassDescriptor[] | undefined,
    parentGuid?: AssetGuid,
    paramValues?: Readonly<Record<string, unknown>>,
  ): { handle: Handle<'MaterialAsset', 'shared'>; guid: AssetGuid } {
    const asset: MaterialAsset = {
      kind: 'material',
      passes,
      paramValues: paramValues ?? {},
    } as MaterialAsset;
    if (parentGuid !== undefined) {
      (asset as { parent: AssetGuid }).parent = parentGuid;
    }
    const guid = AssetGuid.random();
    assets.catalog(guid, asset);
    const handle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', asset);
    return { handle, guid };
  }

  function transformData(
    x: number,
    y: number,
    z: number,
  ): {
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
      posX: x,
      posY: y,
      posZ: z,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    };
  }

  function spawnRenderable(
    world: World,
    meshHandle: Handle<'MeshAsset', 'shared'>,
    matHandle: Handle<'MaterialAsset', 'shared'>,
    x = 0,
    y = 0,
    z = 0,
  ): void {
    world
      .spawn(
        { component: Transform, data: transformData(x, y, z) },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      )
      .unwrap();
  }

  function spawnCamera(world: World): void {
    world
      .spawn(
        {
          component: Transform,
          data: transformData(0, 0, 5),
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

  // ── Tests ────────────────────────────────────────────────────────────────────

  describe('render-system-extract material inheritance (M3 w10, TDD red)', () => {
    // ── (a) AC-05: inherit passes from parent ─────────────────────────────

    it('AC-05 core signal: child no-passes inherits passes from parent via extract', () => {
      const world = makeWorldWithComponents();
      spawnCamera(world);
      const assets = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
      const mesh = registerTestMesh(world);

      const parentMat = registerMaterial(world, assets, [FORWARD_PBR_PASS]);
      const childMat = registerMaterial(world, assets, undefined, parentMat.guid);

      spawnRenderable(world, mesh, childMat.handle);

      propagateTransforms(world);

      const frame = extractFrame(world, assets);
      expect(frame.renderables.length).toBe(1);

      // AC-05: the child's snapshot should inherit passes from the parent,
      // yielding a non-undefined materialShaderId derived from the first pass.
      // RED: with direct asset.passes read, child with undefined passes
      // yields passes=[] -> materialShaderId=undefined.
      const snap = frame.renderables[0]?.material;
      expect(snap).toBeDefined();
      expect(snap?.materialShaderId).toBe('forgeax::default-standard-pbr');
    });

    // ── (b) AC-06: shoot-76 equivalent (1 parent + 76 children) ─────────

    it('AC-06 shoot-76 equivalent: N children inherit from 1 parent', () => {
      const world = makeWorldWithComponents();
      spawnCamera(world);
      const assets = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
      const mesh = registerTestMesh(world);

      const parentMat = registerMaterial(world, assets, [FORWARD_PBR_PASS]);

      const childCount = 76;
      for (let i = 0; i < childCount; i++) {
        const childMat = registerMaterial(world, assets, undefined, parentMat.guid);
        // Spread across Z axis (0 to -60) so all entities stay within
        // the perspective camera frustum (far=100, fov=PI/4 at (0,0,5)).
        spawnRenderable(world, mesh, childMat.handle, 0, 0, -i * 0.8);
      }

      propagateTransforms(world);

      const frame = extractFrame(world, assets);

      // AC-06: all 76 entities should produce renderables with non-empty
      // inherited passes.
      expect(frame.renderables.length).toBe(childCount);

      for (let i = 0; i < childCount; i++) {
        const snap = frame.renderables[i]?.material;
        // RED: each child's snapshot currently has undefined materialShaderId
        // because asset.passes is undefined (direct read, no parent walk).
        expect(snap?.materialShaderId).toBe('forgeax::default-standard-pbr');
      }
    });

    // ── (c) AC-06: paramValues shallow-merge ───────────────────────────

    it('AC-06 paramValues shallow-merge: child overrides parent, parent-only key retained', () => {
      const world = makeWorldWithComponents();
      spawnCamera(world);
      const assets = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
      const mesh = registerTestMesh(world);

      const parentMat = registerMaterial(world, assets, [FORWARD_PBR_PASS], undefined, {
        metallic: 0.3,
        roughness: 0.7,
      });
      const childMat = registerMaterial(world, assets, undefined, parentMat.guid, {
        metallic: 0.9,
      });

      spawnRenderable(world, mesh, childMat.handle);

      propagateTransforms(world);

      const frame = extractFrame(world, assets);
      expect(frame.renderables.length).toBe(1);

      // RED: child's metallic should be 0.9 (child overrides), roughness
      // should be 0.7 (inherited from parent). With direct asset read,
      // roughness comes from child's own paramValues which is { metallic: 0.9 }
      // — roughness defaults to 0.5, not inherited from parent.
      const snap = frame.renderables[0]?.material;
      expect(snap).toBeDefined();
      expect(snap?.metallic).toBe(0.9);
      expect(snap?.roughness).toBe(0.7);
    });

    // ── (d) regression: no-parent path still works ─────────────────────

    it('no-parent regression: material without parent still extracts correctly', () => {
      const world = makeWorldWithComponents();
      spawnCamera(world);
      const assets = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
      const mesh = registerTestMesh(world);

      const mat = registerMaterial(world, assets, [FORWARD_UNLIT_PASS], undefined, {
        baseColor: [0.2, 0.3, 0.4],
      });

      spawnRenderable(world, mesh, mat.handle);

      propagateTransforms(world);

      const frame = extractFrame(world, assets);
      expect(frame.renderables.length).toBe(1);

      const snap = frame.renderables[0]?.material;
      expect(snap).toBeDefined();
      expect(snap?.materialShaderId).toBe('forgeax::default-unlit');
      expect(snap?.baseColor[0]).toBeCloseTo(0.2);
      expect(snap?.baseColor[1]).toBeCloseTo(0.3);
      expect(snap?.baseColor[2]).toBeCloseTo(0.4);
    });
  });
}

// ─── from render-system-extract-sprite-slices.test.ts ───
{
  // render-system-extract-sprite-slices - feat-20260527-sprite-nineslice M2 / w5 (a).
  //
  // TDD-red: SpriteFieldsSnapshot must transparently carry slices + sliceMode
  // from MaterialAsset.paramValues through extract into the dispatch snapshot.
  //
  // Three sentinel states (plan-strategy §D-3):
  //   - undefined slices: defaults to [0, 0, 0, 0] / sliceMode = 0
  //   - stretch:          [0.25, 0.25, 0.25, 0.25] + sliceMode = 0
  //   - tile:             [0.25, 0.25, 0.25, 0.25] + sliceMode = 1
  //                       -> snapshot.slices = [0.25, 0.25, 0.25, -0.25]
  //                          (sentinel encoding: w taken negative on tile mode;
  //                           shader uses abs() to recover the magnitude).
  //
  // Coverage:
  //   (1) sprite material with no slices in paramValues -> snapshot.slices ===
  //       [0, 0, 0, 0] and snapshot.sliceMode === 0
  //   (2) sprite with slices=[0.25,0.25,0.25,0.25] sliceMode=0 -> verbatim
  //   (3) sprite with slices=[0.25,0.25,0.25,0.25] sliceMode=1 -> snapshot has
  //       slices.w taken negative (sentinel), sliceMode === 1
  //
  // RED before w10 wires extract sprite branch to read these two paramValues.

  function makeShaderRegistryWithSprite(): ShaderRegistry {
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
        { name: 'texture', type: 'texture2d' },
        { name: 'sampler', type: 'sampler', default: null },
        { name: 'region', type: 'vec4', default: [0.0, 0.0, 1.0, 1.0] },
        { name: 'pivot', type: 'vec2', default: [0.5, 0.5] },
        { name: 'flipX', type: 'f32', default: 0.0 },
        { name: 'flipY', type: 'f32', default: 0.0 },
        { name: 'slices', type: 'vec4', default: [0.0, 0.0, 0.0, 0.0] },
        { name: 'sliceMode', type: 'f32', default: 0.0 },
      ],
    });
    return sr;
  }

  const SPRITE_PASS: MaterialPassDescriptor = {
    name: 'Sprite',
    shader: 'forgeax::sprite',
    queue: 3000,
  };

  function identity() {
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

  function registerSpriteMesh(world: World): Handle<'MeshAsset', 'shared'> {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
      kind: 'mesh',
      vertices: new Float32Array([
        0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0,
        1, 0, 0, 0, 0,
      ]),
      indices: new Uint16Array([0, 1, 2]),
      attributes: { position: positions },
      aabb: new Float32Array([0, 0, 0, 1, 1, 1]),
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 36,
          topology: 'triangle-list',
        },
      ],
    });
  }

  function spawnSpriteScene(paramValues: Record<string, unknown>): {
    world: World;
    assets: AssetRegistry;
  } {
    const world = new World();
    const assets = new AssetRegistry(makeShaderRegistryWithSprite(), createDefaultLoaderRegistry());
    const mesh = registerSpriteMesh(world);
    const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [SPRITE_PASS],
      paramValues,
    } as MaterialAsset);
    // Spawn a camera so extract has a viewport.
    world
      .spawn(
        { component: Transform, data: { ...identity(), posZ: 5 } },
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
    // Spawn sprite entity.
    world
      .spawn(
        { component: Transform, data: identity() },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      )
      .unwrap();
    propagateTransforms(world);
    return { world, assets };
  }

  describe('render-system-extract sprite slices/sliceMode pass-through (M2 / w5a)', () => {
    it('(1) no slices in paramValues -> snapshot.slices=[0,0,0,0] sliceMode=0', () => {
      const { world, assets } = spawnSpriteScene({});
      const frame = extractFrame(world, assets);
      const renderable = frame.renderables.find((r) => r.material.shadingModel === 'sprite');
      expect(renderable).toBeDefined();
      const sf = renderable?.material.spriteFields as
        | { slices?: readonly [number, number, number, number]; sliceMode?: number }
        | undefined;
      expect(sf).toBeDefined();
      expect(sf?.slices).toEqual([0, 0, 0, 0]);
      expect(sf?.sliceMode).toBe(0);
    });

    it('(2) stretch slices [0.25,0.25,0.25,0.25] sliceMode=0 -> snapshot verbatim', () => {
      const { world, assets } = spawnSpriteScene({
        slices: [0.25, 0.25, 0.25, 0.25],
        sliceMode: 0,
      });
      const frame = extractFrame(world, assets);
      const renderable = frame.renderables.find((r) => r.material.shadingModel === 'sprite');
      expect(renderable).toBeDefined();
      const sf = renderable?.material.spriteFields as
        | { slices?: readonly [number, number, number, number]; sliceMode?: number }
        | undefined;
      expect(sf?.slices).toEqual([0.25, 0.25, 0.25, 0.25]);
      expect(sf?.sliceMode).toBe(0);
    });

    it('(3) tile sliceMode=1 -> snapshot.slices.w taken negative (sentinel)', () => {
      const { world, assets } = spawnSpriteScene({
        slices: [0.25, 0.25, 0.25, 0.25],
        sliceMode: 1,
      });
      const frame = extractFrame(world, assets);
      const renderable = frame.renderables.find((r) => r.material.shadingModel === 'sprite');
      expect(renderable).toBeDefined();
      const sf = renderable?.material.spriteFields as
        | { slices?: readonly [number, number, number, number]; sliceMode?: number }
        | undefined;
      expect(sf?.slices?.[0]).toBe(0.25);
      expect(sf?.slices?.[1]).toBe(0.25);
      expect(sf?.slices?.[2]).toBe(0.25);
      // Sentinel encoding: D-3 .w negative on tile mode (shader abs() recovers).
      expect(sf?.slices?.[3]).toBe(-0.25);
      expect(sf?.sliceMode).toBe(1);
    });
  });
}

// ─── from render-system-clear-camera.test.ts ───
{
  // @forgeax/engine-runtime/__tests__/render-system-clear-camera.test.ts -
  // feat-20260608-create-app-param-surface-trim / M1 / TASK-002.
  //
  // Asserts the clear-color flow from a Camera entity's SoA columns into
  // the per-frame CameraSnapshot the record stage reads. The extract stage
  // is the boundary between the ECS column-views and the record stage's
  // GPU recording calls; once clearR/G/B/A is on the snapshot, the record
  // stage can drop `internals.clearColor ?? [0.06, 0.06, 0.08, 1.0]` and
  // read directly from `cameras[0]` (first-archetype-hit per
  // requirements §OOS-2).
  //
  // Plan-strategy §2 D-1 q6-A locks the 4 x f32 scalar idiom (matches
  // fov / aspect / near / far / tonemap / antialias / bloom* — every
  // other Camera column is also a scalar f32, so the SoA read pattern
  // is identical: one column index per field).
  //
  // AC-03 asserts the boundary: if the snapshot does not surface
  // clearR/G/B/A, the record stage cannot read them without re-walking
  // the ECS, defeating the SoA pipeline.

  function identityTransform() {
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

  function spawnCamera(
    world: World,
    cam: {
      clearR: number;
      clearG: number;
      clearB: number;
      clearA: number;
    },
  ) {
    world
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 1,
            near: 0.1,
            far: 100,
            clearR: cam.clearR,
            clearG: cam.clearG,
            clearB: cam.clearB,
            clearA: cam.clearA,
          },
        },
      )
      .unwrap();
  }

  describe('render-system-extract clear-color SoA flow (TASK-002)', () => {
    it('CameraSnapshot surfaces clearR/G/B/A read straight from Camera SoA columns', () => {
      const world = new World();
      spawnCamera(world, { clearR: 0.25, clearG: 0.5, clearB: 0.75, clearA: 1.0 });
      propagateTransforms(world);
      const frame = extractFrame(world);
      expect(frame.cameras.length).toBe(1);
      const cam = frame.cameras[0];
      expect(cam).toBeDefined();
      if (!cam) return;
      expect(cam.clearR).toBeCloseTo(0.25, 6);
      expect(cam.clearG).toBeCloseTo(0.5, 6);
      expect(cam.clearB).toBeCloseTo(0.75, 6);
      expect(cam.clearA).toBeCloseTo(1.0, 6);
    });

    it('first-archetype-hit semantics: when N>1 cameras carry distinct clear, snapshot[0] is the first one', () => {
      const world = new World();
      spawnCamera(world, { clearR: 0.1, clearG: 0.2, clearB: 0.3, clearA: 1.0 });
      spawnCamera(world, { clearR: 0.9, clearG: 0.8, clearB: 0.7, clearA: 1.0 });
      propagateTransforms(world);
      const frame = extractFrame(world);
      expect(frame.cameras.length).toBeGreaterThanOrEqual(1);
      const cam0 = frame.cameras[0];
      expect(cam0).toBeDefined();
      if (!cam0) return;
      // The record stage uses cameras[0] (first-archetype-hit) per OOS-2;
      // assert the snapshot ordering preserves the spawn order so the
      // record stage's cameras[0] read is deterministic.
      expect(cam0.clearR).toBeCloseTo(0.1, 6);
      expect(cam0.clearG).toBeCloseTo(0.2, 6);
      expect(cam0.clearB).toBeCloseTo(0.3, 6);
    });

    it('Camera spawned without explicit clearR/G/B/A defaults to opaque black [0,0,0,1]', () => {
      const world = new World();
      world
        .spawn(
          { component: Transform, data: identityTransform() },
          {
            component: Camera,
            data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 },
          },
        )
        .unwrap();
      propagateTransforms(world);
      const frame = extractFrame(world);
      const cam = frame.cameras[0];
      expect(cam).toBeDefined();
      if (!cam) return;
      expect(cam.clearR).toBe(0);
      expect(cam.clearG).toBe(0);
      expect(cam.clearB).toBe(0);
      expect(cam.clearA).toBe(1);
    });
  });
}

// ─── M2 / w3: extract MaterialSnapshot carries a 4th texture (heightTexture) ───
//
// feat-20260621-learn-render-5-5-parallax-mapping-demo-aligned-wit M2 / w3
//
// A custom parallax shader declares heightTexture (the 4th user-region texture).
// The extract stage must iterate derive(paramSchema).textureFieldNames so the
// heightTexture handle flows into the MaterialSnapshot. Today extract hardcodes
// the 3 standard texture fields, so the 4th texture's handle is silently
// dropped — this test is RED until w7 wires the iteration. Post-w7 the snapshot
// carries the handle under MaterialSnapshot.textureHandles (a field-name keyed
// map that holds every declared user-region texture handle).
{
  function makeShaderRegistryWithParallax(): ShaderRegistry {
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
    sr.registerMaterialShader('learn-render::5-5-parallax', {
      source: 'fn main() {}',
      paramSchema: [
        { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
        { name: 'metallic', type: 'f32', default: 0.0 },
        { name: 'roughness', type: 'f32', default: 0.5 },
        { name: 'heightScale', type: 'f32', default: 0.1 },
        { name: 'algoMode', type: 'f32', default: 0.0 },
        { name: 'baseColorTexture', type: 'texture2d' },
        { name: 'metallicRoughnessTexture', type: 'texture2d' },
        { name: 'normalTexture', type: 'texture2d' },
        { name: 'heightTexture', type: 'texture2d' },
      ],
    });
    return sr;
  }

  const PARALLAX_PASS: MaterialPassDescriptor = {
    name: 'Forward',
    shader: 'learn-render::5-5-parallax',
  };

  function identityTx() {
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

  function registerQuadMesh(world: World): Handle<'MeshAsset', 'shared'> {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
      kind: 'mesh',
      vertices: new Float32Array([
        0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0,
        1, 0, 0, 0, 0,
      ]),
      indices: new Uint16Array([0, 1, 2]),
      attributes: { position: positions },
      aabb: new Float32Array([0, 0, 0, 1, 1, 1]),
      submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 36, topology: 'triangle-list' }],
    });
  }

  function makeTextureHandle(world: World): Handle<'TextureAsset', 'shared'> {
    return world.allocSharedRef<'TextureAsset', import('@forgeax/engine-types').TextureAsset>(
      'TextureAsset',
      {
        kind: 'texture',
        width: 1,
        height: 1,
        format: 'rgba8unorm',
        data: new Uint8Array([255, 255, 255, 255]),
        colorSpace: 'linear',
        mipmap: false,
      },
    );
  }

  describe('render-system-extract heightTexture (4th texture) snapshot pass-through (M2 w3)', () => {
    it('MaterialSnapshot.textureHandles carries heightTexture handle (non-undefined, matches input)', () => {
      const world = new World();
      const assets = new AssetRegistry(
        makeShaderRegistryWithParallax(),
        createDefaultLoaderRegistry(),
      );
      const mesh = registerQuadMesh(world);

      const baseColorHandle = makeTextureHandle(world);
      const normalHandle = makeTextureHandle(world);
      const heightHandle = makeTextureHandle(world);

      const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
        kind: 'material',
        passes: [PARALLAX_PASS],
        paramValues: {
          baseColor: [1, 1, 1, 1],
          heightScale: 0.1,
          algoMode: 0,
          baseColorTexture: baseColorHandle,
          normalTexture: normalHandle,
          heightTexture: heightHandle,
        },
      } as MaterialAsset);

      world
        .spawn(
          { component: Transform, data: { ...identityTx(), posZ: 5 } },
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
      world
        .spawn(
          { component: Transform, data: identityTx() },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [matHandle] } },
        )
        .unwrap();
      propagateTransforms(world);

      const frame = extractFrame(world, assets);
      const renderable = frame.renderables.find(
        (r) => r.material.materialShaderId === 'learn-render::5-5-parallax',
      );
      expect(renderable).toBeDefined();
      // The 4th texture handle must survive extract under the field-name keyed
      // map MaterialSnapshot.textureHandles (added + populated by w7). Read via
      // a structural cast so this test compiles in the red phase before the
      // field lands; the runtime assertion stays RED until w7 wires extract.
      const snap = renderable?.material as
        | {
            readonly textureHandles?: ReadonlyMap<string, Handle<'TextureAsset', 'shared'>>;
            readonly materialShaderId?: string;
          }
        | undefined;
      const heightFromSnap = snap?.textureHandles?.get('heightTexture');
      expect(heightFromSnap).toBeDefined();
      expect(heightFromSnap).toBe(heightHandle);
      // The standard fields also land in the same map (single SSOT path).
      expect(snap?.textureHandles?.get('baseColorTexture')).toBe(baseColorHandle);
      expect(snap?.textureHandles?.get('normalTexture')).toBe(normalHandle);
    });
  });
}
