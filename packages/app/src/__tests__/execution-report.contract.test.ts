import { describe, expect, it } from 'vitest';
import {
  createExecutionReport,
  EXECUTION_CAPABILITY_NAMES,
  type ExecutionCapabilities,
  isExecutionReport,
  selectExecutionTier,
} from '../index';

function capabilities(available = true): ExecutionCapabilities {
  return Object.fromEntries(
    EXECUTION_CAPABILITY_NAMES.map((name) => [
      name,
      { available, reason: available ? 'observed' : 'missing' },
    ]),
  ) as unknown as ExecutionCapabilities;
}

describe('ExecutionReport contract', () => {
  it('is the closed requested/actual/capability/health/performance/fault snapshot', () => {
    const selection = selectExecutionTier({
      requestedTier: 'auto',
      capabilities: capabilities(),
      sharedEvidencePassed: true,
    }).unwrap();
    const report = createExecutionReport('auto', capabilities(), selection);
    expect(report.requestedTier).toBe('auto');
    expect(report.actualTier).toBe('shared');
    expect(report.capabilities.worker.available).toBe(true);
    expect(report.engine.health).toBe('idle');
    expect(report.world.health).toBe('healthy');
    expect(report.kernelDispatch.reason).toBe('no-eligible-kernel');
    expect(report.performance.kernelWaitMs).toBeNull();
    expect(report.audio).toEqual({
      owner: 'host',
      contextState: 'suspended',
      activeSourceCount: 0,
      lastError: null,
    });
    expect(report.fault).toBeNull();
    expect(isExecutionReport(report)).toBe(true);
  });

  it('rejects missing and extra schema fields', () => {
    const report = createExecutionReport('main-serial', capabilities(false));
    const { world: _world, ...missing } = report;
    expect(isExecutionReport(missing)).toBe(false);
    expect(isExecutionReport({ ...report, workerId: 1 })).toBe(false);
  });
});
