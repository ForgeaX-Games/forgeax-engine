import { describe, expect, it } from 'vitest';
import {
  type ParticleBackendPolicy,
  type ParticleOperatorDefinition,
  ParticleOperatorRegistry,
} from '../operator-registry.js';

function operator(
  stage: ParticleOperatorDefinition<unknown>['stage'],
  kind: string,
  capabilities: { readonly cpu?: boolean; readonly gpu?: boolean },
): ParticleOperatorDefinition<unknown> {
  return {
    stage,
    kind,
    version: 1,
    parameterSchema: { type: 'object' },
    validateParams: () => ({
      ok: true,
      value: undefined,
      unwrap: () => undefined,
      unwrapOr: () => undefined,
    }),
    compile: {
      ...(capabilities.cpu ? { cpu: () => ({}) } : {}),
      ...(capabilities.gpu ? { gpu: () => ({}) } : {}),
    },
  };
}

const policies: readonly [string, ParticleBackendPolicy, string, readonly string[]][] = [
  ['required cpu', { kind: 'required', backend: 'cpu' }, 'cpu', ['cpu']],
  ['required gpu', { kind: 'required', backend: 'gpu' }, 'gpu', ['gpu']],
  [
    'preferred gpu with cpu fallback',
    { kind: 'preferred', backend: 'gpu', fallback: 'cpu' },
    'gpu-with-cpu-fallback',
    ['gpu', 'cpu'],
  ],
  [
    'preferred gpu with disable fallback',
    { kind: 'preferred', backend: 'gpu', fallback: 'disable' },
    'gpu-or-disable',
    ['gpu'],
  ],
];

describe('ParticleOperatorRegistry backend policy', () => {
  it.each(policies)('plans %s without rewriting policy', (_name, policy, kind, backends) => {
    const registry = new ParticleOperatorRegistry([
      operator('update', 'synthetic-update', { cpu: true, gpu: true }),
      operator('output', 'synthetic-output', { cpu: true, gpu: true }),
    ]);

    const plan = registry.resolveBackendPlan({
      emitterId: 'smoke',
      operators: [
        { stage: 'update', kind: 'synthetic-update', version: 1 },
        { stage: 'output', kind: 'synthetic-output', version: 1 },
      ],
      policy,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.kind).toBe(kind);
    expect(plan.value.backends).toEqual(backends);
  });

  it('fails required GPU when an operator has no GPU compiler', () => {
    const registry = new ParticleOperatorRegistry([
      operator('update', 'cpu-only-update', { cpu: true }),
      operator('output', 'gpu-output', { gpu: true }),
    ]);

    const plan = registry.resolveBackendPlan({
      emitterId: 'smoke',
      operators: [
        { stage: 'update', kind: 'cpu-only-update', version: 1 },
        { stage: 'output', kind: 'gpu-output', version: 1 },
      ],
      policy: { kind: 'required', backend: 'gpu' },
    });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe('vfx-operator-backend-unsupported');
    expect(plan.error.detail.emitterId).toBe('smoke');
    expect(plan.error.detail.operator).toEqual({
      stage: 'update',
      kind: 'cpu-only-update',
      version: 1,
    });
    expect(plan.error.detail.backend).toBe('gpu');
    expect(plan.error.expected).toContain('compiler');
    expect(plan.error.hint).toContain('register');
  });

  it('fails preferred GPU with incomplete CPU fallback instead of returning GPU-only success', () => {
    const registry = new ParticleOperatorRegistry([
      operator('update', 'gpu-only-update', { gpu: true }),
      operator('output', 'gpu-output', { gpu: true }),
    ]);

    const plan = registry.resolveBackendPlan({
      emitterId: 'smoke',
      operators: [
        { stage: 'update', kind: 'gpu-only-update', version: 1 },
        { stage: 'output', kind: 'gpu-output', version: 1 },
      ],
      policy: { kind: 'preferred', backend: 'gpu', fallback: 'cpu' },
    });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe('vfx-operator-backend-unsupported');
    expect(plan.error.detail.backend).toBe('cpu');
  });
});
