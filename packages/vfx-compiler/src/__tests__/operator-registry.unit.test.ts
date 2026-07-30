import { describe, expect, it } from 'vitest';
import { type ParticleOperatorDefinition, ParticleOperatorRegistry } from '../operator-registry.js';

type SyntheticParams = { readonly strength: number };

function definition(
  kind: string,
  version = 1,
  compile: ParticleOperatorDefinition<SyntheticParams>['compile'] = {
    cpu: () => ({ backend: 'cpu' }),
    gpu: () => ({ backend: 'gpu' }),
  },
): ParticleOperatorDefinition<SyntheticParams> {
  return {
    stage: 'update',
    kind,
    version,
    parameterSchema: { type: 'object', required: ['strength'] },
    validateParams: (params) =>
      typeof params === 'object' && params !== null && 'strength' in params
        ? { ok: true, value: undefined, unwrap: () => undefined, unwrapOr: () => undefined }
        : {
            ok: false,
            error: {
              code: 'vfx-operator-params-invalid',
              expected: 'params.strength is a finite number',
              hint: 'provide a finite strength value',
              detail: { stage: 'update', kind, version, path: 'params.strength' },
            },
            unwrap: () => {
              throw new Error('invalid params');
            },
            unwrapOr: <T>(defaultValue: T) => defaultValue,
          },
    compile,
  };
}

describe('ParticleOperatorRegistry', () => {
  it('resolves definitions by stable stage, kind, and version key', () => {
    const registry = new ParticleOperatorRegistry([
      definition('synthetic-b'),
      definition('synthetic-a'),
    ]);

    const resolved = registry.resolve('update', 'synthetic-a', 1);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.kind).toBe('synthetic-a');
    expect(resolved.value.parameterSchema).toEqual({ type: 'object', required: ['strength'] });
    expect(resolved.value.compile.cpu).toBeTypeOf('function');
    expect(resolved.value.compile.gpu).toBeTypeOf('function');
  });

  it('finds a synthetic definition through registration without a kind branch', () => {
    const registry = new ParticleOperatorRegistry();
    const synthetic = definition('synthetic-new');

    expect(registry.register(synthetic).ok).toBe(true);
    const resolved = registry.resolve('update', 'synthetic-new', 1);

    expect(resolved.ok).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  it('returns stable unknown and conflict errors while keeping the first definition', () => {
    const first = definition('synthetic-conflict', 1);
    const registry = new ParticleOperatorRegistry([first]);

    const unknown = registry.resolve('spawn', 'missing', 1);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('vfx-operator-unknown');
      expect(unknown.error.detail.stage).toBe('spawn');
      expect(unknown.error.expected).toContain('registered');
      expect(unknown.error.hint).toContain('register');
    }

    const conflict = registry.register({ ...first, compile: { cpu: () => ({}) } });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe('vfx-operator-conflict');
      expect(conflict.error.detail.kind).toBe('synthetic-conflict');
    }

    const resolved = registry.resolve('update', 'synthetic-conflict', 1);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.compile.gpu).toBeTypeOf('function');
  });
});
