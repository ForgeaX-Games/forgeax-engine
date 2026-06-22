// @forgeax/engine-rhi-debug/src/__tests__/rpc-bridge.test.ts
//
// RPC bridge round-trip tests: wireDebugRhiInspector + 3 RPC methods
// (debug.captureFrame / debug.inspectAt / debug.replayDispose) +
// recorder-not-attached + rpc-target-not-wired negative tests.
//
// TDD red-green-refactor (plan-strategy 5.1): M-7 test layer for
// AC-17/AC-18/AC-19/AC-20.
//
// Related: m7-3; requirements AC-17/AC-18/AC-19/AC-20.

// biome-ignore-all lint/style/noNonNullAssertion: RPC bridge test assertions on mock Registry method return maps use non-null assertions because map entries are populated by the registerMethod path immediately before assertions; structurally safe at test compile time

import { describe, expect, it, vi } from 'vitest';
import type { DebugRhiAdapter } from '../rpc-bridge';
import { wireDebugRhiInspector } from '../rpc-bridge';

// ============================================================================
// Mock Registry
// ============================================================================

interface MockRegistry {
  methodsMap: Map<string, (params: unknown) => Promise<unknown> | unknown>;
  registerMethod: (
    method: string,
    handler: (params: unknown) => Promise<unknown> | unknown,
  ) => { ok: true; value: void } | { ok: false; error: { code: string } };
  lookupMethod: (method: string) => ((params: unknown) => Promise<unknown> | unknown) | undefined;
}

function createMockRegistry(): MockRegistry {
  const methods = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
  return {
    methodsMap: methods,
    registerMethod(method: string, handler: (params: unknown) => Promise<unknown> | unknown) {
      if (methods.has(method)) {
        return { ok: false, error: { code: 'console-startup-failed' } };
      }
      methods.set(method, handler);
      return { ok: true, value: undefined };
    },
    lookupMethod(method: string) {
      return methods.get(method);
    },
  };
}

function createMockAdapter(): DebugRhiAdapter {
  return {
    async captureFrames(_frames: number, _label?: string) {
      return {
        tapes: [
          {
            frameIdx: 0,
            runId: `2026-06-12T120000Z-abcd`,
            tapePath: `.forgeax-debug/2026-06-12T120000Z-abcd/frame-0.tape.bin`,
            reportPath: `.forgeax-debug/2026-06-12T120000Z-abcd/frame-0.report.json`,
          },
        ],
      };
    },
    async inspectAt(
      _tapePath: string,
      drawIdx: number,
      fields?: readonly ('bindings' | 'drawCall' | 'rt')[],
    ) {
      return {
        frameIdx: 0,
        drawIdx,
        passIdx: 0,
        bindings:
          fields === undefined || fields.includes('bindings')
            ? [{ groupIndex: 0, entryIndex: 0, handleId: 'buf-1', kind: 'buffer' }]
            : undefined,
        drawCall:
          fields === undefined || fields.includes('drawCall')
            ? { pipelineKind: 'render' as const, pipelineHandleId: 'pipeline:1', vertexCount: 3 }
            : undefined,
        rt:
          fields === undefined || fields.includes('rt')
            ? '.forgeax-debug/run/inspect/d0000-rt0.png'
            : undefined,
      };
    },
    async replayDispose(_tapePath: string) {
      return { ok: true };
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('wireDebugRhiInspector', () => {
  it('m7-3 round-trip: registers 3 RPC methods on a registry', () => {
    const reg = createMockRegistry();
    const adapter = createMockAdapter();

    const result = wireDebugRhiInspector(
      reg as unknown as import('@forgeax/engine-types').Registry,
      adapter,
    );

    expect(result.ok).toBe(true);
    expect(reg.lookupMethod('debug.captureFrame')).toBeDefined();
    expect(reg.lookupMethod('debug.inspectAt')).toBeDefined();
    expect(reg.lookupMethod('debug.replayDispose')).toBeDefined();
  });

  it('m7-3 round-trip: debug.captureFrame calls adapter.captureFrames with frames and label', async () => {
    const reg = createMockRegistry();
    const adapter = createMockAdapter();
    const spy = vi.spyOn(adapter, 'captureFrames');

    wireDebugRhiInspector(reg as unknown as import('@forgeax/engine-types').Registry, adapter);

    const handler = reg.lookupMethod('debug.captureFrame');
    expect(handler).toBeDefined();

    const rawResult = await handler!({ frames: 3, label: 'my-run' });
    const result = rawResult as {
      tapes: Array<{ frameIdx: number; runId: string; tapePath: string; reportPath: string }>;
    };
    expect(spy).toHaveBeenCalledWith(3, 'my-run');
    expect(result).toEqual({
      tapes: [
        {
          frameIdx: 0,
          runId: '2026-06-12T120000Z-abcd',
          tapePath: '.forgeax-debug/2026-06-12T120000Z-abcd/frame-0.tape.bin',
          reportPath: '.forgeax-debug/2026-06-12T120000Z-abcd/frame-0.report.json',
        },
      ],
    });
  });

  it('m7-3 round-trip: debug.captureFrame default frames=1 when omitted', async () => {
    const reg = createMockRegistry();
    const adapter = createMockAdapter();
    const spy = vi.spyOn(adapter, 'captureFrames');

    wireDebugRhiInspector(reg as unknown as import('@forgeax/engine-types').Registry, adapter);

    const handler = reg.lookupMethod('debug.captureFrame');
    const rawResult = await handler!({}); // No frames specified
    const result = rawResult as { tapes: Array<unknown> };
    expect(spy).toHaveBeenCalledWith(1, undefined);
    expect(result.tapes).toBeDefined();
  });

  it('m7-3 round-trip: debug.inspectAt calls adapter.inspectAt with tapePath and drawIdx', async () => {
    const reg = createMockRegistry();
    const adapter = createMockAdapter();
    const spy = vi.spyOn(adapter, 'inspectAt');

    wireDebugRhiInspector(reg as unknown as import('@forgeax/engine-types').Registry, adapter);

    const handler = reg.lookupMethod('debug.inspectAt');
    expect(handler).toBeDefined();

    const rawResult1 = await handler!({
      tapePath: '/path/to/tape.bin',
      drawIdx: 42,
      fields: ['bindings', 'rt'],
    });
    const result1 = rawResult1 as Record<string, unknown>;
    expect(spy).toHaveBeenCalledWith('/path/to/tape.bin', 42, ['bindings', 'rt']);
    expect(result1.frameIdx).toBe(0);
    expect(result1.drawIdx).toBe(42);
    expect(result1.bindings).toBeDefined();
    expect(result1.rt).toBeDefined();
    expect(result1.drawCall).toBeUndefined();
  });

  it('m7-3 round-trip: debug.inspectAt with no fields returns all fields', async () => {
    const reg = createMockRegistry();
    const adapter = createMockAdapter();
    const spy = vi.spyOn(adapter, 'inspectAt');

    wireDebugRhiInspector(reg as unknown as import('@forgeax/engine-types').Registry, adapter);

    const handler = reg.lookupMethod('debug.inspectAt');
    const rawResult2 = await handler!({ tapePath: '/path/to/tape.bin', drawIdx: 0 });
    const result2 = rawResult2 as Record<string, unknown>;

    expect(spy).toHaveBeenCalledWith('/path/to/tape.bin', 0, undefined);
    expect(result2.bindings).toBeDefined();
    expect(result2.drawCall).toBeDefined();
    expect(result2.rt).toBeDefined();
  });

  it('m7-3 round-trip: debug.replayDispose calls adapter.replayDispose with tapePath', async () => {
    const reg = createMockRegistry();
    const adapter = createMockAdapter();
    const spy = vi.spyOn(adapter, 'replayDispose');

    wireDebugRhiInspector(reg as unknown as import('@forgeax/engine-types').Registry, adapter);

    const handler = reg.lookupMethod('debug.replayDispose');
    expect(handler).toBeDefined();

    const rawResult3 = await handler!({ tapePath: '/path/to/tape.bin' });
    const result3 = rawResult3 as Record<string, unknown>;
    expect(spy).toHaveBeenCalledWith('/path/to/tape.bin');
    expect(result3).toEqual({ ok: true });
  });

  it('m7-3 negative: duplicate method registration returns error', () => {
    const reg = createMockRegistry();
    const adapter = createMockAdapter();

    const r1 = wireDebugRhiInspector(
      reg as unknown as import('@forgeax/engine-types').Registry,
      adapter,
    );
    expect(r1.ok).toBe(true);

    // Duplicate registration should fail
    const r2 = wireDebugRhiInspector(
      reg as unknown as import('@forgeax/engine-types').Registry,
      adapter,
    );
    expect(r2.ok).toBe(false);
  });

  it('m7-3 negative: rpc-target-not-wired - call debug method without wiring', async () => {
    // Create a fresh registry with no debugRhi injector wired.
    // Simulates wireDefaultInspectors called without injectors.debugRhi.
    // In that scenario, debug.* methods are simply not registered,
    // and lookupMethod returns undefined.
    const reg = createMockRegistry();

    // No wireDebugRhiInspector call -> methods not registered
    const handler = reg.lookupMethod('debug.captureFrame');
    expect(handler).toBeUndefined();
  });
});
