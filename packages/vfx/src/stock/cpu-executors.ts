import type { ParticleCpuExecutorDefinition } from '../simulation/cpu-executor-registry.js';
import { ParticleCpuExecutorRegistry } from '../simulation/cpu-executor-registry.js';
import { STOCK_PARTICLE_OPERATOR_MANIFEST } from './operator-manifest.js';

export function createStockParticleCpuExecutorDefinitions(): readonly ParticleCpuExecutorDefinition[] {
  return STOCK_PARTICLE_OPERATOR_MANIFEST.map((entry) => ({
    stage: entry.stage,
    kind: entry.kind,
    version: entry.version,
    validateProgram: (program: unknown) => entry.validateParams(program),
    execute: entry.execute,
  }));
}

export function createStockParticleCpuExecutorRegistry(): ParticleCpuExecutorRegistry {
  return new ParticleCpuExecutorRegistry(createStockParticleCpuExecutorDefinitions());
}

export { STOCK_PARTICLE_OPERATOR_MANIFEST, stockParticleOperatorKey } from './operator-manifest.js';
