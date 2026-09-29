import {
  EXECUTION_CAPABILITY_NAMES,
  type ExecutionCapabilities,
  type ExecutionCapabilityName,
  type ExecutionWorkersOptions,
  selectExecutionWorkers,
} from '../index';
export function executionFacts(
  missing: readonly ExecutionCapabilityName[] = [],
): ExecutionCapabilities {
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
export function workerSelection(workers: ExecutionWorkersOptions = {}) {
  return selectExecutionWorkers({ workers, capabilities: executionFacts() }).unwrap();
}
