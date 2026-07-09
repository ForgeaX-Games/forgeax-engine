// hello-multi-uv: multi-UV visual differentiation demo for AC-10.
//
// Spawns a plane with 2 UV sets. The interleaved vertices buffer carries all
// attributes; independent per-attribute typed arrays are extracted for the
// VertexAttributeMap contract (deriveVertexBufferLayout reads them).
//
// uv0 = standard grid pattern (0..1 per segment)
// uv1 = checkerboard pattern per quad
//
// AC-10 visual differentiation is carried by the demo's OWN custom shader
// (multi-uv-demo.wgsl), NOT by the engine-shipped default-standard-pbr: the
// built-in PBR fragment must stay byte-identical for single-UV meshes
// (AC-11/AC-12 zero regression). The demo shader paints uv1 into the surface
// colour so the per-quad checkerboard is directly visible. A mesh with no
// second UV set reads uv0 via clamp-to-last (NOT (0,0)) -- the per-cell
// variance only appears because this plane carries a real second set.
//
// Import path follows `apps/hello/cube/src/main.ts` pattern.

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import type { CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  Transform,
} from '@forgeax/engine-runtime';
import demoShader from './multi-uv-demo.wgsl';

const DEMO_MATERIAL_SHADER_PATH = 'hello-multi-uv::multi-uv-demo';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-multi-uv: missing <canvas id="app"> in index.html');

const HALF_W = 1.5;
const HALF_H = 1.5;
const GRID_X = 4;
const GRID_Y = 4;
const VX = GRID_X + 1;
const VY = GRID_Y + 1;
const UV_SETS = 2;
const FLOATS_BASE = 12;
const FLOATS_PER_VERTEX = FLOATS_BASE + (UV_SETS - 1) * 2; // 14

const vertexCount = VX * VY;
const indexCount = GRID_X * GRID_Y * 6;
const vertices = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
const indices = new Uint16Array(indexCount);
const segW = (HALF_W * 2) / GRID_X;
const segH = (HALF_H * 2) / GRID_Y;

for (let iy = 0, vi = 0; iy < VY; iy++) {
  for (let ix = 0; ix < VX; ix++, vi++) {
    const x = ix * segW - HALF_W;
    const y = -(iy * segH - HALF_H);
    const b = vi * FLOATS_PER_VERTEX;
    vertices[b + 0] = x;
    vertices[b + 1] = y;
    vertices[b + 2] = 0;
    vertices[b + 3] = 0;
    vertices[b + 4] = 0;
    vertices[b + 5] = 1;
    vertices[b + 6] = ix / GRID_X;
    vertices[b + 7] = iy / GRID_Y;
    vertices[b + 8] = 1;
    vertices[b + 9] = 0;
    vertices[b + 10] = 0;
    vertices[b + 11] = 1;
    const cell = (ix ^ iy) & 1;
    vertices[b + 12] = cell === 0 ? 0.0 : 1.0;
    vertices[b + 13] = cell === 0 ? 0.0 : 1.0;
  }
}

for (let iy = 0, ii = 0; iy < GRID_Y; iy++) {
  for (let ix = 0; ix < GRID_X; ix++) {
    const a = ix + VX * iy;
    const b = ix + VX * (iy + 1);
    const c = ix + 1 + VX * (iy + 1);
    const d = ix + 1 + VX * iy;
    indices[ii++] = a;
    indices[ii++] = b;
    indices[ii++] = d;
    indices[ii++] = b;
    indices[ii++] = c;
    indices[ii++] = d;
  }
}

// Independent per-attribute typed arrays. Each carries ONE attribute's data
// (not interleaved), matching the VertexAttributeMap contract: the engine's
// deriveVertexBufferLayout layer assembles GPU vertex buffers from these
// independent arrays. Copy from the interleaved vertices buffer using correct
// per-attribute byte offsets within the FLOATS_PER_VERTEX stride.
const positions = new Float32Array(vertexCount * 3);
const normals = new Float32Array(vertexCount * 3);
const uvs = new Float32Array(vertexCount * 2);
const tangents = new Float32Array(vertexCount * 4);
const uv1 = new Float32Array(vertexCount * 2);

for (let i = 0; i < vertexCount; i++) {
  const srcBase = i * FLOATS_PER_VERTEX;
  positions[i * 3 + 0] = vertices[srcBase + 0] as number;
  positions[i * 3 + 1] = vertices[srcBase + 1] as number;
  positions[i * 3 + 2] = vertices[srcBase + 2] as number;
  normals[i * 3 + 0] = vertices[srcBase + 3] as number;
  normals[i * 3 + 1] = vertices[srcBase + 4] as number;
  normals[i * 3 + 2] = vertices[srcBase + 5] as number;
  uvs[i * 2 + 0] = vertices[srcBase + 6] as number;
  uvs[i * 2 + 1] = vertices[srcBase + 7] as number;
  tangents[i * 4 + 0] = vertices[srcBase + 8] as number;
  tangents[i * 4 + 1] = vertices[srcBase + 9] as number;
  tangents[i * 4 + 2] = vertices[srcBase + 10] as number;
  tangents[i * 4 + 3] = vertices[srcBase + 11] as number;
  uv1[i * 2 + 0] = vertices[srcBase + 12] as number;
  uv1[i * 2 + 1] = vertices[srcBase + 13] as number;
}

const app = await createApp(canvas, {}, forgeaxBundlerAdapter());
if (!app.ok) {
  reportError(app.error);
} else {
  const world = app.value.world;
  const shader = app.value.renderer.shader;
  const assets = app.value.renderer.assets;

  // Register the demo's custom material shader (AC-10 visual carrier). The
  // smoke-dawn path passes the same paramSchema explicitly; here vite's
  // forgeaxShader() transform already composed multi-uv-demo.wgsl into
  // { hash, wgsl } and the .meta.json sidecar is the paramSchema SSOT.
  shader.registerMaterialShader(DEMO_MATERIAL_SHADER_PATH, {
    source: demoShader.wgsl,
    paramSchema: [{ name: 'baseColor', type: 'color' }],
  });

  // Build MeshAsset with independent per-attribute typed arrays. The interleaved
  // `vertices` buffer is the main GPU vertex data; `attributes` provides
  // per-attribute views for deriveVertexBufferLayout.
  const meshAsset = {
    kind: 'mesh' as const,
    vertices,
    indices,
    attributes: {
      position: positions,
      normal: normals,
      uv: uvs,
      tangent: tangents,
      uv1,
    },
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount,
        topology: 'triangle-list' as const,
      },
    ],
    aabb: new Float32Array([-HALF_W, -HALF_H, -0.01, HALF_W, HALF_H, 0.01]),
  };

  // Build MaterialAsset referencing the custom multi-uv shader (AC-10 visual
  // carrier). The shader samples uv1 -> visible per-quad checkerboard; the
  // built-in PBR is deliberately NOT used here so the engine core stays
  // single-UV-zero-regression clean.
  const materialAsset = {
    kind: 'material' as const,
    passes: [
      {
        name: 'Forward',
        shader: DEMO_MATERIAL_SHADER_PATH,
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: {
      baseColor: [0.7, 0.7, 0.7],
    },
  };

  // catalog acquires the GUID -> payload mapping (for loadByGuid fast-path);
  // allocSharedRef mints the ECS column handles needed by MeshFilter.assetHandle
  // / MeshRenderer.materials[] (Handle<'MeshAsset','shared'> and
  // Handle<'MaterialAsset','shared'> respectively).
  assets.catalog('guid:0a0a0a0a-0000-0000-0000-0a0a0a0a0a0a', meshAsset);
  assets.catalog('guid:1b1b1b1b-0000-0000-0000-1b1b1b1b1b1b', materialAsset);
  const meshHandle = world.allocSharedRef('MeshAsset', meshAsset);
  const matHandle = world.allocSharedRef('MaterialAsset', materialAsset);

  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0.5],
        quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  );
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 3],
        quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    },
    {
      component: Camera,
      data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 },
    },
  );
  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: -0.3,
      directionY: -0.8,
      directionZ: -1,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1,
    },
  });

  app.value.start();
}

function reportError(err: CanvasAppError): void {
  console.error('[multi-uv] createApp failed:', err);
}
