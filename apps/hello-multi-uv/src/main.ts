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
  ANTIALIAS_MSAA,
  addFullscreenPass,
  addScenePass,
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  type RenderPipeline,
  type RenderPipelineContext,
  type RenderPipelineData,
} from '@forgeax/engine-render';
import { RenderGraph } from '@forgeax/engine-render-graph';
import { Transform } from '@forgeax/engine-scene';
import type { RenderPipelineAsset, TextureAsset } from '@forgeax/engine-types';
import customPipelineInversionShader from './custom-pipeline-inversion.wgsl';
import './multi-uv-demo.wgsl';
import depthFalsifierShader from './post-depth-falsifier.wgsl';
import depthOverlayShader from './post-depth-overlay.wgsl';
import depthOverlayMsaaShader from './post-depth-overlay-msaa.wgsl';
import inversionShader from './post-inversion.wgsl';
import passthroughShader from './post-passthrough.wgsl';

const DEMO_MATERIAL_SHADER_PATH = 'hello-multi-uv::multi-uv-demo';
const CUSTOM_PIPELINE_ID = 'hello-multi-uv::custom-render-graph';
const CUSTOM_PIPELINE_INVERSION_ID = 'hello-multi-uv::custom-render-graph-inversion';
const CUSTOM_PIPELINE_PASSTHROUGH_ID = 'hello-multi-uv::custom-render-graph-passthrough';
const CUSTOM_PIPELINE_DEPTH_ID = 'hello-multi-uv::custom-render-graph-depth';
const CUSTOM_PIPELINE_DEPTH_MSAA_ID = 'hello-multi-uv::custom-render-graph-depth-msaa';
const CUSTOM_PIPELINE_DEPTH_FALSIFIER_ID = 'hello-multi-uv::custom-render-graph-depth-falsifier';
const CUSTOM_COLOR_KEY = 'helloMultiUvCustomColor';
const CUSTOM_DEPTH_KEY = 'depth';
const CUSTOM_RESOLVE_KEY = 'helloMultiUvCustomResolve';

function makeCustomPipeline(postShader: string, readsDepth = false): RenderPipeline {
  return {
    buildGraph(
      ctx: RenderPipelineContext,
      _data: RenderPipelineData,
    ): RenderGraph<RenderPipelineContext> | null {
      const graph = new RenderGraph<RenderPipelineContext>();
      const colorFormat = ctx.pipelineState.colorAttachmentFormat ?? 'rgba8unorm-srgb';
      // `ctx` is intentionally a stable early-build carrier and does not
      // expose per-camera topology state there. The per-frame camera snapshot
      // is the public buildGraph source for MSAA, while execute receives the
      // matching live `ctx.msaaActive` for recordMainPass.
      const msaaActive = _data.camera.antialias === 'msaa';
      const falsifyMsaaResolve = params.has('falsify-msaa-resolve');
      const sceneSample = msaaActive ? 4 : 1;
      graph.addColorTarget(CUSTOM_COLOR_KEY, {
        format: colorFormat,
        size: 'swapchain',
        sample: sceneSample,
        usage: 0x10 | 0x04,
      });
      graph.addColorTarget(CUSTOM_DEPTH_KEY, {
        format: 'depth24plus-stencil8',
        size: 'swapchain',
        sample: sceneSample,
        usage: 0x10 | 0x04,
      });
      if (msaaActive && !falsifyMsaaResolve) {
        graph.addColorTarget(CUSTOM_RESOLVE_KEY, {
          format: colorFormat,
          size: 'swapchain',
          sample: 1,
          usage: 0x10 | 0x04,
        });
      }
      const colorInputKey =
        msaaActive && !falsifyMsaaResolve ? CUSTOM_RESOLVE_KEY : CUSTOM_COLOR_KEY;
      addScenePass(graph, 'custom-scene', {
        color: CUSTOM_COLOR_KEY,
        depth: CUSTOM_DEPTH_KEY,
        ...(msaaActive ? { resolve: falsifyMsaaResolve ? null : CUSTOM_RESOLVE_KEY } : {}),
        selector: { LightMode: ['Forward'] },
        _routeFromOpts: true,
      });
      addFullscreenPass(graph, 'custom-present', {
        shader: postShader,
        color: 'swapchain',
        reads: readsDepth ? [colorInputKey, CUSTOM_DEPTH_KEY] : [colorInputKey],
      });
      const compiled = graph.compile({
        backendKind: ctx.runtime.device.caps.backendKind,
        caps: ctx.runtime.device.caps,
        device: ctx.runtime.device,
      });
      if (!compiled.ok) {
        console.error('[hello-multi-uv] custom pipeline graph compile failed:', compiled.error);
        return null;
      }
      return graph;
    },
    execute(ctx: RenderPipelineContext): void {
      ctx.frameState.perFrameGraph?.execute(ctx);
    },
  };
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-multi-uv: missing <canvas id="app"> in index.html');
const targetCanvas = canvas;
const params = new URLSearchParams(location.search);
const useMsaa = params.has('msaa');

function resizeCanvas(): void {
  targetCanvas.width = window.innerWidth;
  targetCanvas.height = window.innerHeight;
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

const HALF_W = 1.5;
const HALF_H = 1.5;
const GRID_X = 4;
const GRID_Y = 4;
const VX = GRID_X + 1;
const VY = GRID_Y + 1;
const UV_SETS = 2;
const FLOATS_BASE = 12;
const FLOATS_PER_VERTEX = FLOATS_BASE + (UV_SETS - 1) * 2; // 14
const POST_PASSTHROUGH_ID = 'hello-multi-uv::passthrough';
const POST_INVERSION_ID = 'hello-multi-uv::inversion';
const POST_DEPTH_ID = 'hello-multi-uv::depth';
const POST_DEPTH_MSAA_ID = 'hello-multi-uv::depth-msaa';

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
  const assets = app.value.renderer.assets;
  const startupVariant: 'true' | 'false' = params.get('variant') === 'false' ? 'false' : 'true';
  const falsifyVariantSelection = params.has('falsify');
  const variantControl = document.createElement('label');
  variantControl.id = 'variant-control';
  variantControl.style.cssText =
    'position:fixed;z-index:1;top:12px;left:12px;padding:8px 10px;color:#fff;background:#111c;border-radius:4px;font:14px monospace';
  variantControl.append('M3_MULTI_UV_VARIANT ');
  const variantSelect = document.createElement('select');
  variantSelect.id = 'variant-select';
  variantSelect.setAttribute('aria-label', 'M3 multi-UV shader variant');
  variantSelect.add(new Option('true (default)', 'true'));
  variantSelect.add(new Option('false', 'false'));
  variantControl.append(variantSelect, ' ');
  const variantStatus = document.createElement('span');
  variantStatus.id = 'variant-status';
  variantStatus.textContent = 'M3_MULTI_UV_VARIANT=true';
  variantControl.append(variantStatus);
  document.body.append(variantControl);

  const pipelineControl = document.createElement('label');
  pipelineControl.id = 'pipeline-control';
  pipelineControl.style.cssText =
    'position:fixed;z-index:1;top:58px;left:12px;padding:8px 10px;color:#fff;background:#111c;border-radius:4px;font:14px monospace';
  pipelineControl.append('M3_PIPELINE ');
  const pipelineSelect = document.createElement('select');
  pipelineSelect.id = 'pipeline-select';
  pipelineSelect.setAttribute('aria-label', 'M3 render pipeline');
  pipelineSelect.add(new Option('standard URP', 'standard'));
  pipelineSelect.add(new Option('custom RenderGraph', 'custom'));
  pipelineControl.append(pipelineSelect, ' ');
  const pipelineStatus = document.createElement('span');
  pipelineStatus.id = 'pipeline-status';
  pipelineStatus.textContent = 'M3_PIPELINE=standard';
  pipelineControl.append(pipelineStatus);
  document.body.append(pipelineControl);

  const postControl = document.createElement('label');
  postControl.id = 'post-control';
  postControl.style.cssText =
    'position:fixed;z-index:1;top:104px;left:12px;padding:8px 10px;color:#fff;background:#111c;border-radius:4px;font:14px monospace';
  postControl.append('M3_POST_EFFECT ');
  const postSelect = document.createElement('select');
  postSelect.id = 'post-select';
  postSelect.setAttribute('aria-label', 'M3 post-process effect');
  postSelect.add(new Option('passthrough', 'passthrough'));
  postSelect.add(new Option('inversion', 'inversion'));
  postSelect.add(new Option('depth overlay', 'depth'));
  postControl.append(postSelect, ' ');
  const postStatus = document.createElement('span');
  postStatus.id = 'post-status';
  postStatus.textContent = 'M3_POST_EFFECT=passthrough';
  postControl.append(postStatus);
  document.body.append(postControl);

  const baseColorTexture: TextureAsset = {
    kind: 'texture',
    width: 2,
    height: 2,
    format: 'rgba8unorm',
    data: new Uint8Array([
      255, 128, 64, 255, 255, 128, 64, 255, 255, 128, 64, 255, 255, 128, 64, 255,
    ]),
    colorSpace: 'linear',
    mipmap: false,
  };
  const baseColorTextureHandle = world.allocSharedRef<'TextureAsset', TextureAsset>(
    'TextureAsset',
    baseColorTexture,
  );
  const detailTexture: TextureAsset = {
    kind: 'texture',
    width: 2,
    height: 2,
    format: 'rgba8unorm',
    data: new Uint8Array([
      64, 192, 255, 255, 64, 192, 255, 255, 64, 192, 255, 255, 64, 192, 255, 255,
    ]),
    colorSpace: 'linear',
    mipmap: false,
  };
  const detailTextureHandle = world.allocSharedRef<'TextureAsset', TextureAsset>(
    'TextureAsset',
    detailTexture,
  );
  assets.catalog('guid:3d3d3d3d-0000-0000-0000-3d3d3d3d3d3d', baseColorTexture);
  assets.catalog('guid:4e4e4e4e-0000-0000-0000-4e4e4e4e4e4e', detailTexture);
  const textureStatus = document.createElement('span');
  textureStatus.id = 'texture-status';
  textureStatus.textContent = 'M3_TEXTURE_BINDING=baseColorTexture+detailTexture';
  variantControl.append(' ', textureStatus);
  const antialiasStatus = document.createElement('span');
  antialiasStatus.id = 'antialias-status';
  antialiasStatus.textContent = `M3_ANTIALIAS=${useMsaa ? 'msaa' : 'none'}`;
  variantControl.append(' ', antialiasStatus);
  app.value.renderer.postProcess.register(CUSTOM_PIPELINE_INVERSION_ID, {
    source: customPipelineInversionShader.wgsl,
  });
  app.value.renderer.postProcess.register(CUSTOM_PIPELINE_PASSTHROUGH_ID, {
    source: passthroughShader.wgsl,
  });
  app.value.renderer.postProcess.register(CUSTOM_PIPELINE_DEPTH_ID, {
    source: depthOverlayShader.wgsl,
    reads: [{ key: CUSTOM_DEPTH_KEY, sampleType: 'depth' }],
  });
  app.value.renderer.postProcess.register(CUSTOM_PIPELINE_DEPTH_MSAA_ID, {
    source: depthOverlayMsaaShader.wgsl,
    reads: [{ key: CUSTOM_DEPTH_KEY, sampleType: 'depth' }],
  });
  app.value.renderer.postProcess.register(CUSTOM_PIPELINE_DEPTH_FALSIFIER_ID, {
    source: depthFalsifierShader.wgsl,
  });
  app.value.renderer.registerPipeline(
    CUSTOM_PIPELINE_ID,
    makeCustomPipeline(CUSTOM_PIPELINE_PASSTHROUGH_ID),
  );
  app.value.renderer.registerPipeline(
    CUSTOM_PIPELINE_INVERSION_ID,
    makeCustomPipeline(CUSTOM_PIPELINE_INVERSION_ID),
  );
  app.value.renderer.registerPipeline(
    CUSTOM_PIPELINE_DEPTH_ID,
    makeCustomPipeline(CUSTOM_PIPELINE_DEPTH_ID, true),
  );
  app.value.renderer.registerPipeline(
    CUSTOM_PIPELINE_DEPTH_MSAA_ID,
    makeCustomPipeline(CUSTOM_PIPELINE_DEPTH_MSAA_ID, true),
  );
  app.value.renderer.registerPipeline(
    CUSTOM_PIPELINE_DEPTH_FALSIFIER_ID,
    makeCustomPipeline(CUSTOM_PIPELINE_DEPTH_FALSIFIER_ID),
  );

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
  // carrier). The shader samples the real texture with uv0 and uv1 -> visible
  // per-quad checkerboard; the
  // built-in PBR is deliberately NOT used here so the engine core stays
  // single-UV-zero-regression clean.
  const falsifyDetailTexture = new URLSearchParams(location.search).has('falsify-texture');
  const materialAsset = (variant: 'true' | 'false') => ({
    kind: 'material' as const,
    passes: [
      {
        name: 'Forward',
        program: {
          module: DEMO_MATERIAL_SHADER_PATH,
          moduleSlots: {
            M3_MULTI_UV_VARIANT: falsifyVariantSelection ? 'true' : variant,
          },
        },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: {
      baseColor: [0.7, 0.7, 0.7],
      baseColorTexture: baseColorTextureHandle,
      ...(falsifyDetailTexture ? {} : { detailTexture: detailTextureHandle }),
    },
  });
  const defaultMaterial = materialAsset('true');
  const falseMaterial = materialAsset('false');

  // catalog acquires the GUID -> payload mapping (for loadByGuid fast-path);
  // allocSharedRef mints the ECS column handles needed by MeshFilter.assetHandle
  // / MeshRenderer.materials[] (Handle<'MeshAsset','shared'> and
  // Handle<'MaterialAsset','shared'> respectively).
  assets.catalog('guid:0a0a0a0a-0000-0000-0000-0a0a0a0a0a0a', meshAsset);
  assets.catalog('guid:1b1b1b1b-0000-0000-0000-1b1b1b1b1b1b', defaultMaterial);
  assets.catalog('guid:2c2c2c2c-0000-0000-0000-2c2c2c2c2c2c', falseMaterial);
  const meshHandle = world.allocSharedRef('MeshAsset', meshAsset);
  const defaultMatHandle = world.allocSharedRef('MaterialAsset', defaultMaterial);
  const falseMatHandle = world.allocSharedRef('MaterialAsset', falseMaterial);

  const planeEntity = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0.5],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [defaultMatHandle] } },
    )
    .unwrap();

  const selectVariant = (variant: 'true' | 'false') => {
    const result = world.set(planeEntity, MeshRenderer, {
      materials: [variant === 'true' ? defaultMatHandle : falseMatHandle],
    });
    if (!result.ok) {
      console.error('[multi-uv] variant selection failed:', result.error);
      return;
    }
    variantSelect.value = variant;
    variantStatus.textContent = `M3_MULTI_UV_VARIANT=${variant}`;
  };
  variantSelect.addEventListener('change', () => {
    selectVariant(variantSelect.value === 'false' ? 'false' : 'true');
  });
  selectVariant(startupVariant);
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
      data: {
        fov: Math.PI / 4,
        aspect: 16 / 9,
        near: 0.1,
        far: 100,
        ...(useMsaa ? { antialias: ANTIALIAS_MSAA } : {}),
      },
    },
  );
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.3, -0.8, -1],
      color: [1, 1, 1],
      intensity: 1,
    },
  });

  const falsifyPipelineSelection = new URLSearchParams(location.search).has('falsify-pipeline');
  const falsifyReversePipelineSelection = new URLSearchParams(location.search).has(
    'falsify-reverse-pipeline',
  );
  const falsifyDepthSelection = new URLSearchParams(location.search).has('falsify-depth');
  const standardPipeline: RenderPipelineAsset = {
    kind: 'render-pipeline',
    pipelineId: 'forgeax::urp',
  };
  type PipelineChoice = 'standard' | 'custom';
  type PostChoice = 'passthrough' | 'inversion' | 'depth';
  let selectedPipeline: PipelineChoice = 'standard';
  let selectedPost: PostChoice = 'passthrough';
  const pipelineAsset = (pipeline: PipelineChoice, post: PostChoice): RenderPipelineAsset => ({
    kind: 'render-pipeline',
    pipelineId:
      pipeline === 'custom'
        ? falsifyPipelineSelection
          ? 'forgeax::urp'
          : post === 'depth'
            ? falsifyDepthSelection
              ? CUSTOM_PIPELINE_DEPTH_FALSIFIER_ID
              : useMsaa
                ? CUSTOM_PIPELINE_DEPTH_MSAA_ID
                : CUSTOM_PIPELINE_DEPTH_ID
            : post === 'inversion'
              ? CUSTOM_PIPELINE_INVERSION_ID
              : CUSTOM_PIPELINE_ID
        : standardPipeline.pipelineId,
    ...(pipeline === 'standard' && !falsifyReversePipelineSelection
      ? {
          config: {
            postEffects: [
              post === 'depth'
                ? useMsaa
                  ? POST_DEPTH_MSAA_ID
                  : POST_DEPTH_ID
                : post === 'inversion'
                  ? POST_INVERSION_ID
                  : POST_PASSTHROUGH_ID,
            ],
          },
        }
      : {}),
  });
  const selectPipeline = (pipeline: PipelineChoice) => {
    const asset = pipelineAsset(pipeline, selectedPost);
    const result = app.value.renderer.installPipeline(asset);
    if (!result.ok) {
      console.error('[hello-multi-uv] pipeline selection failed:', result.error);
      return;
    }
    selectedPipeline = pipeline;
    pipelineSelect.value = pipeline;
    pipelineStatus.textContent = `M3_PIPELINE=${pipeline}`;
  };
  pipelineSelect.addEventListener('change', () => {
    selectPipeline(pipelineSelect.value === 'custom' ? 'custom' : 'standard');
  });

  app.value.renderer.postProcess.register(POST_PASSTHROUGH_ID, {
    source: passthroughShader.wgsl,
  });
  app.value.renderer.postProcess.register(POST_INVERSION_ID, {
    source: inversionShader.wgsl,
  });
  app.value.renderer.postProcess.register(POST_DEPTH_ID, {
    source: depthOverlayShader.wgsl,
    reads: [{ key: CUSTOM_DEPTH_KEY, sampleType: 'depth' }],
  });
  app.value.renderer.postProcess.register(POST_DEPTH_MSAA_ID, {
    source: depthOverlayMsaaShader.wgsl,
    reads: [{ key: CUSTOM_DEPTH_KEY, sampleType: 'depth' }],
  });

  const selectPost = (effect: PostChoice) => {
    const asset = pipelineAsset(selectedPipeline, effect);
    const result = app.value.renderer.installPipeline(asset);
    if (!result.ok) {
      console.error('[hello-multi-uv] post selection failed:', result.error);
      return;
    }
    selectedPost = effect;
    postSelect.value = effect;
    postStatus.textContent = `M3_POST_EFFECT=${effect}`;
  };
  postSelect.addEventListener('change', () => {
    selectPost(
      postSelect.value === 'depth'
        ? 'depth'
        : postSelect.value === 'inversion'
          ? 'inversion'
          : 'passthrough',
    );
  });

  const initialPost: PostChoice =
    params.get('post') === 'depth'
      ? 'depth'
      : params.get('post') === 'inversion'
        ? 'inversion'
        : 'passthrough';
  selectedPost = initialPost;
  postSelect.value = initialPost;
  postStatus.textContent = `M3_POST_EFFECT=${initialPost}`;
  app.value.start();
  if (params.get('pipeline') === 'custom') {
    selectPipeline('custom');
  } else {
    selectPost(initialPost);
  }
}

function reportError(err: CanvasAppError): void {
  console.error('[multi-uv] createApp failed:', err);
}
