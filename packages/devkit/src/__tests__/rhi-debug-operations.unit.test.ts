import { encodeTape, type V7Tape } from '@forgeax/engine-rhi-debug';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { ok, type Result } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  type ArtifactRef,
  type CapturedRhiTape,
  discoverRhiDebugOperations,
  type RhiDebugOperationContext,
  renderRhiDebugHelp,
  runRhiDebugOperation,
} from '../rhi-debug/operations';

const tape: V7Tape = {
  header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
  bootstrap: [],
  events: [],
  blobs: [],
};

const workTape: V7Tape = {
  header: { formatVersion: 7, rhiCaps: {}, eventCount: 7, blobCount: 0 },
  bootstrap: [],
  events: [
    { kind: 'createCommandEncoder', cmdHandleId: 'encoder:1', desc: {} },
    { kind: 'beginComputePass', cmdHandleId: 'encoder:1', passHandleId: 'pass:1', desc: {} },
    { kind: 'dispatchWorkgroups', passHandleId: 'pass:1', x: 1, y: 1, z: 1 },
    { kind: 'endComputePass', passHandleId: 'pass:1' },
    { kind: 'finish', cmdHandleId: 'encoder:1' },
    { kind: 'submit', cmdHandleIds: ['encoder:1'] },
    { kind: 'frameMark', frameIdx: 0 },
  ],
  blobs: [],
};

function makeContext(bytes: Uint8Array): {
  readonly context: RhiDebugOperationContext;
  readonly artifact: ArtifactRef;
} {
  const artifact: ArtifactRef = {
    kind: 'rhi-tape',
    digest: 'sha256:m5-operation-fixture',
    source: 'rhi.capture',
  };
  const captured: CapturedRhiTape = { ...artifact, bytes };
  const context: RhiDebugOperationContext = {
    captureFrame: async (): Promise<Result<CapturedRhiTape, never>> => ok(captured),
    readArtifact: async (ref) =>
      ref.digest === artifact.digest
        ? { ok: true, value: bytes }
        : {
            ok: false,
            error: {
              code: 'artifact-not-found',
              expected: 'the requested rhi-tape artifact to exist',
              hint: 'capture a new rhi-tape and pass its ArtifactRef unchanged',
              detail: { digest: ref.digest },
            },
          },
  };
  return { context, artifact };
}

describe('DevKit RHI debug operations', () => {
  it('discovers only the three canonical operations from an empty context', () => {
    expect(discoverRhiDebugOperations().map((operation) => operation.name)).toEqual([
      'rhi.capture',
      'rhi.summary',
      'rhi.inspect',
    ]);
    const help = renderRhiDebugHelp();
    expect(help).toContain('rhi.capture');
    expect(help).toContain('rhi.summary');
    expect(help).toContain('rhi.inspect');
    expect(help).not.toMatch(/legacy RHI debug command/);
  });

  it('hands one ArtifactRef digest from capture to summary', async () => {
    const encoded = encodeTape(tape);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const { context } = makeContext(encoded.value);

    const captured = await runRhiDebugOperation('rhi.capture', {}, context);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    const summary = await runRhiDebugOperation(
      'rhi.summary',
      { artifact: captured.value },
      context,
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.artifact).toEqual(captured.value);
    expect(summary.value.model.works).toEqual([]);
  });

  it('rejects an artifact that changes kind or digest at the operation boundary', async () => {
    const encoded = encodeTape(tape);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const { context, artifact } = makeContext(encoded.value);

    const invalid = await runRhiDebugOperation(
      'rhi.summary',
      { artifact: { ...artifact, kind: 'other' as 'rhi-tape' } },
      context,
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.code).toBe('artifact-kind-invalid');
  });

  it('inspects a workIndex through a real fresh rhi-null replay backend', async () => {
    const encoded = encodeTape(workTape);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const { context, artifact } = makeContext(encoded.value);
    const inspectContext: RhiDebugOperationContext = {
      ...context,
      createReplayBackend: async () => {
        const adapter = await rhi.requestAdapter();
        if (!adapter.ok) {
          return {
            ok: false as const,
            error: {
              code: adapter.error.code,
              expected: adapter.error.expected,
              hint: adapter.error.hint,
              detail: { cause: adapter.error.detail ?? null },
            },
          };
        }
        const device = await adapter.value.requestDevice();
        if (!device.ok) {
          return {
            ok: false as const,
            error: {
              code: device.error.code,
              expected: device.error.expected,
              hint: device.error.hint,
              detail: { cause: device.error.detail ?? null },
            },
          };
        }
        return ok({ device: device.value, createShaderModule });
      },
    };
    const result = await runRhiDebugOperation(
      'rhi.inspect',
      { artifact, workIndex: 0 },
      inspectContext,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.inspection.workIndex).toBe(0);
  });
});
