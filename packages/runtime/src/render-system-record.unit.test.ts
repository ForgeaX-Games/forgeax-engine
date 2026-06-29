// render-system-record.unit.test.ts
// feat-20260615-pipeline-spec-ssot M6-T1-TEST.
//
// Reverse-evidence ("falsify the silent fallback") tests for the M6-T1
// deletion of `selectStandardFallbackPipeline`. The pre-M6 record stage
// silently fell back to URP `pipelineState.standardPipeline*` whenever the
// per-MaterialShader cache returned null and HDRP was inactive. M6 removes
// that branch: cache miss now resolves to null and the per-submesh draw is
// skipped (mirroring the HDRP-active and skin-shader miss-skip semantics
// that existed before). The fallback path is no longer reachable.
//
// What this file asserts:
//   1. The exported `selectStandardFallbackPipeline` symbol is gone --
//      grep gate at runtime via `import * as mod`.
//   2. `getOrBuildPipeline` throws `PipelineSpecError` on a build failure
//      rather than returning a silently-substituted boot-time fallback.
//      This is the charter P3 explicit-failure invariant the M6 cleanup
//      preserves end-to-end (no silent route remains in the chain).
//   3. The MSAA route (sampleCount=4) takes a distinct cache slot from the
//      non-MSAA route -- evidence that the record stage never folds the
//      MSAA path back onto a non-MSAA boot-prewarmed pipeline (the old
//      `selectGeometryPipeline(... 'standard', tonemapActive, msaaActive)`
//      branch did exactly that fold via the `*PipelineMsaa` field hand-off).
//
// Anchors:
//   - plan-strategy §M6 / D-2: silent fallback removal is the core invariant.
//   - implement-decisions §M6-T1: dedicated function + 1 record-stage call
//     site (line ~5080) go; the only remaining path through "shader cache
//     returned null" is `smPipelineHandle === null -> continue` skip-draw.

import { describe, expect, it } from 'vitest';

import {
  cacheKeyOf,
  getOrBuildPipeline,
  type PipelineDeviceProvider,
  type PipelineSpec,
  PipelineSpecError,
} from './pipeline-spec';

const SPEC_BASE: PipelineSpec = {
  shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
  attachments: {
    colorFormats: ['bgra8unorm-srgb' as unknown as GPUTextureFormat],
    depthFormat: 'depth24plus-stencil8' as unknown as GPUTextureFormat,
    sampleCount: 1,
  },
  geometry: {
    topology: 'triangle-list',
    vertexLayout: {
      position: new Float32Array(0),
    },
  },
  renderState: undefined,
};

const SPEC_MSAA: PipelineSpec = {
  ...SPEC_BASE,
  attachments: { ...SPEC_BASE.attachments, sampleCount: 4 },
};

describe('render-system-record M6-T1 silent fallback removal', () => {
  it('selectStandardFallbackPipeline export is gone (grep gate)', async () => {
    const mod = await import('./render-system-record');
    expect((mod as Record<string, unknown>).selectStandardFallbackPipeline).toBeUndefined();
  });

  it('getOrBuildPipeline throws PipelineSpecError on build failure (no silent fallback)', () => {
    const cache = new Map();
    const deviceProvider: PipelineDeviceProvider = {
      createRenderPipeline: () => ({
        ok: false,
        error: { code: 'webgpu-runtime-error', message: 'simulated build failure' },
      }),
    };
    let caught: unknown;
    try {
      getOrBuildPipeline(SPEC_BASE, deviceProvider, cache);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PipelineSpecError);
    expect((caught as PipelineSpecError).code).toBe('pipeline-build-failed');
    // Critical: no boot-time URP `standardPipeline` is substituted for the
    // failure. Charter P3 explicit failure surfaces upward; the record
    // stage's `if (smPipelineHandle === null) continue` then skip-draws.
  });

  it('MSAA route takes a distinct cache slot from non-MSAA (sampleCount=4)', () => {
    const baseKey = cacheKeyOf(SPEC_BASE);
    const msaaKey = cacheKeyOf(SPEC_MSAA);
    expect(baseKey).not.toBe(msaaKey);
    // The pre-M6 silent fallback could route an MSAA frame through
    // `pipelineState.standardPipelineMsaa` even when the per-shader cache
    // missed -- collapsing the MSAA spec onto the boot-prewarmed handle.
    // M6 removes that path; identity of the cache key is the witness that
    // sampleCount is part of the hash and never folds onto sampleCount=1.
  });
});
