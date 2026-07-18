// apps/hello/topology -- line-list primitive topology end-to-end demo
// (feat-20260604-mesh-topology-debug-draw / M6 / w16).
//
// What this demo proves end-to-end (requirements AC-11 + AC-12):
//   - A MeshAsset authored with `topology: 'line-list'` and NO index buffer
//     (vertex-only) registers, uploads, and renders through the non-indexed
//     `pass.draw(vertexCount)` path with a line-list PSO (M1-M5 capability).
//   - The spawned mesh draws as DISCRETE line segments (a wireframe box's 12
//     edges), not a filled triangle face -- visual evidence the topology field
//     reached the immutable WebGPU pipeline.
//
// Geometry (OOS-1: no debug-line geometry factory -- the demo hand-builds the
// vertex buffer): a unit cube's 12 edges expressed as 24 vertices (2 per edge),
// drawn as 12 independent line segments. Each vertex carries the standard
// 12-float interleaved layout (position vec3 + normal vec3 + uv vec2 +
// tangent vec4); normal/uv/tangent are zero-filled because the unlit material
// ignores them.
//
// Material: forgeax::default-unlit with a bright cyan baseColor so the lines
// read clearly against the black clear color regardless of lighting (line
// primitives have no meaningful face normals).
//
// Recipe (charter P1 progressive disclosure):
//   (1) createApp(canvas, {}, { shaderManifestUrl }) + spawn Camera with clear* fields
//   (2) world.allocSharedRef('MeshAsset', { kind: 'mesh', ... }) -> meshHandle
//   (3) world.allocSharedRef('MaterialAsset', unlit material) -> materialHandle
//   (4) world.spawn Transform + MeshFilter + MeshRenderer
//   (5) world.spawn Camera (no light needed for unlit)
//   (6) app.start()

import { createApp } from '@forgeax/engine-app';
import type { CanvasAppError } from '@forgeax/engine-app';

import {
  Camera,
  EngineEnvironmentError,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';

import type { Handle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// --- shared geometry builder -------------------------------------------------

/**
 * Number of floats per vertex in the engine's interleaved vertex layout:
 * position vec3 + normal vec3 + uv vec2 + tangent vec4 = 12 floats.
 * (AssetRegistry.validateMeshPayload enforces vertices.length % 12 === 0.)
 */
const FLOATS_PER_VERTEX = 12;

/**
 * Build a vertex-only line-list MeshAsset for a unit-cube wireframe: 12 edges,
 * 24 vertices (2 per edge), drawn as discrete segments. No index buffer -- the
 * engine takes the non-indexed `pass.draw(24)` path with a line-list PSO.
 */
export function buildWireframeBoxLineList(half = 0.8): MeshAsset {
  // 8 cube corners.
  const c: readonly (readonly [number, number, number])[] = [
    [-half, -half, -half], // 0
    [half, -half, -half], // 1
    [half, half, -half], // 2
    [-half, half, -half], // 3
    [-half, -half, half], // 4
    [half, -half, half], // 5
    [half, half, half], // 6
    [-half, half, half], // 7
  ];
  // 12 edges as corner-index pairs.
  const edges: readonly (readonly [number, number])[] = [
    [0, 1], [1, 2], [2, 3], [3, 0], // back face
    [4, 5], [5, 6], [6, 7], [7, 4], // front face
    [0, 4], [1, 5], [2, 6], [3, 7], // connecting edges
  ];

  const vertexCount = edges.length * 2;
  const vertices = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
  const position = new Float32Array(vertexCount * 3);

  let v = 0;
  for (const [a, b] of edges) {
    for (const ci of [a, b]) {
      const corner = c[ci] as readonly [number, number, number];
      const base = v * FLOATS_PER_VERTEX;
      vertices[base + 0] = corner[0];
      vertices[base + 1] = corner[1];
      vertices[base + 2] = corner[2];
      // normal (3), uv (2), tangent (4) left at 0 -- unlit ignores them.
      position[v * 3 + 0] = corner[0];
      position[v * 3 + 1] = corner[1];
      position[v * 3 + 2] = corner[2];
      v++;
    }
  }

  return {
    kind: 'mesh',
    vertices,
    // No `indices`: vertex-only line-list takes the non-indexed draw path.
    attributes: { position },
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 0,
        vertexCount,
        topology: 'line-list',
      },
    ],
  };
}

// --- bootstrap ---------------------------------------------------------------

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[topology] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[topology] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[topology] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  console.warn(`[topology] backend=${app.renderer.backend}`);

  const ready = await app.renderer.ready;
  if (!ready.ok) {
    console.error('[topology] renderer.ready failed:', ready.error.code, ready.error.hint);
    return;
  }

  const assets = app.renderer.assets;
  if (assets === null) {
    console.error('[topology] AssetRegistry is null (renderer construction failed)');
    return;
  }
  const world = app.world;

  // Step 2: mint the vertex-only line-list mesh as a shared ref.
  const meshHandle: Handle<'MeshAsset', 'shared'> = world.allocSharedRef(
    'MeshAsset',
    buildWireframeBoxLineList(),
  );

  // Step 3: mint the unlit material (bright cyan -- ignores lighting).
  const materialHandle: Handle<'MaterialAsset', 'shared'> = world.allocSharedRef<
    'MaterialAsset',
    MaterialAsset
  >('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-unlit',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: {
      baseColor: [0.1, 0.9, 1.0],
    },
  });

  // Step 4: spawn the wireframe box.
  world.spawn(
    {
      component: Transform,
      data: { quat: [0, 0, 0, 1], scale: [1, 1, 1]},
    },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();

  // Step 5: spawn the camera looking at the box from an oblique angle so
  // multiple edges are visible (no light needed for the unlit material).
  world.spawn(
    {
      component: Transform,
      data: { pos: [1.6, 1.4, 3.2], quat: [0, 0, 0, 1]},
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
      },
    },
  ).unwrap();

  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[topology] running. Wireframe box drawn as 12 line-list segments.');
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[topology] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[topology] ${err.code}: ${err.hint}`);
}
