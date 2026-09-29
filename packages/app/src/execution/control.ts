import type { AudioState } from '@forgeax/engine-audio';
import { err } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError } from '../errors';
import { executionAudioReport } from './report';
import type { ExecutionControl, ExecutionEngineHealth, ExecutionReport } from './types';

export function cloneExecutionReport(report: ExecutionReport): ExecutionReport {
  return structuredClone(report);
}

export interface LocalExecutionControl extends ExecutionControl {
  setEngineHealth(health: ExecutionEngineHealth): void;
}

export interface LocalExecutionReportProviders {
  readonly audio?: () => AudioState;
  readonly world?: () => ExecutionReport['world'];
  readonly frame?: () => ExecutionReport['frame'];
}

export function createLocalExecutionControl(
  initial: ExecutionReport,
  providers: LocalExecutionReportProviders = {},
): LocalExecutionControl {
  let current = cloneExecutionReport(initial);
  return {
    setEngineHealth: (health) => {
      current = { ...current, engine: { ...current.engine, health } };
    },
    report: () =>
      cloneExecutionReport({
        ...current,
        world: providers.world?.() ?? current.world,
        frame: providers.frame?.() ?? current.frame,
        audio: executionAudioReport(providers.audio?.()),
      }),
    rebuild: async () =>
      err(
        new AppError({
          code: 'app-execution-rebuild-failed',
          expected: APP_EXPECTED['app-execution-rebuild-failed'],
          hint: APP_ERROR_HINTS['app-execution-rebuild-failed'],
          detail: {
            worldIdentity: current.world.identity,
            cause: new Error('This local assembly has no bootstrap module.'),
          },
        }),
      ),
  };
}
