import { describe, expect, it } from 'vitest';
import { EVENT_SEMANTICS, eventKinds, isWorkEvent } from '../protocol/event-semantics';

describe('event semantics coverage', () => {
  it('has one semantic entry for every closed event kind', () => {
    expect(Object.keys(EVENT_SEMANTICS).sort()).toEqual([...eventKinds].sort());
  });

  it('counts direct, indexed, indirect, and compute work without draw aliases', () => {
    expect(
      [
        'draw',
        'drawIndexed',
        'drawIndirect',
        'drawIndexedIndirect',
        'dispatchWorkgroups',
        'dispatchWorkgroupsIndirect',
      ].every((kind) => isWorkEvent(kind as never)),
    ).toBe(true);
    expect(isWorkEvent('beginRenderPass')).toBe(false);
  });
});
