import {
  createStockParticleCpuExecutorRegistry,
  STOCK_PARTICLE_OPERATOR_MANIFEST,
} from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';

const expectedKeys = [
  'initialize:initial-velocity:1',
  'initialize:lifetime:1',
  'output:billboard:1',
  'output:mesh:1',
  'spawn:shape:1',
  'update:color-over-life:1',
  'update:drag:1',
  'update:gravity:1',
  'update:size-over-life:1',
];

describe('stock particle operator manifest', () => {
  it('publishes the complete canonical key and version roster', () => {
    const manifestKeys = STOCK_PARTICLE_OPERATOR_MANIFEST.map(
      (entry) => `${entry.stage}:${entry.kind}:${entry.version}`,
    ).sort();

    expect(manifestKeys).toEqual(expectedKeys);
  });

  it('validates the parameter contract for every stock operator', () => {
    for (const entry of STOCK_PARTICLE_OPERATOR_MANIFEST) {
      expect(entry.validateParams(entry.exampleParams).ok).toBe(true);
      expect(entry.validateParams(undefined).ok).toBe(false);
    }
  });

  it('discovers every runtime executor through the named default factory', () => {
    const registry = createStockParticleCpuExecutorRegistry();

    expect(registry.list().map((entry) => entry.key)).toEqual(expectedKeys);
  });
});
