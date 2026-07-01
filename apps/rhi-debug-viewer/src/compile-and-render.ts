// compile-and-render.ts -- F2 independent compile/render path (D-1).
//
// Recompiles edited WGSL and previews it on the selected draw WITHOUT routing
// through the read-only Replay's shader cache. The Replay is a faithful tape
// executor with no hot-swap hook: createShaderModuleFn is injected once at
// createReplay time and commitThroughDraw replays the original createShaderModule
// events, overwriting any injection (research Finding 3). So apply must build its
// own pipeline + re-encode the target draw.
//
// Five-phase flow (plan-strategy D-1 + sequence 3.2):
//   1. naga parse(newWgsl)     -> CompileError{phase:'parse'}    (has lineNum/linePos)
//   2. naga validate(parsed)   -> CompileError{phase:'validate'} (lineNum undefined -- D-3)
//   3. createShaderModule      -> CompileError{phase:'gpu-compile'} (compilerMessages)
//   4. createRenderPipeline    -> CompileError{phase:'pipeline'}  (layout-incompatible, keep old preview)
//      (strict depth compare relaxed to non-strict so the re-issued draw is not
//       occluded by the depth it wrote during commitThroughDraw(N) -- relaxDepthCompare)
//   5. re-encode target draw onto the live color RT -> renderRtToCanvas -> canvas
//
// OOS-1 invariants:
//   - never calls replay.commitThroughDraw with edited WGSL, never writes the tape,
//     never touches recorder/replayer state machine, never mutates the _session cache.
//   - the caller is expected to have already run commitThroughDraw(drawIdx) on the
//     ORIGINAL shader (the TextureViewer preview path) so the live handleMap holds
//     the draw's buffers / bind groups / RT view. We only swap the pipeline for a
//     single re-encoded draw, then read back. reset()/commitThroughDraw on the
//     original WGSL fully restores the live RT (the Reset button path).
//
// Related: requirements AC-02/AC-03/AC-04; plan-strategy D-1/D-3; research Finding 3/4.

/// <reference types="@webgpu/types" />

import type { ShaderError } from '@forgeax/engine-naga';
import { parse, validate } from '@forgeax/engine-naga';
import type {
  RenderPipeline,
  RhiDevice,
  RhiError,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import type { HandleId, Replay, RhiCallEvent } from '@forgeax/engine-rhi-debug';
import { renderRtToCanvas } from '@forgeax/engine-rhi-debug/rt-to-canvas';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import type { Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

// ============================================================================
// Public types
// ============================================================================

/** Which shader stage the editor is targeting (the module to swap). */
export type EditStage = 'vertex' | 'fragment';

/**
 * Everything the apply path needs to re-encode the selected draw. Built by the
 * caller (CodeMirrorShader) from the viewer's tape + replay session + selection.
 * All fields are read-only consumption of existing viewer state (no new basetech).
 */
export interface CompileRenderContext {
  /** The active replay session (already committed-through the selected draw). */
  readonly replay: Replay;
  /** The replay session device (from replay-session.ts; never re-created here). */
  readonly device: RhiDevice;
  /** Raw recorded events (tape.events) for draw-context reconstruction. */
  readonly events: readonly RhiCallEvent[];
  /** The global draw index currently selected in the viewer. */
  readonly drawIdx: number;
  /** Which stage's WGSL was edited (decides which pipeline module to swap). */
  readonly stage: EditStage;
  /** Target canvas to paint the recompiled preview onto. */
  readonly canvas: HTMLCanvasElement;
}

/**
 * Structured compile/render failure. `phase` keys the error source so the UI can
 * apply line annotations per D-3 priority (parse/gpu-compile carry line numbers;
 * validate does not).
 */
export type CompileError =
  | { readonly phase: 'parse'; readonly error: ShaderError }
  | { readonly phase: 'validate'; readonly error: ShaderError }
  | { readonly phase: 'gpu-compile'; readonly error: RhiError }
  | { readonly phase: 'pipeline'; readonly error: RhiError }
  | { readonly phase: 'no-pipeline-event'; readonly message: string }
  | { readonly phase: 'no-draw'; readonly message: string }
  | { readonly phase: 'render'; readonly message: string };

// ============================================================================
// Event variant types — extracted from the SSOT RhiCallEvent closed union
// (packages/rhi-debug/src/types.ts) so switch(ev.kind) narrows automatically.
// ============================================================================

type BeginPassEvent = Extract<RhiCallEvent, { kind: 'beginRenderPass' }>;
type VertexBufferEvent = Extract<RhiCallEvent, { kind: 'setVertexBuffer' }>;
type IndexBufferEvent = Extract<RhiCallEvent, { kind: 'setIndexBuffer' }>;
type BindGroupEvent = Extract<RhiCallEvent, { kind: 'setBindGroup' }>;
type DrawEvent = Extract<RhiCallEvent, { kind: 'draw' }>;
type DrawIndexedEvent = Extract<RhiCallEvent, { kind: 'drawIndexed' }>;
type CreatePipelineEvent = Extract<RhiCallEvent, { kind: 'createRenderPipeline' }>;

function isDrawEvent(
  ev: RhiCallEvent,
): ev is DrawEvent | DrawIndexedEvent | Extract<RhiCallEvent, { kind: 'dispatchWorkgroups' }> {
  return ev.kind === 'draw' || ev.kind === 'drawIndexed' || ev.kind === 'dispatchWorkgroups';
}

// ============================================================================
// Draw context reconstruction
// ============================================================================

/** Everything recorded about the selected draw's render pass that we re-issue. */
interface DrawContext {
  readonly passHandleId: HandleId;
  readonly beginPass: BeginPassEvent;
  readonly pipelineHandleId: HandleId;
  readonly vertexBuffers: readonly VertexBufferEvent[];
  readonly indexBuffer: IndexBufferEvent | undefined;
  readonly bindGroups: readonly BindGroupEvent[];
  readonly draw: DrawEvent | DrawIndexedEvent;
}

/**
 * Walk events to the target draw, accumulating the bound pipeline / vertex
 * buffers / index buffer / bind groups for the draw's pass. Mirrors the state
 * accumulation in inspect-core.scanPassStates / extractDrawInfo so the re-encode
 * matches what the recorder captured.
 */
function buildDrawContext(
  events: readonly RhiCallEvent[],
  targetDrawIdx: number,
): Result<DrawContext, CompileError> {
  let globalDrawIdx = 0;
  let currentPass: BeginPassEvent | undefined;
  let pipelineHandleId: HandleId | undefined;
  const vertexBuffers = new Map<number, VertexBufferEvent>();
  let indexBuffer: IndexBufferEvent | undefined;
  const bindGroups = new Map<number, BindGroupEvent>();

  for (const ev of events) {
    switch (ev.kind) {
      case 'beginRenderPass':
        currentPass = ev;
        pipelineHandleId = undefined;
        vertexBuffers.clear();
        indexBuffer = undefined;
        bindGroups.clear();
        break;
      case 'endRenderPass':
        currentPass = undefined;
        break;
      case 'setPipeline':
        pipelineHandleId = ev.pipelineHandleId;
        break;
      case 'setVertexBuffer':
        vertexBuffers.set(ev.slot, ev);
        break;
      case 'setIndexBuffer':
        indexBuffer = ev;
        break;
      case 'setBindGroup':
        bindGroups.set(ev.index, ev);
        break;
      default:
        break;
    }

    if (isDrawEvent(ev)) {
      if (globalDrawIdx === targetDrawIdx) {
        if (ev.kind === 'dispatchWorkgroups' || currentPass === undefined) {
          return err({
            phase: 'no-draw',
            message: `draw ${targetDrawIdx} is not a render-pass draw; preview is render-only`,
          });
        }
        if (pipelineHandleId === undefined) {
          return err({
            phase: 'no-draw',
            message: `draw ${targetDrawIdx} has no bound render pipeline`,
          });
        }
        return ok({
          passHandleId: currentPass.passHandleId,
          beginPass: currentPass,
          pipelineHandleId,
          vertexBuffers: [...vertexBuffers.values()],
          ...(indexBuffer !== undefined ? { indexBuffer } : { indexBuffer: undefined }),
          bindGroups: [...bindGroups.values()],
          draw: ev,
        });
      }
      globalDrawIdx++;
    }
  }

  return err({
    phase: 'no-draw',
    message: `draw ${targetDrawIdx} not found in tape`,
  });
}

/** Locate the createRenderPipeline event that produced the draw's pipeline. */
function findPipelineEvent(
  events: readonly RhiCallEvent[],
  pipelineHandleId: HandleId,
): CreatePipelineEvent | undefined {
  for (const ev of events) {
    if (ev.kind === 'createRenderPipeline' && ev.handleId === pipelineHandleId) {
      return ev;
    }
  }
  return undefined;
}

// ============================================================================
// Pipeline rebuild (recorded desc + new module)
// ============================================================================

/**
 * Relax a strict depth compare to its non-strict sibling for the preview re-encode.
 *
 * The caller commits-through-draw N before this path runs (CodeMirrorShader, the
 * D-1 precondition), which leaves the live depth attachment holding draw N's OWN
 * depth. The preview then re-issues draw N with `depthLoadOp: 'load'` (encodeDraw),
 * so the re-drawn fragment is depth-tested against the depth it just wrote: z == z.
 * Under the recorded `'less'` / `'greater'` (reverse-Z) compare, equal FAILS and
 * every fragment is discarded -- the edited shader compiles and the pipeline
 * rebuilds, yet the preview never changes (status reports ok). Relaxing to
 * `'less-equal'` / `'greater-equal'` lets the self-equal re-draw pass while
 * fragments strictly behind a CLOSER earlier draw (stored depth from a different
 * draw) stay correctly culled. Non-strict / order-independent compares
 * (`'always'`, `'equal'`, `'less-equal'`, `'greater-equal'`, ...) are left as-is.
 */
export function relaxDepthCompare(compare: unknown): unknown {
  if (compare === 'less') return 'less-equal';
  if (compare === 'greater') return 'greater-equal';
  return compare;
}

/**
 * Rebuild the draw's render pipeline with the recompiled shader module swapped
 * into the edited stage. Mirrors replayer.replayCreateRenderPipeline: pull the
 * recorded desc, resolve the live layout + the unedited stage's live module from
 * the handleMap, set the edited stage's module to the freshly compiled handle.
 */
function rebuildPipeline(
  device: RhiDevice,
  replay: Replay,
  pipelineEvent: CreatePipelineEvent,
  stage: EditStage,
  newModule: unknown,
): Result<RenderPipeline, CompileError> {
  const resolve = (id: HandleId): unknown => replay._resolveHandle(id);

  let layout: unknown = 'auto';
  if (pipelineEvent.layoutHandleId !== 'layout:auto') {
    const pl = resolve(pipelineEvent.layoutHandleId);
    if (pl !== undefined) layout = pl;
  }

  const desc: Record<string, unknown> = { ...pipelineEvent.desc, layout };

  // Relax a strict depth compare so the re-issued draw is not occluded by the
  // depth it wrote during the caller's commitThroughDraw(N) (see relaxDepthCompare).
  if (desc.depthStencil !== undefined && desc.depthStencil !== null) {
    const ds = desc.depthStencil as Record<string, unknown>;
    if ('depthCompare' in ds) {
      desc.depthStencil = { ...ds, depthCompare: relaxDepthCompare(ds.depthCompare) };
    }
  }

  // Resolve the unedited stage's live module from the handleMap; swap the edited
  // stage's module with the recompiled one.
  const vId = pipelineEvent.vertexShaderModuleHandleId;
  const fId = pipelineEvent.fragmentShaderModuleHandleId;

  if (desc.vertex !== undefined) {
    const vMod = stage === 'vertex' ? newModule : vId !== undefined ? resolve(vId) : undefined;
    if (vMod !== undefined) {
      desc.vertex = { ...(desc.vertex as Record<string, unknown>), module: vMod };
    }
  }
  if (desc.fragment !== undefined) {
    const fMod = stage === 'fragment' ? newModule : fId !== undefined ? resolve(fId) : undefined;
    if (fMod !== undefined) {
      desc.fragment = { ...(desc.fragment as Record<string, unknown>), module: fMod };
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: recorded desc is a structural mirror of RenderPipelineDescriptor
  const result = device.createRenderPipeline(desc as any);
  if (!result.ok) {
    return err({ phase: 'pipeline', error: result.error });
  }
  return ok(result.value);
}

// ============================================================================
// Re-encode the single target draw onto the live RT
// ============================================================================

/**
 * Rebuild the begin-render-pass desc with live views, mirroring
 * replayer.replayBeginRenderPass. loadOp 'load' preserves the cumulative
 * draws-0..N pixels already painted by the caller's commitThroughDraw(N), so the
 * re-issued draw N overwrites its own original pixels on top of the existing
 * frame. (commitThroughDraw is inclusive of draw N -- the depth it writes is why
 * the preview pipeline relaxes the depth compare; see relaxDepthCompare.)
 */
function buildPassDescriptor(
  begin: BeginPassEvent,
  resolve: (id: HandleId) => unknown,
): Record<string, unknown> {
  const colorAttachments: Array<Record<string, unknown> | null | undefined> = [];
  let attachIdx = 0;
  for (const attachment of begin.desc.colorAttachments) {
    if (attachment === null || attachment === undefined) {
      colorAttachments.push(attachment);
    } else {
      const viewHandleId = begin.colorAttachmentViewHandleIds[attachIdx];
      const entry: Record<string, unknown> = { ...attachment, loadOp: 'load', storeOp: 'store' };
      if (viewHandleId !== undefined) {
        const view = resolve(viewHandleId);
        if (view !== undefined) entry.view = view;
      }
      colorAttachments.push(entry);
    }
    attachIdx++;
  }

  const passDesc: Record<string, unknown> = { label: 'f2-preview-pass', colorAttachments };
  if (begin.depthStencilViewHandleId !== undefined && begin.desc.depthStencilAttachment) {
    const dsView = resolve(begin.depthStencilViewHandleId);
    if (dsView !== undefined) {
      passDesc.depthStencilAttachment = {
        ...begin.desc.depthStencilAttachment,
        view: dsView,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      };
    }
  }
  return passDesc;
}

/**
 * Record set-pipeline / set-buffers / set-bind-groups / draw onto the pass. Ends
 * the pass on a missing live handle and returns the structured error.
 */
function recordDrawCommands(
  pass: RhiRenderPassEncoder,
  ctx: DrawContext,
  pipeline: RenderPipeline,
  resolve: (id: HandleId) => unknown,
): Result<void, CompileError> {
  pass.setPipeline(pipeline);

  for (const vb of ctx.vertexBuffers) {
    const buf = resolve(vb.bufferHandleId);
    if (buf === undefined) {
      pass.end();
      return err({ phase: 'render', message: `vertex buffer ${vb.slot} not live in replay` });
    }
    // biome-ignore lint/suspicious/noExplicitAny: buf is an opaque branded Buffer handle
    pass.setVertexBuffer(vb.slot, buf as any, vb.offset, vb.size);
  }

  if (ctx.indexBuffer !== undefined) {
    const ib = ctx.indexBuffer;
    const buf = resolve(ib.bufferHandleId);
    if (buf === undefined) {
      pass.end();
      return err({ phase: 'render', message: 'index buffer not live in replay' });
    }
    // biome-ignore lint/suspicious/noExplicitAny: buf is an opaque branded Buffer handle
    pass.setIndexBuffer(buf as any, ib.format, ib.offset, ib.size);
  }

  for (const bg of ctx.bindGroups) {
    const group = resolve(bg.bindGroupHandleId);
    if (group === undefined) {
      pass.end();
      return err({ phase: 'render', message: `bind group ${bg.index} not live in replay` });
    }
    const offsets = bg.dynamicOffsets ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: group is an opaque branded BindGroup handle
    pass.setBindGroup(bg.index, group as any, offsets);
  }

  if (ctx.draw.kind === 'drawIndexed') {
    const d = ctx.draw;
    pass.drawIndexed(d.indexCount, d.instanceCount, d.firstIndex, d.baseVertex, d.firstInstance);
  } else {
    const d = ctx.draw;
    pass.draw(d.vertexCount, d.instanceCount, d.firstVertex, d.firstInstance);
  }

  pass.end();
  return ok(undefined);
}

function encodeDraw(
  device: RhiDevice,
  replay: Replay,
  ctx: DrawContext,
  pipeline: RenderPipeline,
): Result<void, CompileError> {
  const resolve = (id: HandleId): unknown => replay._resolveHandle(id);

  const encResult = device.createCommandEncoder({ label: 'f2-preview' });
  if (!encResult.ok) {
    return err({
      phase: 'render',
      message: `createCommandEncoder failed: ${encResult.error.code}`,
    });
  }
  const encoder = encResult.value;

  const passDesc = buildPassDescriptor(ctx.beginPass, resolve);
  // biome-ignore lint/suspicious/noExplicitAny: passDesc is a structural mirror of GPURenderPassDescriptor
  const pass = encoder.beginRenderPass(passDesc as any);

  const recordResult = recordDrawCommands(pass, ctx, pipeline, resolve);
  if (!recordResult.ok) {
    return recordResult;
  }

  const finishResult = encoder.finish();
  if (!finishResult.ok) {
    return err({ phase: 'render', message: `encoder.finish failed: ${finishResult.error.code}` });
  }
  const submitResult = device.queue.submit([finishResult.value]);
  if (!submitResult.ok) {
    return err({ phase: 'render', message: `queue.submit failed: ${submitResult.error.code}` });
  }
  return ok(undefined);
}

// ============================================================================
// compileAndRenderShader -- the public entry
// ============================================================================

/**
 * Compile edited WGSL and preview it on the selected draw (D-1). On success the
 * recompiled draw is painted onto `context.canvas`. On failure returns a
 * structured CompileError keyed by phase; the caller maps it to inline lint
 * diagnostics (D-3 line-number priority).
 *
 * The caller MUST have run replay.commitThroughDraw(context.drawIdx) on the
 * original shader before calling this so the live handleMap holds the draw's
 * buffers / bind groups / RT view. Reset is the caller's job (re-run the original
 * commitThroughDraw render); this function never resets or writes the tape.
 */
export async function compileAndRenderShader(
  newWgsl: string,
  context: CompileRenderContext,
): Promise<Result<{ readonly canvas: HTMLCanvasElement }, CompileError>> {
  const { replay, device, events, drawIdx, stage, canvas } = context;

  // Phase 1: naga parse (line numbers available on failure).
  const parsed = await parse(newWgsl);
  if (!parsed.ok) {
    return err({ phase: 'parse', error: parsed.error });
  }

  // Phase 2: naga validate (lineNum undefined on failure -- D-3).
  const validated = await validate(parsed.value);
  if (!validated.ok) {
    return err({ phase: 'validate', error: validated.error });
  }

  // Phase 3: GPU createShaderModule (compilerMessages with line numbers on failure).
  const moduleResult = await createShaderModule(device, { code: newWgsl });
  if (!moduleResult.ok) {
    return err({ phase: 'gpu-compile', error: moduleResult.error });
  }

  // Reconstruct the draw's render-pass context from the recorded events.
  const ctxResult = buildDrawContext(events, drawIdx);
  if (!ctxResult.ok) {
    return err(ctxResult.error);
  }
  const drawCtx = ctxResult.value;

  // Locate the recorded pipeline so we can rebuild it with the new module.
  const pipelineEvent = findPipelineEvent(events, drawCtx.pipelineHandleId);
  if (pipelineEvent === undefined) {
    return err({
      phase: 'no-pipeline-event',
      message: `createRenderPipeline event for ${drawCtx.pipelineHandleId} not found in tape`,
    });
  }

  // Phase 4: rebuild the pipeline (layout-incompatible -> keep old preview).
  const pipelineResult = rebuildPipeline(device, replay, pipelineEvent, stage, moduleResult.value);
  if (!pipelineResult.ok) {
    return err(pipelineResult.error);
  }

  // Phase 5: re-encode the single draw onto the live RT, then read it back.
  const encodeResult = encodeDraw(device, replay, drawCtx, pipelineResult.value);
  if (!encodeResult.ok) {
    return err(encodeResult.error);
  }

  const rtResult = await renderRtToCanvas(replay, drawIdx, device, canvas);
  if (!rtResult.ok) {
    return err({ phase: 'render', message: `renderRtToCanvas failed: ${rtResult.error.code}` });
  }

  return ok({ canvas });
}
