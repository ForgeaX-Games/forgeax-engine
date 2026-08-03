import { err, ok, type Result } from '@forgeax/engine-types';
import {
  STOCK_PARTICLE_OPERATOR_MANIFEST,
  type StockParticleOperatorKey,
  type StockParticleOperatorManifestEntry,
} from '@forgeax/engine-vfx';
import { type ParticleOperatorDefinition, ParticleOperatorRegistry } from '../operator-registry.js';
import { createStockParticleOperatorDefinitions } from './compiler-definitions.js';

export interface StockParticlePairingDetail {
  readonly key: string;
  readonly stage: string;
  readonly kind: string;
  readonly side: 'runtime' | 'compiler';
  readonly expectedVersion: number;
  readonly actualVersion?: number;
}

export type StockParticlePairingError =
  | {
      readonly code: 'vfx-stock-operator-half-missing';
      readonly expected: string;
      readonly hint: string;
      readonly detail: StockParticlePairingDetail;
    }
  | {
      readonly code: 'vfx-stock-operator-version-mismatch';
      readonly expected: string;
      readonly hint: string;
      readonly detail: StockParticlePairingDetail;
    }
  | {
      readonly code: 'vfx-stock-operator-duplicate';
      readonly expected: string;
      readonly hint: string;
      readonly detail: StockParticlePairingDetail;
    };

type CompilerDefinition = ParticleOperatorDefinition<never>;
type CompilerProjection = ParticleOperatorRegistry | readonly CompilerDefinition[];
type ResultErr<E> = Extract<Result<never, E>, { readonly ok: false }>;

function keyOf(entry: {
  readonly stage: string;
  readonly kind: string;
  readonly version: number;
}): string {
  return `${entry.stage}:${entry.kind}:${entry.version}`;
}

function sameFamily(
  left: { readonly stage: string; readonly kind: string },
  right: { readonly stage: string; readonly kind: string },
): boolean {
  return left.stage === right.stage && left.kind === right.kind;
}

function missing(
  entry: StockParticleOperatorKey,
  side: 'runtime' | 'compiler',
): ResultErr<StockParticlePairingError> {
  return err({
    code: 'vfx-stock-operator-half-missing',
    expected: `${entry.stage}:${entry.kind}:${entry.version} exists on both stock sides`,
    hint: `add the missing ${side} stock operator half before using the default factory`,
    detail: {
      key: keyOf(entry),
      stage: entry.stage,
      kind: entry.kind,
      side,
      expectedVersion: entry.version,
    },
  });
}

function mismatch(
  expected: StockParticleOperatorKey,
  actual: { readonly version: number },
): ResultErr<StockParticlePairingError> {
  return err({
    code: 'vfx-stock-operator-version-mismatch',
    expected: `${expected.stage}:${expected.kind}:${expected.version} matches on both stock sides`,
    hint: 'bump the compiler and runtime stock halves together with one canonical version',
    detail: {
      key: keyOf(expected),
      stage: expected.stage,
      kind: expected.kind,
      side: 'compiler',
      expectedVersion: expected.version,
      actualVersion: actual.version,
    },
  });
}

export function validateStockParticleOperatorPairing(
  projection: CompilerProjection,
  runtimeManifest: readonly StockParticleOperatorManifestEntry[] = STOCK_PARTICLE_OPERATOR_MANIFEST,
): Result<void, StockParticlePairingError> {
  const compilerDefinitions: readonly CompilerDefinition[] =
    projection instanceof ParticleOperatorRegistry ? projection.list() : projection;
  const seen = new Set<string>();
  for (const definition of compilerDefinitions) {
    const key = keyOf(definition);
    if (seen.has(key)) {
      const detail = {
        key,
        stage: definition.stage,
        kind: definition.kind,
        side: 'compiler' as const,
        expectedVersion: definition.version,
        actualVersion: definition.version,
      };
      return err({
        code: 'vfx-stock-operator-duplicate',
        expected: 'one compiler definition per stock stage, kind, and version',
        hint: 'remove the duplicate compiler definition or publish a new version',
        detail,
      });
    }
    seen.add(key);
  }

  for (const expected of runtimeManifest) {
    const candidates = compilerDefinitions.filter((definition) => sameFamily(definition, expected));
    const candidate = candidates[0];
    if (candidate === undefined) return missing(expected, 'compiler');
    if (candidate.version !== expected.version) return mismatch(expected, candidate);
  }

  for (const definition of compilerDefinitions) {
    const runtime = runtimeManifest.find((entry) => sameFamily(entry, definition));
    if (runtime === undefined) {
      const extra = {
        stage: definition.stage as StockParticleOperatorKey['stage'],
        kind: definition.kind as StockParticleOperatorKey['kind'],
        version: definition.version as 1,
      };
      return missing(extra, 'runtime');
    }
    if (runtime.version !== definition.version) return mismatch(runtime, definition);
  }
  return ok(undefined);
}

export function createStockParticleOperatorRegistry(): ParticleOperatorRegistry {
  const definitions = createStockParticleOperatorDefinitions();
  const pairing = validateStockParticleOperatorPairing(definitions);
  if (!pairing.ok) throw new Error(pairing.error.hint);
  return new ParticleOperatorRegistry(definitions);
}
