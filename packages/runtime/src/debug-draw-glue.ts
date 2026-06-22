// @forgeax/engine-runtime — debug-draw auto-attach SSOT (feat-20260615-debug-draw M5 / w28)
//
// Plan D-1: wiring lives in packages/runtime/, not in packages/debug-draw/
// Plan D-5: single-file SSOT for createApp hook + attachDebugOverlayPass helper
// Plan D-8: both URP and HDRP share the same attachDebugOverlayPass helper (SSOT)
//
// Two exports:
//   (a) createDebugDrawOnReady(renderer, format?) — creates a DebugDraw instance
//       once renderer.ready settles. Sets the package-internal registry so the
//       graph pass closures can reach it. Called from createApp to populate
//       app.debugDraw.
//   (b) attachDebugOverlayPass(graph, getViewProj) — adds a tonemap-suffix
//       overlay pass to a render-graph. The pass execute closure reads the
//       internally-registered DebugDraw instance (set by createDebugDrawOnReady).

import type { CreateShaderModule, DebugDraw } from '@forgeax/engine-debug-draw';
import { createDebugDraw } from '@forgeax/engine-debug-draw';
import type { Mat4 } from '@forgeax/engine-math';
import type { RenderGraph } from '@forgeax/engine-render-graph';
import type { TextureFormat, TextureView } from '@forgeax/engine-rhi';
import type { RenderPipelineContext } from './render-pipeline-context';
import type { Renderer } from './renderer';

/**
 * Package-internal registry: the active DebugDraw instance for the current
 * renderer. Set by createDebugDrawOnReady, read by attachDebugOverlayPass
 * execute closures. A single renderer has one DebugDraw instance.
 */
let registeredDebugDraw: DebugDraw | null = null;

/**
 * Dynamically import createShaderModule from the appropriate RHI backend.
 *
 * Mirrors the auto-detect logic in createRenderer: navigator.gpu presence
 * selects rhi-webgpu, otherwise rhi-wgpu (dawn-node). The dynamic import
 * resolves the same module instance already loaded by createRenderer,
 * so it does not pull a second copy.
 */
async function resolveCreateShaderModule(): Promise<CreateShaderModule> {
  const nav: { gpu?: unknown } | undefined =
    typeof globalThis !== 'undefined'
      ? (globalThis as { navigator?: { gpu?: unknown } }).navigator
      : undefined;
  const hasWebGPU = nav !== undefined && 'gpu' in nav && nav.gpu !== undefined;

  // Literal import specifiers (not a variable) so Vite can statically analyze
  // each branch — mirrors createRenderer's channel-2/channel-3 split.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import result shape
  const backend: Record<string, any> = hasWebGPU
    ? await import('@forgeax/engine-rhi-webgpu')
    : await import('@forgeax/engine-rhi-wgpu');

  if (!hasWebGPU && typeof backend.ensureReady === 'function') {
    await backend.ensureReady();
  }

  return backend.createShaderModule as CreateShaderModule;
}

/**
 * Create a DebugDraw instance once `renderer.ready` settles.
 *
 * Waits for the GPU device + shader manifest + builtin asset upload to
 * complete before creating the DebugDraw PSO. Stores the instance in the
 * package-internal registry so graph pass closures can reach it.
 *
 * The format defaults to `'bgra8unorm'` (WebGPU swap-chain default) and
 * can be overridden for non-WebGPU backends (e.g. `'rgba8unorm'` for
 * wgpu-native/dawn).
 */
export async function createDebugDrawOnReady(
  renderer: Renderer,
  format: TextureFormat = 'bgra8unorm',
): Promise<DebugDraw> {
  const ready = await renderer.ready;
  if (!ready.ok) throw ready.error;

  const createShaderModule = await resolveCreateShaderModule();

  const ddResult = await createDebugDraw({
    device: renderer.device,
    queue: renderer.device.queue,
    createShaderModule,
    format,
  });
  if (!ddResult.ok) throw ddResult.error;

  registeredDebugDraw = ddResult.value;
  return ddResult.value;
}

/**
 * Attach a DebugOverlay pass to a render graph at the tonemap suffix.
 *
 * The pass is added with empty reads/writes (the swap-chain is not a
 * graph-declared target). The execute closure reads `ctx.view` (the
 * swap-chain TextureView) + `ctx.encoder` (the shared frame command
 * encoder) and calls `dd.flush(encoder, view, viewProj)` using the
 * registered DebugDraw instance.
 *
 * When no DebugDraw is registered (createDebugDrawOnReady not called,
 * or tree-shaken), the pass is a silent no-op.
 *
 * Per plan D-8: URP and HDRP both call this helper with their respective
 * tonemap-suffix graphs, keeping the wiring single-source.
 *
 * @param graph - The per-frame RenderGraph (URP forward-graph or HDRP tonemap-graph).
 * @param getViewProj - Thunk that returns camera.viewProj from the pass context
 *   at execute time (not at graph-build time).
 */
export function attachDebugOverlayPass(
  graph: RenderGraph<RenderPipelineContext>,
  getViewProj: (ctx: RenderPipelineContext) => Mat4,
): void {
  graph.addPass('debug-overlay', {
    reads: [],
    writes: [],
    execute: (ctx: RenderPipelineContext) => {
      const dd = registeredDebugDraw;
      if (!dd) return; // not registered (no debug-draw in this runtime)
      const viewProj = getViewProj(ctx);
      dd.flush(ctx.encoder, ctx.view as unknown as TextureView, viewProj);
    },
  });
}
