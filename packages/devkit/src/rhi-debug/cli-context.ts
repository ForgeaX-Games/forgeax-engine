import { readFile } from 'node:fs/promises';
import { createRhiDebugError, replayDeviceRequest, type V7Tape } from '@forgeax/engine-rhi-debug';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { err } from '@forgeax/engine-types';
import type { ArtifactRef, RhiDebugOperationContext } from './operations.js';

export function createCliRhiDebugOperationContext(): RhiDebugOperationContext {
  return {
    captureFrame: async () =>
      err(
        createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause:
            'the standalone CLI has no live App capture provider; start a recorder-enabled live host and invoke its rhiCapture root',
        }),
      ),
    async readArtifact(artifact: ArtifactRef) {
      if (artifact.path === undefined) {
        return {
          ok: false as const,
          error: {
            code: 'artifact-path-missing',
            expected: 'ArtifactRef.path to identify a readable .rhitape file',
            hint: 'Pass the path returned by the capture host together with its digest.',
            detail: { digest: artifact.digest },
          },
        };
      }
      try {
        return { ok: true as const, value: new Uint8Array(await readFile(artifact.path)) };
      } catch (cause) {
        return {
          ok: false as const,
          error: {
            code: 'artifact-read-failed',
            expected: 'the ArtifactRef path to be readable',
            hint: 'Check the tape path and recapture if the artifact was removed.',
            detail: {
              path: artifact.path,
              reason: cause instanceof Error ? cause.message : String(cause),
            },
          },
        };
      }
    },
    async createReplayBackend(tape: V7Tape) {
      let createDawn: (options: readonly string[]) => GPU;
      let gpuGlobals: Record<string, unknown>;
      try {
        const dawn = await import('webgpu');
        createDawn = dawn.create as (options: readonly string[]) => GPU;
        gpuGlobals = dawn.globals as Record<string, unknown>;
      } catch (cause) {
        return {
          ok: false as const,
          error: {
            code: 'replay-backend-unavailable',
            expected: 'the Dawn WebGPU provider to load',
            hint: 'Install the DevKit runtime closure and retry rhi.inspect.',
            detail: {
              stage: 'provider',
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          },
        };
      }
      Object.assign(globalThis, gpuGlobals);
      const gpu = createDawn([]);
      if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
        Object.defineProperty(globalThis, 'navigator', {
          value: {},
          configurable: true,
          writable: true,
        });
      }
      Object.defineProperty(globalThis.navigator, 'gpu', {
        value: gpu,
        configurable: true,
        writable: true,
      });
      const adapter = await rhi.requestAdapter();
      if (!adapter.ok) {
        return {
          ok: false as const,
          error: {
            code: 'replay-backend-unavailable',
            expected: 'a fresh Dawn WebGPU adapter',
            hint: adapter.error.hint,
            detail: { stage: 'adapter', cause: adapter.error.hint },
          },
        };
      }
      const device = await adapter.value.requestDevice(
        replayDeviceRequest(tape, adapter.value.features, adapter.value.limits),
      );
      if (!device.ok) {
        return {
          ok: false as const,
          error: {
            code: 'replay-backend-unavailable',
            expected: 'a fresh Dawn WebGPU device satisfying the recorded tape',
            hint: device.error.hint,
            detail: { stage: 'device', cause: device.error.hint },
          },
        };
      }
      return { ok: true as const, value: { device: device.value, createShaderModule } };
    },
  };
}
