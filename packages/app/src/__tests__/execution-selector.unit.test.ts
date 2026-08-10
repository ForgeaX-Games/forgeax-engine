import { describe, expect, it } from 'vitest';
import {
  EXECUTION_CAPABILITY_NAMES,
  type ExecutionCapabilities,
  type ExecutionCapabilityName,
  selectExecutionTier,
} from '../index';

function facts(missing: readonly ExecutionCapabilityName[] = []): ExecutionCapabilities {
  return Object.fromEntries(
    EXECUTION_CAPABILITY_NAMES.map((name) => [
      name,
      {
        available: !missing.includes(name),
        reason: missing.includes(name) ? 'fixture missing' : 'fixture observed',
      },
    ]),
  ) as unknown as ExecutionCapabilities;
}

describe('execution tier selector', () => {
  it('orders auto shared to engine-worker to main-serial', () => {
    expect(
      selectExecutionTier({
        requestedTier: 'auto',
        capabilities: facts(),
        sharedEvidencePassed: true,
      }).unwrap().actualTier,
    ).toBe('shared');
    expect(
      selectExecutionTier({
        requestedTier: 'auto',
        capabilities: facts(['sharedArrayBuffer']),
        sharedEvidencePassed: true,
      }).unwrap().actualTier,
    ).toBe('engine-worker');
    expect(
      selectExecutionTier({
        requestedTier: 'auto',
        capabilities: facts(['workerWebGpu']),
        sharedEvidencePassed: true,
      }).unwrap().actualTier,
    ).toBe('main-serial');
  });

  it('does not conflate failed shipped evidence with a missing browser capability', () => {
    const result = selectExecutionTier({
      requestedTier: 'shared',
      capabilities: facts(),
      sharedEvidencePassed: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      if (result.error.code !== 'app-execution-tier-unavailable') throw result.error;
      expect(result.error.detail.missingCapabilities).toEqual([]);
      expect(result.error.detail.sharedEvidencePassed).toBe(false);
    }
  });

  it('never silently downgrades an explicit tier', () => {
    const result = selectExecutionTier({
      requestedTier: 'engine-worker',
      capabilities: facts(['offscreenCanvas']),
      sharedEvidencePassed: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      if (result.error.code !== 'app-execution-tier-unavailable') throw result.error;
      expect(result.error.detail.missingCapabilities).toEqual(['offscreenCanvas']);
    }
  });
});
