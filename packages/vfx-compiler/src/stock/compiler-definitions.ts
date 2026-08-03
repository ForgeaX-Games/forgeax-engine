import { err, ok, type Result } from '@forgeax/engine-types';
import {
  STOCK_PARTICLE_OPERATOR_MANIFEST,
  type StockParticleOperatorManifestEntry,
} from '@forgeax/engine-vfx';
import type {
  ParticleOperatorDefinition,
  ParticleOperatorRegistryError,
} from '../operator-registry.js';

function invalidParams(
  entry: StockParticleOperatorManifestEntry,
): ResultErr<ParticleOperatorRegistryError> {
  return err({
    code: 'vfx-operator-params-invalid',
    expected: `${entry.key} parameters match the stock operator schema`,
    hint: `repair the params for ${entry.key} before cooking`,
    detail: {
      stage: entry.stage,
      kind: entry.kind,
      version: entry.version,
      path: 'params',
      operator: {
        stage: entry.stage,
        kind: entry.kind,
        version: entry.version,
      },
      backend: 'cpu',
    },
  });
}

function definition(entry: StockParticleOperatorManifestEntry): ParticleOperatorDefinition<never> {
  return {
    stage: entry.stage,
    kind: entry.kind,
    version: entry.version,
    parameterSchema: entry.parameterSchema,
    validateParams: (params: unknown) => {
      const result = entry.validateParams(params);
      return result.ok ? ok(undefined) : invalidParams(entry);
    },
    compile: {
      cpu: (params: never) => params,
    },
  };
}

export function createStockParticleOperatorDefinitions(): readonly ParticleOperatorDefinition<never>[] {
  return STOCK_PARTICLE_OPERATOR_MANIFEST.map(definition);
}

type ResultErr<E> = Extract<Result<never, E>, { readonly ok: false }>;
