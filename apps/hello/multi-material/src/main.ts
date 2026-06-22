// apps/hello/multi-material -- multi-prim + mixed-topology MeshAsset demo
// (feat-20260608-mesh-multi-section-primitive-multi-material-slot / M5 / w21).
//
// What this demo proves end-to-end (requirements AC-08 + plan-strategy 3.4):
//   - A single MeshAsset can carry TWO submeshes (independent draw ranges with
//     independent topologies) sharing one vertex buffer + one index buffer.
//   - MeshRenderer.materials[] indexes positionally with MeshAsset.submeshes[]:
//     materials[0] paints submesh[0] (triangle-list quad), materials[1] paints
//     submesh[1] (line-list wireframe box). The render record stage (M4 / w16)
//     issues N drawIndexed calls (one per submesh), each picking the topology
//     -appropriate PSO via materialShaderPipelineCacheKey + submesh.topology.
//   - Mixed-topology in the same frame works without PSO collision: the
//     triangle-list and line-list pipelines coexist as two cache keys.
//
// Geometry (single hand-built MeshAsset, no glTF dependency):
//   - 12 vertices, 12-float interleaved layout (position vec3 + normal vec3
//     + uv vec2 + tangent vec4 = 12 floats per vertex).
//   - 4 vertices form a filled quad in the XY plane (z=0).
//   - 8 vertices form a wireframe box outline at z=0 (slightly offset so the
//     line strokes read cleanly against the filled face); 12 line-segment
//     indices wire them.
//   - Index buffer is a single Uint16Array containing both prims back-to-back:
//     [0..6) -> quad triangle-list (2 triangles), [6..18) -> box line-list
//     (6 segments wired as 12 endpoints).
//
// Submesh layout:
//   submeshes[0] = { indexOffset: 0,  indexCount: 6,  topology: 'triangle-list' }
//   submeshes[1] = { indexOffset: 6,  indexCount: 12, topology: 'line-list'     }
//
// Materials (both unlit so lighting setup stays minimal):
//   materials[0] = bright red filled quad    (forgeax::default-unlit)
//   materials[1] = bright cyan wireframe box (forgeax::default-unlit)
//
// Recipe (charter P1 progressive disclosure):
//   (1) createApp(canvas, { clearColor, shaderManifestUrl })
//   (2) world.allocSharedRef('MeshAsset', { kind:'mesh', vertices, indices,
//        attributes, submeshes:[T0, T1] }) -> meshHandle
//   (3) world.allocSharedRef('MaterialAsset', red unlit)  -> redHandle
//   (4) world.allocSharedRef('MaterialAsset', cyan unlit) -> cyanHandle
//   (5) world.spawn Transform + MeshFilter(meshHandle) +
//        MeshRenderer({ materials:[redHandle, cyanHandle] })
//   (6) world.spawn Camera (no light needed for unlit)
//   (7) app.start()

import { createApp } from '@forgeax/engine-app';
import type { CanvasAppError } from '@forgeax/engine-app';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

import {
  Camera,
  EngineEnvironmentError,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';

import type { Handle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';

const FLOATS_PER_VERTEX = 12;

interface Built {
  readonly mesh: MeshAsset;
  readonly quadIndexCount: number;
  readonly lineIndexCount: number;
}

/**
 * Build a single MeshAsset carrying two submeshes:
 *   submesh 0 = filled quad (triangle-list, 2 tris)
 *   submesh 1 = wireframe box outline (line-list, 6 segments = 12 endpoints)
 *
 * Both submeshes share the SAME vertex / index buffers; submesh entries slice
 * into the index range. The result is a single GPU mesh upload servicing two
 * draw calls with two different PSOs at record time.
 */
function buildMultiPrimMesh(): Built {
  // 4 quad corners (XY plane at z=0, half-side = 0.6).
  const half = 0.6;
  const quadCorners: readonly (readonly [number, number, number])[] = [
    [-half, -half, 0],
    [+half, -half, 0],
    [+half, +half, 0],
    [-half, +half, 0],
  ];
  // 8 box-outline corners pushed slightly forward in Z so the line strokes
  // read cleanly without z-fighting the filled quad.
  const lineZ = 0.02;
  const lineHalf = 0.7;
  const lineCorners: readonly (readonly [number, number, number])[] = [
    [-lineHalf, -lineHalf, lineZ],
    [+lineHalf, -lineHalf, lineZ],
    [+lineHalf, +lineHalf, lineZ],
    [-lineHalf, +lineHalf, lineZ],
    // 4 extra inner corners so the wireframe shows two nested squares (gives
    // the line-list submesh a richer shape than a single quad outline).
    [-lineHalf * 0.5, -lineHalf * 0.5, lineZ],
    [+lineHalf * 0.5, -lineHalf * 0.5, lineZ],
    [+lineHalf * 0.5, +lineHalf * 0.5, lineZ],
    [-lineHalf * 0.5, +lineHalf * 0.5, lineZ],
  ];

  const totalVerts = quadCorners.length + lineCorners.length;
  const vertices = new Float32Array(totalVerts * FLOATS_PER_VERTEX);
  const positions = new Float32Array(totalVerts * 3);

  let v = 0;
  for (const corner of [...quadCorners, ...lineCorners]) {
    const base = v * FLOATS_PER_VERTEX;
    vertices[base + 0] = corner[0];
    vertices[base + 1] = corner[1];
    vertices[base + 2] = corner[2];
    // normal (3), uv (2), tangent (4) left at 0 -- unlit ignores them.
    positions[v * 3 + 0] = corner[0];
    positions[v * 3 + 1] = corner[1];
    positions[v * 3 + 2] = corner[2];
    v++;
  }

  // Quad indices (vertex indices 0..3): 2 triangles = 6 indices.
  const quadIndices: readonly number[] = [0, 1, 2, 0, 2, 3];

  // Wireframe-box indices (vertex indices 4..11): two nested squares = 8
  // segments = 16 endpoints. Use the outer square (4..7) + inner square
  // (8..11), each as 4 segments.
  const outerSegs: readonly (readonly [number, number])[] = [
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
  ];
  const innerSegs: readonly (readonly [number, number])[] = [
    [8, 9],
    [9, 10],
    [10, 11],
    [11, 8],
  ];
  const lineIndices: number[] = [];
  for (const [a, b] of [...outerSegs, ...innerSegs]) {
    lineIndices.push(a, b);
  }

  const indices = new Uint16Array([...quadIndices, ...lineIndices]);

  return {
    mesh: {
      kind: 'mesh',
      vertices,
      indices,
      attributes: { position: positions },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: quadIndices.length,
          vertexCount: 4,
          topology: 'triangle-list',
        },
        {
          indexOffset: quadIndices.length,
          indexCount: lineIndices.length,
          vertexCount: 8,
          topology: 'line-list',
        },
      ],
    },
    quadIndexCount: quadIndices.length,
    lineIndexCount: lineIndices.length,
  };
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[multi-material] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[multi-material] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[multi-material] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  console.warn(`[multi-material] backend=${app.renderer.backend}`);

  const ready = await app.renderer.ready;
  if (!ready.ok) {
    console.error(
      '[multi-material] renderer.ready failed:',
      ready.error.code,
      ready.error.hint,
    );
    return;
  }

  const assets = app.renderer.assets;
  if (assets === null) {
    console.error('[multi-material] AssetRegistry is null (renderer construction failed)');
    return;
  }
  const world = app.world;

  const built = buildMultiPrimMesh();
  const meshHandle: Handle<'MeshAsset', 'shared'> = world.allocSharedRef('MeshAsset', built.mesh);

  const redHandle: Handle<'MaterialAsset', 'shared'> = world.allocSharedRef<
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
      baseColor: [1.0, 0.15, 0.15],
    },
  });

  const cyanHandle: Handle<'MaterialAsset', 'shared'> = world.allocSharedRef<
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

  // Spawn the multi-submesh entity: ONE MeshFilter + ONE MeshRenderer with
  // a 2-element materials array. Render records 2 drawIndexed calls; each
  // picks the topology-matched PSO at record time.
  world
    .spawn(
      {
        component: Transform,
        data: { quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 },
      },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      {
        component: MeshRenderer,
        data: { materials: [redHandle, cyanHandle] },
      },
    )
    .unwrap();

  world
    .spawn(
      {
        component: Transform,
        data: { posX: 0, posY: 0, posZ: 2.5, quatW: 1 },
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
        },
      },
    )
    .unwrap();

  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[multi-material] running.');
}

function reportAppError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[multi-material] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[multi-material] ${err.code}: ${err.hint}`);
}
