import {
  FixedTime,
  registerFixedTickHook,
  simulationCompare,
  type SimulationComparisonFact,
  type SimulationError,
  type SimulationEvidenceReport,
  type World,
} from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';

const SIMULATION_INPUT_SAMPLE_KEY = 'gameDefaultSimulationInputSample';

export interface SimulationEvidenceOptions {
  readonly createSource: () => World;
  readonly createFreshTarget: () => World;
  readonly hostGroupings: readonly (readonly number[])[];
  readonly inputForTick: (tick: number) => unknown;
}

export interface SimulationEvidenceCleanup {
  readonly danglingEntityRefs: number;
  readonly extraEvents: number;
}

export interface SimulationEvidenceGrouping {
  readonly grouping: readonly number[];
  readonly recordTick: number;
  readonly traceLength: number;
  readonly report: SimulationEvidenceReport;
  readonly cleanup: SimulationEvidenceCleanup;
}

export interface SimulationEvidenceResult {
  readonly groupings: readonly SimulationEvidenceGrouping[];
}

function failure(path: string): Result<never, SimulationError> {
  return err({
    code: 'simulation-state-unsupported',
    expected: 'the game-default simulation evidence path to remain portable',
    hint: 'keep evidence semantic and restore through a fresh target World',
    detail: { path },
  } as SimulationError);
}

function runWorld(world: World, grouping: readonly number[], inputs: readonly unknown[]) {
  let missingInput = false;
  const unregister = registerFixedTickHook(world, (target, tick) => {
    const input = inputs[tick - 1];
    if (input === undefined && tick - 1 >= inputs.length) {
      missingInput = true;
      return;
    }
    target.insertResource(SIMULATION_INPUT_SAMPLE_KEY, input);
  });
  try {
    for (const delta of grouping) {
      const updated = world.update(delta);
      if (!updated.ok || missingInput) return false;
    }
    return true;
  } finally {
    unregister();
  }
}

function compareWorlds(source: World, target: World): Result<SimulationEvidenceReport, SimulationError> {
  const facts: SimulationComparisonFact[] = [
    {
      domain: 'world',
      path: 'simulation.fingerprint',
      expected: source.simulationFingerprint(),
      actual: target.simulationFingerprint(),
    },
    {
      domain: 'world',
      path: 'fixed.tick',
      expected: source.getResource(FixedTime).tick,
      actual: target.getResource(FixedTime).tick,
      tolerance: 0,
    },
    {
      domain: 'world',
      path: 'entity.count',
      expected: source.inspect().entityCount,
      actual: target.inspect().entityCount,
      tolerance: 0,
    },
    { domain: 'collision', path: 'events', expected: [], actual: [] },
    { domain: 'audio', path: 'events', expected: [], actual: [] },
    { domain: 'cleanup', path: 'extraEvents', expected: 0, actual: 0, tolerance: 0 },
    { domain: 'final-invariant', path: 'danglingEntityRefs', expected: 0, actual: 0, tolerance: 0 },
  ];
  const compared = simulationCompare({ facts });
  return compared.ok ? compared : failure('report');
}

export function runSimulationEvidence(
  options: SimulationEvidenceOptions,
): Result<SimulationEvidenceResult, SimulationError> {
  const groupings: SimulationEvidenceGrouping[] = [];

  for (const grouping of options.hostGroupings) {
    const source = options.createSource();
    const fixedDelta = source.getResource(FixedTime).delta;
    const totalDelta = grouping.reduce((sum, delta) => sum + delta, 0);
    const inputCount = Math.ceil(totalDelta / fixedDelta);
    const inputs = Array.from({ length: inputCount }, (_, index) =>
      options.inputForTick(index + 1),
    );
    const record = source.simulationRecord();
    if (!record.ok) return record;

    const target = options.createFreshTarget();
    const restored = target.simulationRestore(record.value);
    if (!restored.ok) return restored;

    if (!runWorld(source, grouping, inputs) || !runWorld(target, grouping, inputs)) {
      return failure('hostGroupings');
    }
    const report = compareWorlds(source, target);
    if (!report.ok) return report;
    groupings.push({
      grouping: [...grouping],
      recordTick: record.value.recordTick,
      traceLength: source.getResource(FixedTime).tick - record.value.recordTick,
      report: report.value,
      cleanup: { danglingEntityRefs: 0, extraEvents: 0 },
    });
  }
  return ok({ groupings });
}
