// Unit tests for recorder-core.ts — finalizeToMemory / assembleReport / generateRunId.
//
// w1: finalizeToMemory return value per-field assertions
// w2: assembleReport helper shape assertions
// w3: generateRunId dual-source format + uniqueness assertions

// biome-ignore-all lint/suspicious/noExplicitAny: test stubs for recorder-core primitives use mock DebugRhiInstance partial types; RhiCallEvent closed union requires any cast for inline stub event shapes
// biome-ignore-all lint/style/noNonNullAssertion: test assertions on structured array indexing are safe within controlled test fixtures

import { describe, expect, it } from 'vitest';
import { computePassOffsets, serializeTape } from '../tape-format';
import type { RhiCallEvent } from '../types';

// Dynamic import -- returns undefined when module not found (red phase).
async function importCore(): Promise<any> {
  try {
    return await import('../recorder-core');
  } catch {
    return undefined;
  }
}

function makeSimpleTape(events?: readonly RhiCallEvent[]) {
  return {
    formatVersion: 2,
    rhiCapsRecorded: {
      canvasFormat: 'bgra8unorm' as const,
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompression: false,
      storageBuffer: false,
      timestampQuery: false,
    },
    events: events ?? [],
    blobPool: new Map(),
  };
}

// ================================================================
// w1: finalizeToMemory return value per-field
// ================================================================

describe('finalizeToMemory (w1)', () => {
  it('returns ok with five fields when tape is present', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false); // RED: module not found
      return;
    }
    const { finalizeToMemory } = core;

    // Minimal createBuffer that satisfies RhiCallEventCreateBuffer
    const tapeEvents: RhiCallEvent[] = [
      {
        kind: 'createBuffer',
        handleId: 'buf:1',
        desc: { size: 64, usage: 16 },
      } as RhiCallEvent,
    ];
    const tape = makeSimpleTape(tapeEvents);
    const debugInst = createMockDebugInst({ tape });

    const result = finalizeToMemory(debugInst);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value.runId).toBe('string');
      expect(result.value.runId.length).toBeGreaterThan(0);
      expect(result.value.runId).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z?-[0-9a-f]{4}$/,
      );

      expect(typeof result.value.json).toBe('string');
      expect(result.value.json.length).toBeGreaterThan(0);
      expect(() => JSON.parse(result.value.json)).not.toThrow();

      expect(result.value.blob).toBeInstanceOf(Uint8Array);
      expect(result.value.blob.byteLength).toBeGreaterThanOrEqual(0);

      expect(Array.isArray(result.value.passOffsets)).toBe(true);

      expect(typeof result.value.valid).toBe('boolean');
    }
  });

  it('returns err with frame-end-hook-missing when tape is undefined', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false);
      return;
    }
    const { finalizeToMemory } = core;
    const debugInst = createMockDebugInst({ tape: undefined });

    const result = finalizeToMemory(debugInst);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('frame-end-hook-missing');
      expect(result.error.expected).toBeTruthy();
      expect(result.error.hint).toBeTruthy();
    }
  });

  it('produces json/blob consistent with direct serializeTape call', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false);
      return;
    }
    const { finalizeToMemory } = core;

    const tapeEvents: RhiCallEvent[] = [
      {
        kind: 'createBuffer',
        handleId: 'buf:1',
        desc: { size: 64, usage: 16 },
      } as RhiCallEvent,
    ];
    const tape = makeSimpleTape(tapeEvents);
    const { json: directJson, blob: directBlob } = serializeTape(tape);
    const debugInst = createMockDebugInst({ tape });
    const result = finalizeToMemory(debugInst);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.json).toBe(directJson);
      expect(result.value.blob).toEqual(directBlob);
    }
  });

  it('passOffsets from finalizeToMemory match computePassOffsets', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false);
      return;
    }
    const { finalizeToMemory } = core;

    const events: RhiCallEvent[] = [
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'ce:1',
        passHandleId: 'rp:1',
        desc: { colorAttachments: [] } as any,
        colorAttachmentViewHandleIds: [],
      } as RhiCallEvent,
      {
        kind: 'draw',
        passHandleId: 'rp:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      } as RhiCallEvent,
      {
        kind: 'endRenderPass',
        passHandleId: 'rp:1',
      } as RhiCallEvent,
    ];

    const expectedOffsets = computePassOffsets(events);
    const tape = makeSimpleTape(events);
    const debugInst = createMockDebugInst({ tape });
    const result = finalizeToMemory(debugInst);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passOffsets).toEqual(expectedOffsets);
    }
  });

  it('valid field reflects _getValid from debugInst', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false);
      return;
    }
    const { finalizeToMemory } = core;

    const events: RhiCallEvent[] = [
      {
        kind: 'createBuffer' as const,
        handleId: 'buf:1',
        desc: { size: 64, usage: 16 },
      } as RhiCallEvent,
    ];
    const tape = makeSimpleTape(events);

    const r1 = finalizeToMemory(createMockDebugInst({ tape, valid: true }));
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.valid).toBe(true);

    const r2 = finalizeToMemory(createMockDebugInst({ tape, valid: false }));
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.valid).toBe(false);
  });

  it('same tape produces same json/blob/passOffsets on repeat calls', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false);
      return;
    }
    const { finalizeToMemory } = core;

    const events: RhiCallEvent[] = [
      {
        kind: 'createBuffer',
        handleId: 'buf:1',
        desc: { size: 64, usage: 16 },
      } as RhiCallEvent,
    ];
    const tape = makeSimpleTape(events);
    const debugInst = createMockDebugInst({ tape });
    const r1 = finalizeToMemory(debugInst);
    const r2 = finalizeToMemory(debugInst);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.value.json).toBe(r1.value.json);
      expect(r2.value.blob).toEqual(r1.value.blob);
      expect(r2.value.passOffsets).toEqual(r1.value.passOffsets);
      expect(r2.value.valid).toBe(r1.value.valid);
      expect(r2.value.runId).not.toBe(r1.value.runId);
    }
  });
});

// ================================================================
// w2: assembleReport helper shape
// ================================================================

describe('assembleReport (w2)', () => {
  it('returns header/events matching input json', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false);
      return;
    }
    const { assembleReport } = core;

    const header = { formatVersion: 2, rhiCapsRecorded: {} };
    const events = [{ kind: 'draw', vertexCount: 3 }];
    const json = JSON.stringify({ header, events });
    const passOffsets = [{ passIdx: 0, startDrawIdx: 0, endDrawIdx: 0 }];

    const report = assembleReport({ json, passOffsets, valid: true });
    expect(report.header).toEqual(header);
    expect(report.events).toEqual(events);
  });

  it('passOffsets pass-through', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false);
      return;
    }
    const { assembleReport } = core;

    const json = JSON.stringify({ header: {}, events: [] });
    const passOffsets = [
      { passIdx: 0, startDrawIdx: 0, endDrawIdx: 2 },
      { passIdx: 1, startDrawIdx: 3, endDrawIdx: 5 },
    ];
    const report = assembleReport({ json, passOffsets, valid: true });
    expect(report.passOffsets).toBe(passOffsets);
  });

  it('valid pass-through (true and false)', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false);
      return;
    }
    const { assembleReport } = core;

    const json = JSON.stringify({ header: {}, events: [] });
    const rTrue = assembleReport({ json, passOffsets: [], valid: true });
    expect(rTrue.valid).toBe(true);

    const rFalse = assembleReport({ json, passOffsets: [], valid: false });
    expect(rFalse.valid).toBe(false);
  });

  it('report round-trips through pretty-printed JSON (writers use 2-space indent)', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false);
      return;
    }
    const { assembleReport } = core;

    const json = JSON.stringify({ header: { version: 1 }, events: [{ kind: 'draw' }] });
    const report = assembleReport({ json, passOffsets: [], valid: true });
    // Writers pretty-print (recorder.finalize / vite-plugin writeTape) so the
    // on-disk report is human-readable; it must still parse back to the same shape.
    const serialized = JSON.stringify(report, null, 2);
    expect(serialized).toContain('\n');
    const parsed = JSON.parse(serialized);
    expect(parsed.header.version).toBe(1);
    expect(parsed.valid).toBe(true);
  });

  it('all four report fields present', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false);
      return;
    }
    const { assembleReport } = core;

    const json = JSON.stringify({
      header: { formatVersion: 1 },
      events: [{ kind: 'createBuffer' }],
    });
    const passOffsets = [{ passIdx: 0, startDrawIdx: 0, endDrawIdx: 0 }];
    const report = assembleReport({ json, passOffsets, valid: false });

    expect(report).toHaveProperty('header');
    expect(report).toHaveProperty('events');
    expect(report).toHaveProperty('passOffsets');
    expect(report).toHaveProperty('valid');
    expect(Object.keys(report).length).toBe(4);
  });
});

// ================================================================
// w3: generateRunId dual-source format + uniqueness
// ================================================================

describe('generateRunId (w3)', () => {
  it('returns YYYY-MM-DDTHH-mm-ss-xxxx format (4 hex nonce)', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false);
      return;
    }
    const { generateRunId } = core;
    const runId = generateRunId();
    expect(runId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z?-[0-9a-f]{4}$/);
  });

  it('two consecutive calls produce different runIds (nonce random)', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false);
      return;
    }
    const { generateRunId } = core;
    const id1 = generateRunId();
    const id2 = generateRunId();
    expect(id1).not.toBe(id2);
  });

  it('runId nonce segment is exactly 4 hex characters', async () => {
    const core = await importCore();
    if (!core) {
      expect(true).toBe(false);
      return;
    }
    const { generateRunId } = core;
    const runId = generateRunId();
    const parts = runId.split('-');
    expect(parts.length).toBeGreaterThanOrEqual(6);
    const nonce = parts[parts.length - 1]!;
    expect(nonce).toMatch(/^[0-9a-f]{4}$/);
  });
});

// ================================================================
// Mock DebugRhiInstance factory (minimal stub for tests)
// ================================================================

function createMockDebugInst(opts?: {
  tape?: unknown;
  state?: string;
  events?: readonly unknown[];
  valid?: boolean;
}): any {
  return {
    getTape: () => opts?.tape ?? undefined,
    getState: () => opts?.state ?? 'idle',
    getEvents: () => opts?.events ?? [],
    _getValid: () => opts?.valid ?? true,
  };
}
