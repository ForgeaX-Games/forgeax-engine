import { describe, expect, it } from 'vitest';
import type { RenderSystemInternals } from '../record/render-context';
import { createProbeFilterState } from '../reflection/filter';
import type { ReflectionProbeFact } from '../reflection/projection';
import { ReflectionProbeRecordOwner } from '../reflection/record-owner';

// Tests exercise the existing owner without widening its production API.
type ProbeOwnerFixture = {
  resources: ReflectionProbeRecordOwner['resources'];
  resourceFor: ReflectionProbeRecordOwner['resourceFor'];
  completeSubmission: ReflectionProbeRecordOwner['completeSubmission'];
};

function fixture(intent: 'once' | 'on-change' | 'continuous') {
  const owner = new ReflectionProbeRecordOwner({
    device: { caps: { rgba16floatRenderable: true }, queue: { writeBuffer: () => ({ ok: true }) } },
    deviceScope: { generation: 1 },
  } as unknown as RenderSystemInternals) as unknown as ProbeOwnerFixture;
  const fact: ReflectionProbeFact = {
    worldId: 0,
    entityKey: 1,
    center: [0, 0, 0],
    halfExtents: [2, 2, 2],
    intensity: 1,
    priority: 0,
    resolution: 64,
    revision: 1,
    updateIntent: intent,
  };
  const resource = {
    fact,
    captureFact: fact,
    diffusePayload: [0, 0, 0, 0, 0, 0, 0, 1],
    captureSceneRevision: '1',
    index: 0,
    filter: {
      ...createProbeFilterState({ probeIndex: 0, mipCount: 5, activeGeneration: 1 }),
      cursor: 30,
    },
    rawFaceCursor: 6,
    raw: { size: 64, faceViews: new Array(6) },
    active: {},
    candidate: {},
    spare: undefined,
  } as unknown as NonNullable<ReturnType<(typeof owner)['resourceFor']>>;
  owner.resources.set('0:1', resource);
  return { owner, fact, resource };
}

describe('ReflectionProbe real resource update ownership', () => {
  it.each([
    'continuous',
    'on-change',
  ] as const)('starts another bounded capture for %s', (intent) => {
    const { owner, fact, resource } = fixture(intent);
    owner.resourceFor('0:1', fact, 0, '2');
    expect(resource.rawFaceCursor).toBe(0);
    expect(resource.filter.cursor).toBe(0);
    expect(resource.filter.activeGeneration).toBe(1);
  });
  it('keeps once probes steady across ordinary scene changes', () => {
    const { owner, fact, resource } = fixture('once');
    owner.resourceFor('0:1', fact, 0, '2');
    expect(resource.rawFaceCursor).toBe(6);
    expect(resource.filter.cursor).toBe(30);
  });
  it('coalesces a changing scene without starving an in-progress capture', () => {
    const { owner, fact, resource } = fixture('on-change');
    resource.rawFaceCursor = 3;
    resource.filter = { ...resource.filter, cursor: 0 };
    owner.resourceFor('0:1', { ...fact, revision: 2 }, 0, '2');
    expect(resource.rawFaceCursor).toBe(3);
  });
  it('commits capture tickets even when no fallback MRT was requested', async () => {
    const { owner, resource } = fixture('once');
    resource.rawFaceCursor = 2;
    const pending = { rawCaptureFace: 2, step: undefined };
    resource.pending = pending;
    await owner.completeSubmission(
      true,
      new Map(),
      Promise.resolve(),
      undefined,
      false,
      [{ resource, pending }],
      1,
      37,
    );
    expect(resource.rawFaceCursor).toBe(3);
    expect(resource.pending).toBeUndefined();
  });
  it('failed submissions retry the same face', async () => {
    const { owner, resource } = fixture('once');
    resource.rawFaceCursor = 2;
    const pending = { rawCaptureFace: 2, step: undefined };
    resource.pending = pending;
    await owner.completeSubmission(
      false,
      new Map(),
      undefined,
      undefined,
      false,
      [{ resource, pending }],
      1,
      37,
    );
    expect(resource.rawFaceCursor).toBe(2);
    expect(resource.pending).toBeUndefined();
  });
  it('a stale completion cannot advance a replaced pending ticket', async () => {
    const { owner, resource } = fixture('once');
    resource.rawFaceCursor = 2;
    const old = { rawCaptureFace: 2, step: undefined };
    const current = { rawCaptureFace: 2, step: undefined };
    resource.pending = current;
    await owner.completeSubmission(
      true,
      new Map(),
      undefined,
      undefined,
      false,
      [{ resource, pending: old }],
      1,
      37,
    );
    expect(resource.rawFaceCursor).toBe(2);
    expect(resource.pending).toBe(current);
  });
});
