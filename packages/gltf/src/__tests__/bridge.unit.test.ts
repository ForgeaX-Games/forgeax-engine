// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=6):
//   - packages/gltf/src/__tests__/bridge-name-instances.test.ts
//   - packages/gltf/src/__tests__/bridge-recursive.test.ts
//   - packages/gltf/src/__tests__/bridge-register-integration.test.ts
//   - packages/gltf/src/__tests__/bridge-snapshot.test.ts
//   - packages/gltf/test/bridge-multi-prim.test.ts
//   - packages/gltf/test/bridge-recurse-and-transform.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { AssetRegistry, createDefaultLoaderRegistry } from '@forgeax/engine-runtime';
import type { Handle, MaterialAsset, ParamSchemaEntry, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { gltfDocToSceneAsset, toMaterialAsset } from '../bridge.js';
import type { GltfDoc, GltfMaterialIr, GltfMeshIr } from '../parse-gltf.js';

function fakeMeshHandle(id: number): Handle<'MeshAsset', 'shared'> {
  return id as unknown as Handle<'MeshAsset', 'shared'>;
}

function fakeMaterialHandle(id: number): Handle<'MaterialAsset', 'shared'> {
  return id as unknown as Handle<'MaterialAsset', 'shared'>;
}

const FAKE_TEXTURE_HANDLE = 1 as unknown as Handle<'TextureAsset', 'shared'>;
const FAKE_SAMPLER_HANDLE = 2 as unknown as Handle<'SamplerAsset', 'shared'>;

const PBR_FORWARD_SCHEMA: ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
  { name: 'metallic', type: 'f32', default: 0.0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'sampler', type: 'sampler' },
];

function makeBridgeTestShaderRegistry() {
  return {
    lookupMaterialShader(identifier: string) {
      if (identifier === 'forgeax::default-standard-pbr') {
        return {
          ok: true as const,
          value: { source: '', paramSchema: PBR_FORWARD_SCHEMA },
        };
      }
      return { ok: false as const, error: { code: 'shader-not-found' } };
    },
  };
}

const STANDARD_MATERIAL: GltfMaterialIr = {
  name: 'TestMat',
  baseColorFactor: [0.8, 0.2, 0.1, 1.0],
  metallicFactor: 0.5,
  roughnessFactor: 0.7,
  baseColorTexture: 0,
};

{
  // ─── from bridge-name-instances.test.ts ───

  const baseDoc = (): GltfDoc => ({
    meshes: [
      {
        name: 'MeshFoo',
        positions: new Float32Array([0, 0, 0]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 0,
      },
    ],
    materials: [
      {
        name: 'MatFoo',
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 1.0,
        roughnessFactor: 1.0,
      },
    ],
    nodes: [
      {
        name: 'InstancedBox',
        transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        meshIndex: 0,
        skinIndex: null,
        camera: null,
        children: [],
        instancing: { count: 4, transforms: new Float32Array(4 * 16) },
      },
    ],
    scenes: [{ name: 'SceneFoo', nodes: [0] }],
    textures: undefined,
    images: undefined,
    samplers: undefined,
    skeletons: [],
    animationClips: [],
    defaultSceneIndex: 0,
    diagnostics: {
      nodeNames: ['InstancedBox'],
      unsupportedExtensions: [],
      matrixTrsCoexistNodes: [],
    },
  });

  const ctx = {
    meshHandles: new Map([[0, fakeMeshHandle(1)]]),
    materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
  };

  describe('bridge-name-instances.test.ts', () => {
    describe('bridge.ts Name attachment (M4 w11/w12)', () => {
      it('AC-06 attaches Name component when node.name is non-empty', () => {
        const scene = gltfDocToSceneAsset(baseDoc(), ctx);
        const node = scene.entities[0];
        expect(node?.components.Name).toEqual({ value: 'InstancedBox' });
      });

      it('AC-07 omits Name when node.name is undefined', () => {
        const doc: GltfDoc = {
          ...baseDoc(),
          nodes: [{ ...baseDoc().nodes[0], name: undefined } as never],
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        const node = scene.entities[0];
        expect(node?.components.Name).toBeUndefined();
      });

      it('AC-07 omits Name when node.name is empty string', () => {
        const doc: GltfDoc = {
          ...baseDoc(),
          nodes: [{ ...baseDoc().nodes[0], name: '' } as never],
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        const node = scene.entities[0];
        expect(node?.components.Name).toBeUndefined();
      });

      it('AC-08 mesh / material / scene names do NOT route into Name on the node', () => {
        const scene = gltfDocToSceneAsset(baseDoc(), ctx);
        for (const node of scene.entities) {
          const name = node.components.Name;
          if (name !== undefined) {
            expect(name.value).not.toBe('MeshFoo');
            expect(name.value).not.toBe('MatFoo');
            expect(name.value).not.toBe('SceneFoo');
          }
        }
      });
    });

    describe('bridge.ts Instances attachment (M4 w11/w12)', () => {
      it('AC-10 attaches Instances with transforms.length === N*16', () => {
        const scene = gltfDocToSceneAsset(baseDoc(), ctx);
        const node = scene.entities[0];
        expect(node?.components.Instances).toBeDefined();
        const inst = node?.components.Instances;
        if (inst !== undefined) {
          const transforms = inst.transforms as Float32Array;
          expect(transforms.length).toBe(4 * 16);
        }
      });

      it('AC-10 transforms identity is byte-equal to importer composed buffer', () => {
        const seed = new Float32Array(4 * 16);
        for (let i = 0; i < seed.length; i++) seed[i] = i;
        const doc: GltfDoc = {
          ...baseDoc(),
          nodes: [
            {
              ...baseDoc().nodes[0],
              instancing: { count: 4, transforms: seed },
            } as never,
          ],
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        const transforms = scene.entities[0]?.components.Instances?.transforms as Float32Array;
        for (let i = 0; i < seed.length; i++) {
          expect(transforms[i]).toBe(seed[i]);
        }
      });

      it('AC-11 1 entity carries MeshFilter+MeshRenderer+Instances (no flatten)', () => {
        const scene = gltfDocToSceneAsset(baseDoc(), ctx);
        const candidates = scene.entities.filter(
          (n) =>
            n.components.MeshFilter !== undefined &&
            n.components.MeshRenderer !== undefined &&
            n.components.Instances !== undefined,
        );
        expect(candidates.length).toBe(1);
      });

      it('omits Instances when node has no instancing IR', () => {
        const doc: GltfDoc = {
          ...baseDoc(),
          nodes: [{ ...baseDoc().nodes[0], instancing: undefined } as never],
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(scene.entities[0]?.components.Instances).toBeUndefined();
      });
    });
  });
}

{
  // ─── from bridge-recursive.test.ts ───

  function node(
    overrides: Partial<{
      meshIndex: number | null;
      children: number[];
      name: string;
    }> = {},
  ): GltfDoc['nodes'][number] {
    return {
      transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      meshIndex: overrides.meshIndex ?? null,
      skinIndex: null,
      camera: null,
      children: overrides.children ?? [],
      ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    };
  }

  const twoLevelDoc: GltfDoc = {
    meshes: [
      {
        name: 'M0',
        positions: new Float32Array([0, 0, 0]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 0,
      },
      {
        name: 'M1',
        positions: new Float32Array([1, 1, 1]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 1,
      },
    ],
    materials: [{ baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }],
    nodes: [
      node({ meshIndex: 0, children: [1], name: 'root' }),
      node({ meshIndex: 1, children: [], name: 'child' }),
    ],
    scenes: [{ name: 'S', nodes: [0] }],
    textures: undefined,
    images: undefined,
    samplers: undefined,
    skeletons: [],
    animationClips: [],
    defaultSceneIndex: 0,
    diagnostics: {
      nodeNames: ['root', 'child'],
      unsupportedExtensions: [],
      matrixTrsCoexistNodes: [],
    },
  };

  const threeLevelDoc: GltfDoc = {
    meshes: [
      {
        name: 'M0',
        positions: new Float32Array([0, 0, 0]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 0,
      },
      {
        name: 'M1',
        positions: new Float32Array([1, 1, 1]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 1,
      },
      {
        name: 'M2',
        positions: new Float32Array([2, 2, 2]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 2,
      },
    ],
    materials: [{ baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }],
    nodes: [
      node({ meshIndex: 0, children: [1], name: 'root' }),
      node({ meshIndex: 1, children: [2], name: 'middle' }),
      node({ meshIndex: 2, children: [], name: 'grandchild' }),
    ],
    scenes: [{ name: 'S', nodes: [0] }],
    textures: undefined,
    images: undefined,
    samplers: undefined,
    skeletons: [],
    animationClips: [],
    defaultSceneIndex: 0,
    diagnostics: {
      nodeNames: ['root', 'middle', 'grandchild'],
      unsupportedExtensions: [],
      matrixTrsCoexistNodes: [],
    },
  };

  describe('bridge-recursive.test.ts', () => {
    describe('gltfDocToSceneAsset DFS recursion (w24)', () => {
      it('visits child nodes (two-level hierarchy)', () => {
        const ctx = {
          meshHandles: new Map([
            [0, fakeMeshHandle(10)],
            [1, fakeMeshHandle(11)],
          ]),
          materialHandles: new Map([[0, fakeMaterialHandle(20)]]),
        };
        const scene: SceneAsset = gltfDocToSceneAsset(twoLevelDoc, ctx);
        expect(scene.entities.length).toBe(2);
        expect(scene.entities[0]?.components.MeshFilter?.assetHandle).toBe(10);
        expect(scene.entities[1]?.components.MeshFilter?.assetHandle).toBe(11);
        expect(scene.entities[0]?.localId).toBe(0);
        expect(scene.entities[1]?.localId).toBe(1);
      });

      it('visits full three-level hierarchy in DFS order', () => {
        const ctx = {
          meshHandles: new Map([
            [0, fakeMeshHandle(10)],
            [1, fakeMeshHandle(11)],
            [2, fakeMeshHandle(12)],
          ]),
          materialHandles: new Map([[0, fakeMaterialHandle(20)]]),
        };
        const scene: SceneAsset = gltfDocToSceneAsset(threeLevelDoc, ctx);
        expect(scene.entities.length).toBe(3);
        expect(scene.entities[0]?.localId).toBe(0);
        expect(scene.entities[1]?.localId).toBe(1);
        expect(scene.entities[2]?.localId).toBe(2);
      });

      it('includes child entities with Name components from node.name', () => {
        const ctx = {
          meshHandles: new Map([
            [0, fakeMeshHandle(10)],
            [1, fakeMeshHandle(11)],
          ]),
          materialHandles: new Map([[0, fakeMaterialHandle(20)]]),
        };
        const scene: SceneAsset = gltfDocToSceneAsset(twoLevelDoc, ctx);
        expect(scene.entities[0]?.components.Name?.value).toBe('root');
        expect(scene.entities[1]?.components.Name?.value).toBe('child');
      });
    });
  });
}

{
  // ─── from bridge-register-integration.test.ts ───

  describe('bridge-register-integration.test.ts', () => {
    describe('toMaterialAsset -> registerMaterialAsset integration (pass-based)', () => {
      it('PBR material with full ctx produces pass-based MaterialAsset', () => {
        const textureHandles = new Map([[0, FAKE_TEXTURE_HANDLE]]);
        const samplerHandles = new Map([[0, FAKE_SAMPLER_HANDLE]]);

        const asset = toMaterialAsset(STANDARD_MATERIAL, {
          textureHandles,
          samplerHandles,
        });

        expect(asset.kind).toBe('material');
        expect(asset.passes).toBeDefined();
        expect(asset.passes?.[0]?.shader).toBe('forgeax::default-standard-pbr');
        expect(asset.passes?.[0]?.name).toBe('Forward');
        expect(asset.paramValues?.baseColorTexture).toBe(FAKE_TEXTURE_HANDLE);
        expect(asset.paramValues?.sampler).toBe(FAKE_SAMPLER_HANDLE);
        expect(asset.paramValues?.metallic).toBe(0.5);
        expect(asset.paramValues?.roughness).toBe(0.7);
      });

      it('standard material without textures produces paramValues with null-defaulted texture params', () => {
        const { baseColorTexture: _, ...rest } = STANDARD_MATERIAL;
        const mat: GltfMaterialIr = rest;
        const samplerHandles = new Map([[0, FAKE_SAMPLER_HANDLE]]);

        const asset = toMaterialAsset(mat, {
          textureHandles: new Map(),
          samplerHandles,
        });

        expect(asset.paramValues?.baseColorTexture).toBeUndefined();
        expect(asset.paramValues?.sampler).toBe(FAKE_SAMPLER_HANDLE);
      });

      it('PBR material validates via catalog with pass-based shape', () => {
        const reg = new AssetRegistry(
          // biome-ignore lint/suspicious/noExplicitAny: mock ShaderRegistry with only lookupMaterialShader
          makeBridgeTestShaderRegistry() as any,
          createDefaultLoaderRegistry(),
        );

        const asset = toMaterialAsset(STANDARD_MATERIAL, {
          textureHandles: new Map(),
          samplerHandles: new Map([[0, FAKE_SAMPLER_HANDLE]]),
        });
        // feat-20260614 M8 (D-17): register() deleted; catalog(guid, asset)
        // runs the same MaterialAsset pass/shader validation.
        const result = reg.catalog<MaterialAsset>(
          reg.parseGuid('00000000-0000-4000-8000-000000000a02'),
          asset,
        );

        if (!result.ok) {
          expect.fail(`catalog failed: ${result.error.expected} — ${result.error.hint}`);
        }
      });

      it('PBR material baseColor is RGB (3 elements), not RGBA', () => {
        const samplerHandles = new Map([[0, FAKE_SAMPLER_HANDLE]]);
        const asset = toMaterialAsset(STANDARD_MATERIAL, {
          textureHandles: new Map(),
          samplerHandles,
        });

        const baseColor = asset.paramValues?.baseColor as number[];
        expect(baseColor).toHaveLength(3);
        expect(baseColor).toEqual([0.8, 0.2, 0.1]);
      });
    });
  });
}

{
  // ─── from bridge-snapshot.test.ts ───

  const helloGltfDoc: GltfDoc = {
    meshes: [
      {
        name: 'Box',
        positions: new Float32Array([0, 0, 0]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 0,
      },
    ],
    materials: [
      {
        name: 'BoxMaterial',
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 1.0,
        roughnessFactor: 1.0,
      },
    ],
    nodes: [
      {
        name: 'BoxNode',
        transform: {
          translation: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        meshIndex: 0,
        skinIndex: null,
        camera: null,
        children: [],
      },
      {
        name: 'CameraNode',
        transform: {
          translation: [0, 0, 3],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        meshIndex: null,
        skinIndex: null,
        camera: 0,
        children: [],
      },
    ],
    scenes: [{ name: 'Scene', nodes: [0, 1] }],
    textures: undefined,
    images: undefined,
    samplers: undefined,
    skeletons: [],
    animationClips: [],
    defaultSceneIndex: 0,
    diagnostics: {
      nodeNames: ['BoxNode', 'CameraNode'],
      unsupportedExtensions: [],
      matrixTrsCoexistNodes: [],
    },
  };

  describe('bridge-snapshot.test.ts', () => {
    describe('gltfDocToSceneAsset (M3 w8/w9)', () => {
      it('matches the legacy hello-gltf inline-impl POD output', () => {
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(1)]]),
          materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
        };
        const scene: SceneAsset = gltfDocToSceneAsset(helloGltfDoc, ctx);
        expect(scene.kind).toBe('scene');
        expect(scene.entities.length).toBeGreaterThanOrEqual(1);
        const meshNode = scene.entities[0];
        expect(meshNode?.components.MeshFilter?.assetHandle).toBe(1);
        const renderer = meshNode?.components.MeshRenderer;
        expect(renderer).toBeDefined();
        if (renderer !== undefined) {
          const materials = renderer.materials as unknown[];
          expect(Array.isArray(materials)).toBe(true);
          expect(materials.length).toBeGreaterThanOrEqual(1);
          expect(materials[0]).toBe(7);
        }
        expect(meshNode?.components.Transform).toBeDefined();
      });

      it('attaches Camera component when a node references a camera (via GltfNodeIr.camera)', () => {
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(1)]]),
          materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
        };
        const scene = gltfDocToSceneAsset(helloGltfDoc, ctx);
        const cameraNode = scene.entities.find((n) => n.components.Camera !== undefined);
        expect(cameraNode).toBeDefined();
      });
    });
  });
}

{
  // ─── from bridge-multi-prim.test.ts ───

  describe('bridge-multi-prim.test.ts', () => {
    describe('bridge.ts B1 multi-primitive merge (M3 w14)', () => {
      it('2-prim glTF mesh produces 1 entity (meshHandles keyed by glTF mesh index)', () => {
        const mesh0Prim0: GltfMeshIr = {
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          indices: new Uint16Array([0, 1, 2]),
          materialIndex: 0,
          meshIndex: 0,
        };
        const mesh0Prim1: GltfMeshIr = {
          positions: new Float32Array([0, 0, 0, -1, 0, 0, 0, -1, 0]),
          indices: new Uint16Array([0, 1, 2]),
          materialIndex: 1,
          meshIndex: 0,
        };
        const doc: GltfDoc = {
          meshes: [mesh0Prim0, mesh0Prim1],
          materials: [
            { baseColorFactor: [1, 0, 0, 1], metallicFactor: 1, roughnessFactor: 1 },
            { baseColorFactor: [0, 0, 1, 1], metallicFactor: 1, roughnessFactor: 1 },
          ],
          nodes: [
            {
              name: 'MeshNode',
              transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [],
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['MeshNode'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(10)]]),
          materialHandles: new Map([
            [0, fakeMaterialHandle(20)],
            [1, fakeMaterialHandle(21)],
          ]),
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(scene.entities.length).toBe(1);

        const entityNode = scene.entities[0];
        expect(entityNode).toBeDefined();
        expect(entityNode?.components.MeshFilter?.assetHandle).toBe(10);
        expect(entityNode?.components.MeshRenderer).toBeDefined();
      });

      it('single-prim glTF produces 1 entity with 1 material (backward compatible)', () => {
        const doc: GltfDoc = {
          meshes: [
            {
              name: 'Box',
              positions: new Float32Array([0, 0, 0]),
              indices: new Uint16Array([0]),
              materialIndex: 0,
              meshIndex: 0,
            },
          ],
          materials: [{ baseColorFactor: [1, 0, 0, 1], metallicFactor: 1, roughnessFactor: 1 }],
          nodes: [
            {
              name: 'BoxNode',
              transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [],
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['BoxNode'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(1)]]),
          materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(scene.entities.length).toBe(1);
        const node = scene.entities[0];
        expect(node?.components.MeshFilter?.assetHandle).toBe(1);
        expect(node?.components.MeshRenderer).toBeDefined();
      });

      it('transform-only node (no mesh, no camera) produces entity with Transform only', () => {
        const doc: GltfDoc = {
          meshes: [
            {
              positions: new Float32Array([0, 0, 0]),
              indices: new Uint16Array([0]),
              materialIndex: 0,
              meshIndex: 0,
            },
          ],
          materials: [{ baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }],
          nodes: [
            {
              name: 'TransformNode',
              transform: { translation: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [2, 2, 2] },
              meshIndex: null,
              skinIndex: null,
              camera: null,
              children: [],
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['TransformNode'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map(),
          materialHandles: new Map(),
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(scene.entities.length).toBe(1);
        const node = scene.entities[0];
        expect(node?.components.Transform).toBeDefined();
        expect(node?.components.MeshFilter).toBeUndefined();
        expect(node?.components.MeshRenderer).toBeUndefined();
      });

      it('multi glTF-mesh document: each node materials filtered by node.meshIndex (verify-r1 charter-defect fix)', () => {
        const m0p0: GltfMeshIr = {
          positions: new Float32Array([0, 0, 0]),
          indices: new Uint16Array([0]),
          materialIndex: 0,
          meshIndex: 0,
        };
        const m0p1: GltfMeshIr = {
          positions: new Float32Array([0, 0, 0]),
          indices: new Uint16Array([0]),
          materialIndex: 1,
          meshIndex: 0,
        };
        const m1p0: GltfMeshIr = {
          positions: new Float32Array([0, 0, 0]),
          indices: new Uint16Array([0]),
          materialIndex: 2,
          meshIndex: 1,
        };
        const doc: GltfDoc = {
          meshes: [m0p0, m0p1, m1p0],
          materials: [
            { baseColorFactor: [1, 0, 0, 1], metallicFactor: 1, roughnessFactor: 1 },
            { baseColorFactor: [0, 1, 0, 1], metallicFactor: 1, roughnessFactor: 1 },
            { baseColorFactor: [0, 0, 1, 1], metallicFactor: 1, roughnessFactor: 1 },
          ],
          nodes: [
            {
              name: 'NodeA',
              transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [],
            },
            {
              name: 'NodeB',
              transform: { translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 1,
              skinIndex: null,
              camera: null,
              children: [],
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0, 1] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['NodeA', 'NodeB'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map([
            [0, fakeMeshHandle(10)],
            [1, fakeMeshHandle(11)],
          ]),
          materialHandles: new Map([
            [0, fakeMaterialHandle(20)],
            [1, fakeMaterialHandle(21)],
            [2, fakeMaterialHandle(22)],
          ]),
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(scene.entities.length).toBe(2);
        const nodeA = scene.entities.find((n) => n.components.Name?.value === 'NodeA');
        const nodeB = scene.entities.find((n) => n.components.Name?.value === 'NodeB');
        expect(nodeA?.components.MeshRenderer?.materials).toHaveLength(2);
        expect(nodeB?.components.MeshRenderer?.materials).toHaveLength(1);
      });
    });
  });
}

{
  // ─── from bridge-recurse-and-transform.test.ts ───

  describe('bridge-recurse-and-transform.test.ts', () => {
    describe('bridge.ts B2 child recursion (M3 w14)', () => {
      it('3-level hierarchy (root->child->grandchild) produces 3 entities with ChildOf links', () => {
        const doc: GltfDoc = {
          meshes: [
            {
              positions: new Float32Array([0, 0, 0]),
              indices: new Uint16Array([0]),
              materialIndex: 0,
              meshIndex: 0,
            },
          ],
          materials: [{ baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }],
          nodes: [
            {
              name: 'Root',
              transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [1],
            },
            {
              name: 'Child',
              transform: { translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: null,
              skinIndex: null,
              camera: null,
              children: [2],
            },
            {
              name: 'Grandchild',
              transform: { translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [],
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['Root', 'Child', 'Grandchild'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(1)]]),
          materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(scene.entities.length).toBe(3);

        const rootNode = scene.entities.find((n) => n.components.Name?.value === 'Root');
        const childNode = scene.entities.find((n) => n.components.Name?.value === 'Child');
        const grandchildNode = scene.entities.find(
          (n) => n.components.Name?.value === 'Grandchild',
        );
        expect(rootNode).toBeDefined();
        expect(childNode).toBeDefined();
        expect(grandchildNode).toBeDefined();

        expect(rootNode?.components.MeshFilter).toBeDefined();
        expect(childNode?.components.MeshFilter).toBeUndefined();
        expect(grandchildNode?.components.MeshFilter).toBeDefined();

        expect(childNode?.components.ChildOf?.parent).toBe(rootNode?.localId);
        expect(grandchildNode?.components.ChildOf?.parent).toBe(childNode?.localId);
      });
    });

    describe('bridge.ts B3 transform accumulation (M3 w14)', () => {
      // bug-20260613: bridge writes LOCAL TRS into Transform; ChildOf is also
      // emitted, so propagateTransforms is the single accumulation path.
      // Writing world TRS here would double-bake every child node.
      it('child Transform mirrors local TRS (propagateTransforms accumulates world)', () => {
        const doc: GltfDoc = {
          meshes: [
            {
              positions: new Float32Array([0, 0, 0]),
              indices: new Uint16Array([0]),
              materialIndex: 0,
              meshIndex: 0,
            },
          ],
          materials: [{ baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }],
          nodes: [
            {
              name: 'Parent',
              transform: { translation: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [1],
            },
            {
              name: 'Child',
              transform: { translation: [2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [],
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['Parent', 'Child'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(1)]]),
          materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(scene.entities.length).toBe(2);

        const childNode = scene.entities.find((n) => n.components.Name?.value === 'Child');
        expect(childNode?.components.Transform).toBeDefined();
        const t = childNode?.components.Transform;
        // Local TRS: child node carries its own [2, 0, 0]; parent's [5, 0, 0]
        // is encoded via ChildOf -> parent's Transform, accumulated by
        // propagateTransforms downstream.
        expect(t?.posX).toBe(2);
        expect(t?.posY).toBe(0);
        expect(t?.posZ).toBe(0);
        expect(childNode?.components.ChildOf?.parent).toBeDefined();
      });
    });

    describe('bridge.ts B6 camera detection (M3 w14)', () => {
      it('glTF node with camera index produces entity with Camera component', () => {
        const doc = {
          meshes: [
            {
              positions: new Float32Array([0, 0, 0]),
              indices: new Uint16Array([0]),
              materialIndex: 0,
              meshIndex: 0,
            },
          ],
          materials: [{ baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }],
          nodes: [
            {
              name: 'BoxNode',
              transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [],
            },
            {
              name: 'CameraNode',
              transform: { translation: [0, 0, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: null,
              skinIndex: null,
              children: [],
              camera: 0,
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0, 1] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['BoxNode', 'CameraNode'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(1)]]),
          materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
        };
        const scene = gltfDocToSceneAsset(doc as unknown as GltfDoc, ctx);

        const cameraNode = scene.entities.find((n) => n.components.Name?.value === 'CameraNode');
        expect(cameraNode).toBeDefined();
        expect(cameraNode?.components.Camera).toBeDefined();
        expect(cameraNode?.components.Camera?.fov).toBe(0.7853981633974483);

        const boxNode = scene.entities.find((n) => n.components.Name?.value === 'BoxNode');
        expect(boxNode?.components.Camera).toBeUndefined();
      });
    });
  });
}
