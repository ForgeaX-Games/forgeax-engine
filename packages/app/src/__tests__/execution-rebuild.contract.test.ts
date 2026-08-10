import { describe, expect, it } from 'vitest';
import { createExecutionReport, unavailableExecutionCapabilities } from '../execution';
import { createLocalExecutionControl } from '../execution/control';

describe('execution rebuild contract', () => {
  it('keeps low-level local assembly explicit when no bootstrap exists', async () => {
    const control = createLocalExecutionControl(
      createExecutionReport('main-serial', unavailableExecutionCapabilities('local')),
    );
    const before = control.report();
    const result = await control.rebuild();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('app-execution-rebuild-failed');
    expect(control.report()).toEqual(before);
  });

  it('projects live local lifecycle and World state without a duplicate ledger', () => {
    let world: ReturnType<typeof createExecutionReport>['world'] = {
      identity: 'world-1',
      health: 'healthy',
      partialWrite: false,
      retryable: true,
    };
    const control = createLocalExecutionControl(
      createExecutionReport('main-serial', unavailableExecutionCapabilities('local')),
      { world: () => world },
    );

    control.setEngineHealth('running');
    expect(control.report().engine.health).toBe('running');
    world = { ...world, health: 'poisoned', partialWrite: true, retryable: false };
    expect(control.report().world).toEqual(world);
    control.setEngineHealth('stopped');
    expect(control.report().engine.health).toBe('stopped');
  });
});
