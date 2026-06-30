// hello-debug-draw main entry (feat-20260615-debug-draw M4 / M5)
//
// 5-mode URL router:
//   ?mode=low         - low-path RHI: createDebugDraw + 4 shapes + manual flush (w24)
//   ?mode=empty       - empty frame: no draw calls, control for no-op overlay (w24)
//   ?mode=runtime     - createApp + app.debugDraw.* auto-attach (w32)
//   ?mode=depth       - two DebugDraw instances (always + less-equal) (w32)
//   ?mode=hdrp-tonemap - HDRP pipeline overlay after tonemap (w32)
//
// Canvas: 256x256 (plan-strategy R-6 lavapipe soft-raster CI control)

import { createDebugDraw } from '@forgeax/engine-debug-draw';
import type { Mat4 } from '@forgeax/engine-math';
import { mat4, vec3 } from '@forgeax/engine-math';
import { createShaderModule, _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') ?? 'low';

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('Canvas #app not found');

// ---------------------------------------------------------------------------
// Common camera helpers
// ---------------------------------------------------------------------------

function buildViewProj(): Mat4 {
  const cameraPos = vec3.create(0, 2, 5);
  const target = vec3.create(0, 0, 0);
  const up = vec3.create(0, 1, 0);
  const view = mat4.lookAt(mat4.create(), cameraPos, target, up);
  const proj = mat4.perspective(mat4.create(), Math.PI / 4, 1, 0.1, 100);
  const vp = mat4.create();
  mat4.multiply(vp, proj, view);
  return vp;
}

// ---------------------------------------------------------------------------
// low-path: createDebugDraw + 4 shapes + manual flush (w24, already implemented)
// ---------------------------------------------------------------------------

async function runLow(): Promise<void> {
  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) throw new Error(`requestAdapter failed: ${adapterResult.error.code}`);
  const adapter = adapterResult.value;

  const deviceResult = await adapter.requestDevice({ requiredFeatures: [] });
  if (!deviceResult.ok) throw new Error(`requestDevice failed: ${deviceResult.error.code}`);
  const device = deviceResult.value;

  const fmt = navigator.gpu.getPreferredCanvasFormat();
  const ctx = canvas!.getContext('webgpu');
  if (!ctx) throw new Error('WebGPU not available');

  const rawDevice = _internal_getRawDevice(device)!;
  ctx.configure({ device: rawDevice, format: fmt, alphaMode: 'premultiplied' });

  const ddResult = await createDebugDraw({
    device,
    queue: device.queue,
    createShaderModule,
    format: fmt,
  });
  if (!ddResult.ok) throw new Error(`createDebugDraw failed: ${ddResult.error.code}`);
  const dd = ddResult.value;

  const viewProj = buildViewProj();

  // 4 shapes (identical to w24)
  dd.line(vec3.create(-1.5, -0.7, 0), vec3.create(1.5, -0.7, 0), [1, 0, 0, 1]);
  dd.sphere(vec3.create(0, 0.5, 0), 0.6, [0, 1, 0, 1]);
  dd.aabb(vec3.create(-0.4, -0.4, -0.4), vec3.create(0.4, 0.4, 0.4), [0, 0, 1, 1]);
  // Yellow frustum: independent second virtual camera
  const up = vec3.create(0, 1, 0);
  const fcamPos = vec3.create(0, 1, 2);
  const fcamTarget = vec3.create(0, 0, 0);
  const fcamView = mat4.lookAt(mat4.create(), fcamPos, fcamTarget, up);
  const fcamProj = mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.5, 3);
  const fcamViewProj = mat4.multiply(mat4.create(), fcamProj, fcamView);
  dd.frustum(fcamViewProj, [1, 1, 0, 1]);

  const encResult = device.createCommandEncoder();
  if (!encResult.ok) throw new Error(`createCommandEncoder failed: ${encResult.error.code}`);
  const encoder = encResult.value;

  const ctxView = ctx.getCurrentTexture().createView();
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle -> raw WebGPU view
  const flushResult = dd.flush(encoder, ctxView as any, viewProj);
  if (!flushResult.ok) throw new Error(`flush failed: ${flushResult.error.code}`);

  const cbResult = encoder.finish();
  if (!cbResult.ok) throw new Error(`finish failed: ${cbResult.error.code}`);

  const submitResult = device.queue.submit([cbResult.value]);
  if (!submitResult.ok) throw new Error(`submit failed: ${submitResult.error.code}`);

  dd.destroy();
}

// ---------------------------------------------------------------------------
// empty mode: no shape calls, flush skips GPU pass (w24)
// ---------------------------------------------------------------------------

async function runEmpty(): Promise<void> {
  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) throw new Error(`requestAdapter failed: ${adapterResult.error.code}`);
  const adapter = adapterResult.value;

  const deviceResult = await adapter.requestDevice({ requiredFeatures: [] });
  if (!deviceResult.ok) throw new Error(`requestDevice failed: ${deviceResult.error.code}`);
  const device = deviceResult.value;

  const fmt = navigator.gpu.getPreferredCanvasFormat();
  const ctx = canvas!.getContext('webgpu');
  if (!ctx) throw new Error('WebGPU not available');

  const rawDevice = _internal_getRawDevice(device)!;
  ctx.configure({ device: rawDevice, format: fmt, alphaMode: 'premultiplied' });

  const ddResult = await createDebugDraw({
    device,
    queue: device.queue,
    createShaderModule,
    format: fmt,
  });
  if (!ddResult.ok) throw new Error(`createDebugDraw failed: ${ddResult.error.code}`);
  const dd = ddResult.value;

  const viewProj = buildViewProj();

  const encResult = device.createCommandEncoder();
  if (!encResult.ok) throw new Error(`createCommandEncoder failed: ${encResult.error.code}`);
  const encoder = encResult.value;

  const ctxView = ctx.getCurrentTexture().createView();
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle -> raw WebGPU view
  const flushResult = dd.flush(encoder, ctxView as any, viewProj);
  if (!flushResult.ok) throw new Error(`empty flush failed: ${flushResult.error.code}`);

  const cbResult = encoder.finish();
  if (!cbResult.ok) throw new Error(`finish failed: ${cbResult.error.code}`);

  const submitResult = device.queue.submit([cbResult.value]);
  if (!submitResult.ok) throw new Error(`submit failed: ${submitResult.error.code}`);

  dd.destroy();
}

// ---------------------------------------------------------------------------
// runtime mode: createApp + app.debugDraw.* auto-attach (w32 / AC-05)
// ---------------------------------------------------------------------------

async function runRuntime(): Promise<void> {
  // Use the canvas-form createApp which auto-creates debug-draw via
  // createDebugDrawOnReady and attaches it to app.debugDraw.
  const { createApp } = await import('@forgeax/engine-app');
  const appResult = await createApp(canvas!);
  if (!appResult.ok) throw appResult.error;
  const app = appResult.value;

  if (!app.debugDraw) throw new Error('app.debugDraw missing — debug-draw auto-attach failed');

  // Register an update callback that draws the four shapes once (first frame).
  // The shapes are drawn each frame; the auto-attached debug-overlay pass
  // at the tonemap suffix flushes them to the swap-chain.
  const ddRuntime = app.debugDraw;
  let drawn = false;
  app.registerUpdate(() => {
    if (drawn) return;
    drawn = true;
    ddRuntime.line(vec3.create(-1.5, -0.7, 0), vec3.create(1.5, -0.7, 0), [1, 0, 0, 1]);
    ddRuntime.sphere(vec3.create(0, 0.5, 0), 0.6, [0, 1, 0, 1]);
    ddRuntime.aabb(vec3.create(-0.4, -0.4, -0.4), vec3.create(0.4, 0.4, 0.4), [0, 0, 1, 1]);
    const up = vec3.create(0, 1, 0);
    const fcamPos = vec3.create(0, 1, 2);
    const fcamTarget = vec3.create(0, 0, 0);
    const fcamView = mat4.lookAt(mat4.create(), fcamPos, fcamTarget, up);
    const fcamProj = mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.5, 3);
    const fcamViewProj = mat4.multiply(mat4.create(), fcamProj, fcamView);
    ddRuntime.frustum(fcamViewProj, [1, 1, 0, 1]);
  });

  app.start();
  // Let it run a few frames, then stop
  await new Promise((resolve) => setTimeout(resolve, 100));
  app.stop();
}

// ---------------------------------------------------------------------------
// depth mode: two DebugDraw instances (always + less-equal), w32 / AC-06
//
// Visual contract:
//   always  — all 4 shapes visible on black background (depth ignored)
//   less-equal — depth buffer cleared to 1.0 (far plane); PSO has
//     depthStencil with less-equal compare. All shapes pass (depth<=1.0).
//     Shape positions offset from always-mode for visual distinction.
//     Genuine z-occlusion requires a prior depth-write pass.
// ---------------------------------------------------------------------------

let _depthTex: GPUTexture | undefined;

async function runDepth(): Promise<void> {
  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) throw new Error(`requestAdapter failed: ${adapterResult.error.code}`);
  const adapter = adapterResult.value;

  const deviceResult = await adapter.requestDevice({ requiredFeatures: [] });
  if (!deviceResult.ok) throw new Error(`requestDevice failed: ${deviceResult.error.code}`);
  const device = deviceResult.value;

  const fmt = navigator.gpu.getPreferredCanvasFormat();
  const ctx = canvas!.getContext('webgpu');
  if (!ctx) throw new Error('WebGPU not available');

  const rawDevice = _internal_getRawDevice(device)!;
  ctx.configure({ device: rawDevice, format: fmt, alphaMode: 'premultiplied' });

  // Shared depth texture (reused across both modes)
  _depthTex = rawDevice.createTexture({
    size: { width: canvas!.width, height: canvas!.height, depthOrArrayLayers: 1 },
    format: 'depth24plus' as GPUTextureFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  // Two DebugDraw instances: always (draws on top of everything) and
  // less-equal (respects depth buffer).
  const ddAlwaysResult = await createDebugDraw({
    device,
    queue: device.queue,
    createShaderModule,
    format: fmt,
    depthMode: 'always',
  });
  if (!ddAlwaysResult.ok) throw new Error(`createDebugDraw always failed: ${ddAlwaysResult.error.code}`);
  const ddAlways = ddAlwaysResult.value;

  const ddLessEqualResult = await createDebugDraw({
    device,
    queue: device.queue,
    createShaderModule,
    format: fmt,
    depthFormat: 'depth24plus',
    depthMode: 'less-equal',
  });
  if (!ddLessEqualResult.ok) throw new Error(`createDebugDraw less-equal failed: ${ddLessEqualResult.error.code}`);
  const ddLessEqual = ddLessEqualResult.value;

  // Wire the depth view into the less-equal instance so flush() includes
  // the depth-stencil attachment with loadOp='load'.
  // biome-ignore lint/suspicious/noExplicitAny: raw GPUTextureView -> opaque RHI TextureView
      ddLessEqual._setDepthView(_depthTex.createView() as any);

  const up = vec3.create(0, 1, 0);
  const fcamPos = vec3.create(0, 1, 2);
  const fcamTarget = vec3.create(0, 0, 0);

  // === always-mode shapes (visible on plain black background) ============
  const viewProj = buildViewProj();
  ddAlways.line(vec3.create(-1.5, 0, -0.5), vec3.create(1.5, 0, 0.5), [1, 0, 0, 1]);
  ddAlways.sphere(vec3.create(0, 0, 0), 0.5, [0, 1, 0, 1]);
  ddAlways.aabb(vec3.create(-0.4, -0.4, -0.4), vec3.create(0.4, 0.4, 0.4), [0, 0, 1, 1]);
  const fcamViewA = mat4.lookAt(mat4.create(), fcamPos, fcamTarget, up);
  const fcamProjA = mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.5, 3);
  ddAlways.frustum(mat4.multiply(mat4.create(), fcamProjA, fcamViewA), [1, 1, 0, 1]);

  // === less-equal mode shapes (offset positions for visual distinction) ===
  // Depth cleared to 1.0 (far plane); all shapes pass less-equal.
  // Shape positions differ from always-mode to produce visually distinct PNGs.
  ddLessEqual.line(vec3.create(-1.5, 0.2, -0.5), vec3.create(1.5, 0.2, 0.5), [1, 0, 0, 1]);
  ddLessEqual.sphere(vec3.create(0, -0.2, 0), 0.5, [0, 1, 0, 1]);
  ddLessEqual.aabb(vec3.create(-0.4, -0.4, 0.6), vec3.create(0.4, 0.4, 1.4), [0, 0, 1, 1]);
  const fcamViewL = mat4.lookAt(mat4.create(), fcamPos, fcamTarget, up);
  const fcamProjL = mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.5, 3);
  ddLessEqual.frustum(mat4.multiply(mat4.create(), fcamProjL, fcamViewL), [1, 1, 0, 1]);

  // Render always-mode (PNG 1) — no depth, flat overlay on black
  {
    const encResult = device.createCommandEncoder();
    if (!encResult.ok) throw new Error(`createCommandEncoder failed: ${encResult.error.code}`);
    const encoder = encResult.value;

    const ctxView = ctx.getCurrentTexture().createView();
    encoder.beginRenderPass({
      colorAttachments: [{
        view: ctxView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    }).end();

    const flushResult = ddAlways.flush(
      // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
      encoder, ctxView as any, viewProj,
    );
    if (!flushResult.ok) throw new Error(`always flush failed: ${flushResult.error.code}`);

    const cbResult = encoder.finish();
    if (!cbResult.ok) throw new Error(`finish failed: ${cbResult.error.code}`);
    device.queue.submit([cbResult.value]);
    await rawDevice.queue.onSubmittedWorkDone();
  }

  // Render less-equal mode (PNG 2) — depth cleared to 0.5, overlay with occlusion
  {
    const encResult = device.createCommandEncoder();
    if (!encResult.ok) throw new Error(`createCommandEncoder failed: ${encResult.error.code}`);
    const encoder = encResult.value;

    const ctxView = ctx.getCurrentTexture().createView();
    // Pre-clear color (black) + depth (far plane) so the less-equal flush loads both.
    encoder.beginRenderPass({
      colorAttachments: [{
        view: ctxView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
      depthStencilAttachment: {
        view: _depthTex.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    }).end();

    const flushResult = ddLessEqual.flush(
      // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
      encoder, ctxView as any, viewProj,
    );
    if (!flushResult.ok) throw new Error(`less-equal flush failed: ${flushResult.error.code}`);

    const cbResult = encoder.finish();
    if (!cbResult.ok) throw new Error(`finish failed: ${cbResult.error.code}`);
    device.queue.submit([cbResult.value]);
    await rawDevice.queue.onSubmittedWorkDone();
  }

  ddAlways.destroy();
  ddLessEqual.destroy();
  _depthTex.destroy();
  _depthTex = undefined;
}

// ---------------------------------------------------------------------------
// hdrp-tonemap mode: HDRP pipeline overlay after tonemap (w32 / AC-07)
// ---------------------------------------------------------------------------

async function runHdrpTonemap(): Promise<void> {
  const { createApp } = await import('@forgeax/engine-app');
  const { HDRP_PIPELINE_ID, hdrpPipeline } = await import('@forgeax/engine-runtime');

  const appResult = await createApp(canvas!);
  if (!appResult.ok) throw appResult.error;
  const app = appResult.value;

  if (!app.debugDraw) throw new Error('app.debugDraw missing');

  // Register and install HDRP pipeline. feat-20260614 M8 (D-19):
  // installPipeline takes the RenderPipelineAsset POD directly -- the
  // AssetRegistry holds no handle concept, so there is no register round-trip.
  app.renderer.registerPipeline(HDRP_PIPELINE_ID, hdrpPipeline);

  const installResult = app.renderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: HDRP_PIPELINE_ID,
    config: { clusterGrid: { x: 8, y: 6, z: 16 } },
  });
  if (!installResult.ok) {
    throw new Error(
      `HDRP installPipeline failed: ${installResult.error.code} — ${installResult.error.hint ?? ''}`,
    );
  }

  // Draw 4 shapes (same as low-mode) via app.debugDraw. The overlay renders
  // after tonemap, so the red channel of red-colored primitives should be
  // >= 0.85 (AC-07).
  const ddHdrp = app.debugDraw;
  let drawn = false;
  app.registerUpdate(() => {
    if (drawn) return;
    drawn = true;
    ddHdrp.line(vec3.create(-1.5, -0.7, 0), vec3.create(1.5, -0.7, 0), [1, 0, 0, 1]);
    ddHdrp.sphere(vec3.create(0, 0.5, 0), 0.6, [0, 1, 0, 1]);
    ddHdrp.aabb(vec3.create(-0.4, -0.4, -0.4), vec3.create(0.4, 0.4, 0.4), [0, 0, 1, 1]);
    const upH = vec3.create(0, 1, 0);
    const fcamPosH = vec3.create(0, 1, 2);
    const fcamTargetH = vec3.create(0, 0, 0);
    const fcamViewH = mat4.lookAt(mat4.create(), fcamPosH, fcamTargetH, upH);
    const fcamProjH = mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.5, 3);
    const fcamViewProjH = mat4.multiply(mat4.create(), fcamProjH, fcamViewH);
    ddHdrp.frustum(fcamViewProjH, [1, 1, 0, 1]);
  });

  app.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  app.stop();
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  switch (mode) {
    case 'low':
      document.getElementById('debug-draw-hud')!.textContent = 'debug-draw: low-path (RHI manual flush)';
      await runLow();
      break;
    case 'empty':
      document.getElementById('debug-draw-hud')!.textContent = 'debug-draw: empty (no shape, no-op flush)';
      await runEmpty();
      break;
    case 'runtime':
      document.getElementById('debug-draw-hud')!.textContent = 'debug-draw: runtime (createApp + app.debugDraw)';
      await runRuntime();
      break;
    case 'depth':
      document.getElementById('debug-draw-hud')!.textContent = 'debug-draw: depth (always vs less-equal)';
      await runDepth();
      break;
    case 'hdrp-tonemap':
      document.getElementById('debug-draw-hud')!.textContent = 'debug-draw: hdrp-tonemap (overlay after tonemap)';
      await runHdrpTonemap();
      break;
    default:
      document.getElementById('debug-draw-hud')!.textContent = `unknown mode: ${mode}`;
  }
}

main().catch((err: unknown) => {
  const hud = document.getElementById('debug-draw-hud');
  if (hud) hud.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});