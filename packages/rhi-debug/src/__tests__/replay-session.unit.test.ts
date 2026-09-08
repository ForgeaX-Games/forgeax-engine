import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import type { Tape } from '../protocol/types';
import type { ReplayBackend } from '../replay/session';
import { openReplay } from '../replay/session';

function makeWorkTape(): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 7, blobCount: 0 },
    bootstrap: [],
    events: [
      {
        kind: 'createCommandEncoder',
        cmdHandleId: 'encoder:1',
        desc: {},
      },
      {
        kind: 'beginComputePass',
        cmdHandleId: 'encoder:1',
        passHandleId: 'pass:1',
        desc: {},
      },
      {
        kind: 'dispatchWorkgroups',
        passHandleId: 'pass:1',
        x: 1,
        y: 1,
        z: 1,
      },
      { kind: 'endComputePass', passHandleId: 'pass:1' },
      { kind: 'finish', cmdHandleId: 'encoder:1' },
      { kind: 'submit', cmdHandleIds: ['encoder:1'] },
      { kind: 'frameMark', frameIdx: 0 },
    ],
    blobs: [],
  };
}

async function makeBackend(): Promise<ReplayBackend> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw new Error(adapter.error.hint);
  const device = await adapter.value.requestDevice();
  if (!device.ok) throw new Error(device.error.hint);
  return { device: device.value, createShaderModule };
}

describe('ReplaySession', () => {
  it('replays a depth-only render pipeline without requiring a fragment shader', async () => {
    const tape: Tape = {
      header: { formatVersion: 7, rhiCaps: {}, eventCount: 7, blobCount: 0 },
      bootstrap: [
        {
          handleId: 'shader:vertex',
          kind: 'shader-module',
          create: {
            kind: 'createShaderModule',
            handleId: 'shader:vertex',
            wgslCode: '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(); }',
          },
          initialData: [],
        },
        {
          handleId: 'layout:empty',
          kind: 'binding',
          create: {
            kind: 'createBindGroupLayout',
            handleId: 'layout:empty',
            desc: { entries: [] },
          },
          initialData: [],
        },
        {
          handleId: 'pipeline-layout:empty',
          kind: 'binding',
          create: {
            kind: 'createPipelineLayout',
            handleId: 'pipeline-layout:empty',
            bglHandleIds: ['layout:empty'],
          },
          initialData: [],
        },
        {
          handleId: 'pipeline:depth-only',
          kind: 'pipeline',
          create: {
            kind: 'createRenderPipeline',
            handleId: 'pipeline:depth-only',
            desc: { vertex: { entryPoint: 'main', buffers: [] } },
            layoutHandleId: 'pipeline-layout:empty',
            vertexShaderModuleHandleId: 'shader:vertex',
          },
          initialData: [],
        },
      ],
      events: makeWorkTape().events,
      blobs: [],
    };
    const result = await openReplay(tape, await makeBackend());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await result.value.inspectWork(0)).ok).toBe(true);
  });

  it('replays a work index on a caller-provided fresh backend', async () => {
    const result = await openReplay(makeWorkTape(), await makeBackend());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const inspection = await result.value.inspectWork(0);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.value.workIndex).toBe(0);
    expect(inspection.value.eventIndex).toBe(2);
    expect(inspection.value.attachment).toBeUndefined();
    expect('stepTo' in result.value).toBe(false);
    expect('commitThroughDraw' in result.value).toBe(false);
  });

  it('returns selected-work facts for every inspection selector', async () => {
    const result = await openReplay(makeWorkTape(), await makeBackend());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const inspection = await result.value.inspectWork(0, ['bindings', 'pipeline']);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.value.pipeline).toBeDefined();
    expect(inspection.value.bindings).toBeDefined();
    expect(inspection.value.vertexBuffers).toBeDefined();
    expect(inspection.value.indexBuffer).toBeDefined();
    expect(inspection.value.shaders).toBeDefined();
    expect(inspection.value.resourceIds).toBeDefined();
  });

  it('resets internally when selecting an earlier work and rejects invalid positions', async () => {
    const tape = makeWorkTape();
    const withSecondWork: Tape = {
      ...tape,
      header: { ...tape.header, eventCount: tape.events.length + 1 },
      events: [
        ...tape.events.slice(0, 3),
        { kind: 'dispatchWorkgroups', passHandleId: 'pass:1', x: 2, y: 1, z: 1 },
        ...tape.events.slice(3),
      ],
    };
    const result = await openReplay(withSecondWork, await makeBackend());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect((await result.value.inspectWork(1)).ok).toBe(true);
    const earlier = await result.value.inspectWork(0);
    expect(earlier.ok).toBe(true);
    if (!earlier.ok) return;
    expect(earlier.value.workIndex).toBe(0);

    const invalid = await result.value.inspectWork(2);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('replay-position-invalid');
  });

  it('returns a structured terminal error after dispose and keeps the session closed', async () => {
    const result = await openReplay(makeWorkTape(), await makeBackend());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect((await result.value.dispose()).ok).toBe(true);
    const reused = await result.value.inspectWork(0);
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.error.code).toBe('replay-position-invalid');
  });
});
