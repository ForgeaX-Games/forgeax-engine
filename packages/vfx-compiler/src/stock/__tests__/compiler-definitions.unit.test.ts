import { STOCK_PARTICLE_OPERATOR_MANIFEST } from '@forgeax/engine-vfx';
import {
  createStockParticleOperatorRegistry,
  validateStockParticleOperatorPairing,
} from '@forgeax/engine-vfx-compiler';
import { describe, expect, it } from 'vitest';

const keyOf = (entry: { stage: string; kind: string; version: number }) =>
  `${entry.stage}:${entry.kind}:${entry.version}`;

describe('stock compiler definitions', () => {
  it('projects the runtime canonical roster and parameter schemas', () => {
    const registry = createStockParticleOperatorRegistry();

    expect(registry.list().map(keyOf)).toEqual(STOCK_PARTICLE_OPERATOR_MANIFEST.map(keyOf).sort());
    for (const entry of registry.list()) {
      expect(entry.parameterSchema).toEqual(
        STOCK_PARTICLE_OPERATOR_MANIFEST.find((item) => item.key === keyOf(entry))?.parameterSchema,
      );
      expect(entry.validateParams(undefined).ok).toBe(false);
      expect(entry.compile.cpu).toBeTypeOf('function');
    }
    expect(validateStockParticleOperatorPairing(registry).ok).toBe(true);
  });

  it('keeps missing and wrong-version projections narrowable', () => {
    const registry = createStockParticleOperatorRegistry();
    const entries = registry.list();
    const first = entries[0];
    if (first === undefined) throw new Error('stock registry is empty');
    const firstKey = keyOf(first);

    const missing = validateStockParticleOperatorPairing(entries.slice(1));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('vfx-stock-operator-half-missing');

    const wrongVersion = validateStockParticleOperatorPairing(
      entries.map((entry) => (keyOf(entry) === firstKey ? { ...entry, version: 2 } : entry)),
    );
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) {
      expect(wrongVersion.error.code).toBe('vfx-stock-operator-version-mismatch');
      expect(wrongVersion.error.detail.key).toBe(firstKey);
    }
  });
});
