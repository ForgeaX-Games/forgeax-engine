import { type World } from '@forgeax/engine-ecs';
import {
  Camera,
  MeshFilter,
  MeshRenderer,
  Materials,
  perspective,
  Transform,
  type MaterialAsset,
} from '@forgeax/engine-runtime';
import type { MeshAsset } from '@forgeax/engine-types';
import { quat } from '@forgeax/engine-math';

const FLOATS_PER_VERTEX = 12;

function customCubeMesh(): MeshAsset {
  const half = 0.5;
  const N = 24;
  const posData: readonly (readonly [number, number, number])[] = [
    [-half, half, -half], [half, half, -half], [half, half, half], [-half, half, half],
    [-half, -half, -half], [half, -half, -half], [half, -half, half], [-half, -half, half],
    [half, -half, -half], [half, -half, half], [half, half, half], [half, half, -half],
    [-half, -half, -half], [-half, -half, half], [-half, half, half], [-half, half, -half],
    [-half, -half, half], [-half, half, half], [half, half, half], [half, -half, half],
    [-half, -half, -half], [-half, half, -half], [half, half, -half], [half, -half, -half],
  ];
  const normData: readonly (readonly [number, number, number])[] = [
    [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0],
    [0, -1, 0], [0, -1, 0], [0, -1, 0], [0, -1, 0],
    [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0],
    [-1, 0, 0], [-1, 0, 0], [-1, 0, 0], [-1, 0, 0],
    [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1],
    [0, 0, -1], [0, 0, -1], [0, 0, -1], [0, 0, -1],
  ];

  const vertices = new Float32Array(N * FLOATS_PER_VERTEX);
  const posAttr = new Float32Array(N * 3);
  const normAttr = new Float32Array(N * 3);
  const uvAttr = new Float32Array(N * 2);
  const tanAttr = new Float32Array(N * 4);

  for (let i = 0; i < N; i++) {
    const p = posData[i]!;
    const n = normData[i]!;
    const vi = i * FLOATS_PER_VERTEX;
    vertices[vi] = p[0]; vertices[vi + 1] = p[1]; vertices[vi + 2] = p[2];
    vertices[vi + 3] = n[0]; vertices[vi + 4] = n[1]; vertices[vi + 5] = n[2];
    posAttr[i * 3] = p[0]; posAttr[i * 3 + 1] = p[1]; posAttr[i * 3 + 2] = p[2];
    normAttr[i * 3] = n[0]; normAttr[i * 3 + 1] = n[1]; normAttr[i * 3 + 2] = n[2];
  }

  return {
    kind: 'mesh',
    vertices,
    attributes: { position: posAttr, normal: normAttr, uv: uvAttr, tangent: tanAttr },
    indices: new Uint32Array([
      0, 3, 1, 1, 3, 2, 4, 5, 7, 5, 6, 7,
      8, 11, 9, 9, 11, 10, 12, 13, 15, 13, 14, 15,
      16, 19, 17, 17, 19, 18, 20, 21, 23, 21, 22, 23,
    ]),
    submeshes: [{ indexOffset: 0, indexCount: 36, vertexCount: N, topology: 'triangle-list' }],
    aabb: new Float32Array([-half, -half, -half, half, half, half]),
  };
}

export function buildCustomMeshWorld(world: World): void {
  const mat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([0.3, 0.5, 0.8, 1]),
  );
  const mesh = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', customCubeMesh());
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [mat] } },
  );

  const eye: [number, number, number] = [1.8, 1.8, 1.8];
  world.spawn(
    {
      component: Transform,
      data: {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
}