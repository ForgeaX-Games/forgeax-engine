// to-asset-pack-name.test.ts -- AC-10: FBX multi-asset fixture name test.

import { describe, expect, it } from 'vitest';

import type {
  MeshPod,
  ScenePod,
  SkeletonPod,
  SkinPod,
} from '@forgeax/engine-types';
import { toAssetPack } from '../src/to-asset-pack.js';

function emptySkeleton(): SkeletonPod {
  return { jointCount: 0, inverseBindMatrices: new Float32Array(0), jointPaths: [] };
}

function emptySkin(): SkinPod {
  return {
    skeletonGuid: '',
    jointPaths: [],
    vertexCount: 0,
    influences: [],
  };
}

// GUID import-stable iron law: every emitted asset must be declared in
// subAssets[]. These tests declare a mesh + scene pair (and the single-scene
// variant) so toAssetPack resolves the declared GUID per (kind, sourceIndex).
const MESH_SUB = { guid: 'guid-mesh-0', kind: 'mesh', sourceIndex: 0 };
const SCENE_SUB = { guid: 'guid-scene-0', kind: 'scene', sourceIndex: 0 };

describe('toAssetPack name plumbing (AC-10)', () => {
  it('multi-asset FBX: mesh name from MeshPod.name', () => {
    const mesh: MeshPod = {
      name: 'MyMesh',
      sourceIndex: 0,
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      attributes: {},
      submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
    };
    const scene: ScenePod = {
      entities: [{ transform: { translation: [0, 1, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, meshIndex: null }],
    };
    const assets = toAssetPack({
      meshes: [mesh],
      scene,
      materials: [],
      textures: [],
      skeleton: emptySkeleton(),
      skin: emptySkin(),
      animationClips: [],
      subAssets: [MESH_SUB, SCENE_SUB],
    });
    const meshAsset = assets.find((a) => a.kind === 'mesh');
    expect(meshAsset).toBeDefined();
    expect(meshAsset?.name).toBe('MyMesh');
  });

  it('multi-asset FBX: scene name from ScenePod.name', () => {
    // A genuinely multi-asset pack (mesh + scene) keeps per-entry stored names.
    const mesh: MeshPod = {
      name: 'MyMesh',
      sourceIndex: 0,
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      attributes: {},
      submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
    };
    const scene: ScenePod = {
      name: 'Main',
      entities: [{ transform: { translation: [0, 1, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, meshIndex: null }],
    };
    const assets = toAssetPack({
      meshes: [mesh],
      scene,
      materials: [],
      textures: [],
      skeleton: emptySkeleton(),
      skin: emptySkin(),
      animationClips: [],
      subAssets: [MESH_SUB, SCENE_SUB],
    });
    const sceneAsset = assets.find((a) => a.kind === 'scene');
    expect(sceneAsset).toBeDefined();
    expect(sceneAsset?.name).toBe('Main');
  });

  it('single-asset FBX (scene only): name dropped per XOR rule (aligned with glTF)', () => {
    const scene: ScenePod = {
      name: 'Solo',
      entities: [{ transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, meshIndex: null }],
    };
    const assets = toAssetPack({
      meshes: [],
      scene,
      materials: [],
      textures: [],
      skeleton: emptySkeleton(),
      skin: emptySkin(),
      animationClips: [],
      subAssets: [SCENE_SUB],
    });
    expect(assets).toHaveLength(1);
    expect(assets[0]?.name).toBeUndefined();
  });

  it('multi-asset FBX: mesh without name -> name is undefined', () => {
    const mesh: MeshPod = {
      sourceIndex: 0,
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      attributes: {},
      submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
    };
    const scene: ScenePod = {
      entities: [{ transform: { translation: [0, 1, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, meshIndex: null }],
    };
    const assets = toAssetPack({
      meshes: [mesh],
      scene,
      materials: [],
      textures: [],
      skeleton: emptySkeleton(),
      skin: emptySkin(),
      animationClips: [],
      subAssets: [MESH_SUB, SCENE_SUB],
    });
    const meshAsset = assets.find((a) => a.kind === 'mesh');
    expect(meshAsset).toBeDefined();
    expect(meshAsset?.name).toBeUndefined();
  });
});