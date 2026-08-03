import { STOCK_PARTICLE_OPERATOR_MANIFEST } from '@forgeax/engine-vfx';
import {
  createStockParticleOperatorRegistry,
  validateStockParticleOperatorPairing,
} from '@forgeax/engine-vfx-compiler';
import { describe, expect, it } from 'vitest';

const keyOf = (entry: { stage: string; kind: string; version: number }) =>
  `${entry.stage}:${entry.kind}:${entry.version}`;

describe('stock compiler/runtime pairing', () => {
  it('projects the canonical roster without manual registration', () => {
    const registry = createStockParticleOperatorRegistry();

    expect(registry.list().map(keyOf)).toEqual(STOCK_PARTICLE_OPERATOR_MANIFEST.map(keyOf).sort());
    expect(validateStockParticleOperatorPairing(registry).ok).toBe(true);
  });

  it('reports a missing compiler half as a structured failure', () => {
    const registry = createStockParticleOperatorRegistry();
    const missing = registry.list().slice(1);
    const result = validateStockParticleOperatorPairing(missing);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('vfx-stock-operator-half-missing');
      expect(result.error.detail.side).toBe('compiler');
      expect(result.error.hint).toContain('compiler');
    }
  });

  it('reports a version mismatch as a structured failure', () => {
    const registry = createStockParticleOperatorRegistry();
    const changed = registry
      .list()
      .map((entry, index) => (index === 0 ? { ...entry, version: entry.version + 1 } : entry));
    const result = validateStockParticleOperatorPairing(changed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('vfx-stock-operator-version-mismatch');
      expect(result.error.detail.expectedVersion).toBe(1);
      expect(result.error.detail.actualVersion).toBe(2);
    }
  });
});
