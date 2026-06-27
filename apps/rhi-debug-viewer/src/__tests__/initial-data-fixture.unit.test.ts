// initial-data-fixture.unit.test.ts -- AC-05 hand-written fixture seed (M4 / w21).
//
// Proves the tape format carries the frame-header initial-state capture seed
// end-to-end, without a GPU:
//   1. A hand-written fixture (build-hello-cube-tape.mjs:buildHelloCubeInitialDataFixture)
//      declares a createBuffer (VBO uploaded during the loading phase -- no
//      in-frame writeBuffer) + one initialData event + a blobPool entry holding
//      the declared VBO bytes.
//   2. deserializeTape round-trips that fixture (json + blob -> Tape) with the
//      initialData event and blobPool entry intact.
//   3. replayInitialData seeds the recreated resource: the bytes it writes via
//      queue.writeBuffer equal the fixture's declared bytes verbatim.
//
// This is the pure-unit counterpart to the dawn e2e (w19/w20): it isolates the
// seed step's byte fidelity from the GPU rasterization path.

// biome-ignore-all lint/suspicious/noExplicitAny: the fixture .mjs has no .d.ts and the mock queue surfaces a structural RhiQueue subset; both require any at the test boundary.

import type { HandleId, RhiCallEventInitialData, Tape } from '@forgeax/engine-rhi-debug';
import { deserializeTape, replayInitialData } from '@forgeax/engine-rhi-debug';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- .mjs fixture builder has no .d.ts; runtime-only import
import { buildHelloCubeInitialDataFixture } from '../../fixtures/build-hello-cube-tape.mjs';

interface WriteBufferCall {
  readonly resource: unknown;
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/** A mock RhiQueue that records writeBuffer/writeTexture invocations. */
function makeMockQueue() {
  const writeBufferCalls: WriteBufferCall[] = [];
  let writeTextureCount = 0;
  const queue = {
    writeBuffer(resource: unknown, offset: number, data: ArrayBuffer | ArrayBufferView) {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      // Copy out -- the caller may reuse the underlying buffer.
      writeBufferCalls.push({ resource, offset, bytes: new Uint8Array(bytes) });
    },
    writeTexture() {
      writeTextureCount++;
    },
    submit() {},
    async onSubmittedWorkDone() {},
  };
  return {
    queue,
    writeBufferCalls,
    get writeTextureCount() {
      return writeTextureCount;
    },
  };
}

describe('AC-05 hand-written initialData fixture seed (w21)', () => {
  it('deserializes the fixture with its initialData event + blobPool bytes intact', () => {
    const { json, blob, vboHash, vboHandleId, declaredBytes } = buildHelloCubeInitialDataFixture();

    const des = deserializeTape(json, blob);
    expect(des.ok).toBe(true);
    if (!des.ok) return;
    const tape: Tape = des.value;

    const initialDataEvents = tape.events.filter((e) => e.kind === 'initialData');
    expect(initialDataEvents.length).toBe(1);
    const seedEvent = initialDataEvents[0] as RhiCallEventInitialData;
    expect(seedEvent.handleId).toBe(vboHandleId);
    expect(seedEvent.dataHash).toBe(vboHash);

    // No in-frame writeBuffer -- the bytes live only in the initialData seed.
    expect(tape.events.some((e) => e.kind === 'writeBuffer')).toBe(false);

    const pooled = tape.blobPool.get(vboHash);
    expect(pooled).toBeDefined();
    expect(new Uint8Array(pooled as ArrayBuffer)).toEqual(declaredBytes);
  });

  it('seeds the recreated VBO with the fixture-declared bytes verbatim', () => {
    const { json, blob, vboHandleId, declaredBytes } = buildHelloCubeInitialDataFixture();
    const des = deserializeTape(json, blob);
    expect(des.ok).toBe(true);
    if (!des.ok) return;
    const tape: Tape = des.value;

    const seedEvent = tape.events.find((e) => e.kind === 'initialData') as RhiCallEventInitialData;

    // The handleMap simulates the bootstrap prefix having already recreated the
    // VBO (createBuffer replayed -> a real GPU handle exists). A sentinel object
    // stands in for that handle so we can assert writeBuffer targets it.
    const recreatedVbo = { _brand: 'mock-vbo' };
    const handleMap = new Map<HandleId, unknown>([[vboHandleId as HandleId, recreatedVbo]]);

    const mock = makeMockQueue();
    const seedRes = replayInitialData(seedEvent, tape, handleMap, mock.queue as any);
    expect(seedRes.ok).toBe(true);

    // Exactly one writeBuffer to the recreated VBO, offset 0, with the declared
    // bytes -- this is the AC-05 "seeded resource bytes == fixture-declared
    // bytes" assertion.
    expect(mock.writeBufferCalls.length).toBe(1);
    expect(mock.writeTextureCount).toBe(0);
    const call = mock.writeBufferCalls[0];
    expect(call?.resource).toBe(recreatedVbo);
    expect(call?.offset).toBe(0);
    expect(call?.bytes).toEqual(declaredBytes);
  });
});
