// feat-20260623-dummy-null-rhi-headless-backend / M3 / w18
// RhiNull no-op behavior aggregate unit test (AC-09/10/11/13)
//
// Four scenarios covering the RhiNull backend's no-op behavior guarantees:
//   1. createShaderModule returns ok(brand) — skip WGSL compile (AC-10)
//   2. acquireCanvasContext returns ok(canvasContext) — headless surface
//      (AC-11 [R1]: ok is the correct headless success semantic; the returned
//       context's getCurrentTexture yields a legal Texture brand, no pixels)
//   3. Cross-device handle rejection (AC-09): deviceA's buffer on deviceB →
//      err({code:'rhi-not-available',...}); destroy-before-use →
//      err({code:'destroy-after-destroy',...})
//   4. All err values carry non-empty code / expected / hint triple (charter P3)
//
// See plan-tasks.json M3 acceptanceCheck for the full scenario matrix.

import type { Result, RhiError } from '@forgeax/engine-rhi';
import type { RhiNullDevice } from '@forgeax/engine-rhi-null';
import { rhi } from '@forgeax/engine-rhi-null';
import { afterEach, describe, expect, it } from 'vitest';

function assertTriple(err: RhiError): void {
  expect(typeof err.code).toBe('string');
  expect((err.code as string).length).toBeGreaterThan(0);
  expect(typeof err.expected).toBe('string');
  expect((err.expected as string).length).toBeGreaterThan(0);
  expect(typeof err.hint).toBe('string');
  expect((err.hint as string).length).toBeGreaterThan(0);
}

describe('rhi-null-noop-behavior.unit.test.ts', () => {
  let deviceA: RhiNullDevice;
  let deviceB: RhiNullDevice;

  afterEach(() => {
    deviceA = undefined as unknown as RhiNullDevice;
    deviceB = undefined as unknown as RhiNullDevice;
  });

  async function bootDevices(): Promise<void> {
    const adapterResultA = await rhi.requestAdapter();
    expect(adapterResultA.ok).toBe(true);
    if (!adapterResultA.ok) return;
    const deviceResultA = await adapterResultA.value.requestDevice();
    expect(deviceResultA.ok).toBe(true);
    if (!deviceResultA.ok) return;
    deviceA = deviceResultA.value as unknown as RhiNullDevice;

    const adapterResultB = await rhi.requestAdapter();
    expect(adapterResultB.ok).toBe(true);
    if (!adapterResultB.ok) return;
    const deviceResultB = await adapterResultB.value.requestDevice();
    expect(deviceResultB.ok).toBe(true);
    if (!deviceResultB.ok) return;
    deviceB = deviceResultB.value as unknown as RhiNullDevice;
  }

  describe('AC-10: createShaderModule returns ok(brand)', () => {
    it('returns ok (skips WGSL compile)', async () => {
      await bootDevices();
      const result = await (
        rhi as unknown as {
          createShaderModule: (d: unknown, desc: unknown) => Promise<Result<unknown, RhiError>>;
        }
      ).createShaderModule(deviceA as unknown, {
        label: 'test',
        code: '@vertex fn main() -> @builtin(position) vec4f { return vec4f(0); }',
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('AC-11: acquireCanvasContext returns ok(canvasContext)', () => {
    it('returns ok with a headless canvas context', async () => {
      const result = rhi.acquireCanvasContext();
      expect(result.ok).toBe(true);
    });

    it('returned context.getCurrentTexture() returns valid Texture brand', async () => {
      const ctxResult = rhi.acquireCanvasContext();
      expect(ctxResult.ok).toBe(true);
      if (!ctxResult.ok) return;
      const ctx = ctxResult.value;
      const texResult = ctx.getCurrentTexture();
      // Headless CI: getCurrentTexture returns a legal opaque-handle Texture
      // brand so the swap-chain acquisition path in recordFrame never blocks
      // rendering. The brand carries no real pixels but is structurally valid.
      expect(texResult.ok).toBe(true);
    });

    it('acquireCanvasContext with null canvas still returns ok', async () => {
      const result = rhi.acquireCanvasContext(null);
      expect(result.ok).toBe(true);
    });

    it('acquireCanvasContext with undefined canvas still returns ok', async () => {
      const result = rhi.acquireCanvasContext(undefined);
      expect(result.ok).toBe(true);
    });
  });

  describe('AC-09: handle-chain consistency', () => {
    it('cross-device setVertexBuffer records err(rhi-not-available)', async () => {
      await bootDevices();
      const bufResultA = deviceA.createBuffer({
        size: 64,
        usage: 0x20,
      } as never);
      expect(bufResultA.ok).toBe(true);
      if (!bufResultA.ok) return;
      const bufA = bufResultA.value;

      const encResultB = deviceB.createCommandEncoder();
      expect(encResultB.ok).toBe(true);
      if (!encResultB.ok) return;
      const encB = encResultB.value;
      const passB = encB.beginRenderPass({ colorAttachments: [] } as never);
      passB.setVertexBuffer(0, bufA, undefined, undefined);
      // Validation stored on pass encoder (spec method is void — no throw)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pass = passB as unknown as { lastValidation: Result<unknown, RhiError> };
      expect(pass.lastValidation.ok).toBe(false);
      if (!pass.lastValidation.ok) {
        expect(pass.lastValidation.error.code).toBe('rhi-not-available');
        assertTriple(pass.lastValidation.error);
      }
      passB.end();
    });

    it('destroy-after-destroy returns err(destroy-after-destroy)', async () => {
      await bootDevices();
      const bufResult = deviceA.createBuffer({
        size: 64,
        usage: 0x20,
      } as never);
      expect(bufResult.ok).toBe(true);
      if (!bufResult.ok) return;
      const buf = bufResult.value;

      const destroy1 = deviceA.destroyBuffer(buf);
      expect(destroy1.ok).toBe(true);

      const destroy2 = deviceA.destroyBuffer(buf);
      expect(destroy2.ok).toBe(false);
      if (!destroy2.ok) {
        expect(destroy2.error.code).toBe('destroy-after-destroy');
        assertTriple(destroy2.error);
      }
    });
  });

  describe('Multi-renderer isolation: independent bookkeeping', () => {
    it('two device instances have distinct deviceIds', async () => {
      await bootDevices();
      expect(deviceA.bookkeeper.deviceId).not.toBe(deviceB.bookkeeper.deviceId);
    });

    it('handle from deviceA is foreign to deviceB', async () => {
      await bootDevices();
      const bufResult = deviceA.createBuffer({
        size: 64,
        usage: 0x20,
      } as never);
      expect(bufResult.ok).toBe(true);
      if (!bufResult.ok) return;
      const buf = bufResult.value;

      const ownershipCheck = deviceB.bookkeeper.validateOwnership(buf);
      expect(ownershipCheck.ok).toBe(false);
      if (!ownershipCheck.ok) {
        expect(ownershipCheck.error.code).toBe('rhi-not-available');
      }
    });
  });

  describe('AC-13: RhiNull is usable in a pure unit context (no dawn/browser)', () => {
    it('rhi singleton imports and exposes the headless backend surface', () => {
      // This test running at all proves AC-13: the file is collected by the
      // default vitest (test:unit) project and RhiNull resolves without any
      // dawn-node / browser / WebGPU global. Assert the real surface rather
      // than a tautology so the check has discriminating power.
      expect(typeof rhi.acquireCanvasContext).toBe('function');
      expect(typeof rhi.createShaderModule).toBe('function');
      expect(typeof globalThis.navigator?.gpu).not.toBe('object');
    });

    it('a fresh device reports the null backend without touching a GPU', async () => {
      const adapterResult = await rhi.requestAdapter();
      expect(adapterResult.ok).toBe(true);
      if (!adapterResult.ok) return;
      const deviceResult = await adapterResult.value.requestDevice();
      expect(deviceResult.ok).toBe(true);
      if (!deviceResult.ok) return;
      expect(deviceResult.value.caps.backendKind).toBe('null');
    });
  });
});
