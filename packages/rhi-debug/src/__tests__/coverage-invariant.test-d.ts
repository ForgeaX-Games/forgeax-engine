// Type-level coverage invariant: every method on the three RHI encoder
// interfaces must map to either a captured RhiCallEvent kind or a
// DEFERRED_COMMANDS member. If a future method is added to any encoder
// without a matching entry, Exclude<keyof<Interface>, ...> becomes non-never
// and tsc fails — no human memory needed.
//
// AC-01: Uncovered = never for all three interfaces.
// AC-02: falsification variant proves the guard is sensitive.
//
// Two non-1:1 mappings per plan-strategy D-1:
//   1. Method `end` -> kind `endRenderPass` / `endComputePass`
//   2. Render-pass `pushDebugGroup` / `popDebugGroup` / `insertDebugMarker`
//      -> kind `passPushDebugGroup` / `passPopDebugGroup` / `passInsertDebugMarker`
//   3. Compute-pass `setPipeline` -> kind `setComputePipeline`
//      (method name identical on both interfaces, different kinds)

import type {
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { describe, expectTypeOf, it } from 'vitest';

// ---- CapturedMethods: all RHI method names that have a RhiCallEvent kind ----

type CapturedMethods =
  // RhiCommandEncoder methods (11 captured)
  | 'beginRenderPass'
  | 'beginComputePass'
  | 'copyBufferToBuffer' // overloaded, one keyof entry
  | 'copyBufferToTexture'
  | 'copyTextureToBuffer'
  | 'copyTextureToTexture'
  | 'clearBuffer'
  | 'pushDebugGroup' // encoder-level, maps to kind 'pushDebugGroup'
  | 'popDebugGroup' // encoder-level, maps to kind 'popDebugGroup'
  | 'insertDebugMarker' // encoder-level, maps to kind 'insertDebugMarker'
  | 'finish'
  // RhiRenderPassEncoder methods (16 captured)
  | 'setPipeline' // render pass: kind='setPipeline'; compute pass: kind='setComputePipeline'
  | 'setVertexBuffer'
  | 'setIndexBuffer'
  | 'setBindGroup' // overloaded, one keyof entry
  | 'draw'
  | 'drawIndexed'
  | 'setViewport'
  | 'setScissorRect'
  | 'setBlendConstant'
  | 'setStencilReference'
  | 'drawIndirect'
  | 'drawIndexedIndirect'
  // pushDebugGroup/popDebugGroup/insertDebugMarker on render pass exist as
  // methods BUT map to pass*DebugGroup kinds. The keyof name is still
  // pushDebugGroup/popDebugGroup/insertDebugMarker (covered above).
  | 'end' // render pass: kind='endRenderPass'; compute pass: kind='endComputePass'
  // RhiComputePassEncoder methods (1 unique, others shared above)
  | 'dispatchWorkgroups';

// ---- DeferredMethods: RHI method names in DEFERRED_COMMANDS (AC-06) ----

type DeferredMethods =
  | 'beginOcclusionQuery'
  | 'endOcclusionQuery'
  | 'executeBundles'
  | 'writeTimestamp'
  | 'resolveQuerySet';

// ---- Per-interface coverage assertions (AC-01) ----

describe('RhiCommandEncoder coverage', () => {
  it('every method is captured or deferred (AC-01)', () => {
    type Uncovered = Exclude<keyof RhiCommandEncoder, CapturedMethods | DeferredMethods>;
    expectTypeOf<Uncovered>().toEqualTypeOf<never>();
  });
});

describe('RhiRenderPassEncoder coverage', () => {
  it('every method is captured or deferred (AC-01)', () => {
    type Uncovered = Exclude<keyof RhiRenderPassEncoder, CapturedMethods | DeferredMethods>;
    expectTypeOf<Uncovered>().toEqualTypeOf<never>();
  });
});

describe('RhiComputePassEncoder coverage', () => {
  it('every method is captured or deferred (AC-01)', () => {
    type Uncovered = Exclude<keyof RhiComputePassEncoder, CapturedMethods | DeferredMethods>;
    expectTypeOf<Uncovered>().toEqualTypeOf<never>();
  });
});

// ---- AC-02 falsification: prove the guard catches omissions ----

describe('AC-02 falsification', () => {
  it('forgetting a method from CapturedMethods makes Uncovered non-never', () => {
    // Simulate: forget to include 'copyBufferToBuffer' in CapturedMethods.
    // Then Exclude should surface 'copyBufferToBuffer' (non-never).
    type ForgotCopyBufferToBuffer = Exclude<CapturedMethods, 'copyBufferToBuffer'>;
    type DetectedForgotten = Exclude<
      keyof RhiCommandEncoder,
      ForgotCopyBufferToBuffer | DeferredMethods
    >;
    // The forgotten method is detected — DetectedForgotten equals 'copyBufferToBuffer'
    expectTypeOf<DetectedForgotten>().toEqualTypeOf<'copyBufferToBuffer'>();
    // And it is not never — the guard is sensitive
    expectTypeOf<DetectedForgotten>().not.toEqualTypeOf<never>();
  });

  it('original CapturedMethods is complete (DetectedForgotten was just the one we removed)', () => {
    // Sanity check: without the deliberate omission, Uncovered = never.
    // This doubles as a regression test that CapturedMethods is correctly maintained.
    type Uncovered = Exclude<keyof RhiCommandEncoder, CapturedMethods | DeferredMethods>;
    expectTypeOf<Uncovered>().toEqualTypeOf<never>();
  });
});
