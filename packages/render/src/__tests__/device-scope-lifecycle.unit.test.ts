import { describe, expect, it } from 'vitest';
import {
  DeviceScope,
  type LifecycleResourceSpec,
  LifecycleTransaction,
} from '../device/device-scope';

function spec(
  kind: LifecycleResourceSpec<unknown>['kind'],
  order: string[],
  index: number,
  failAt?: number,
): LifecycleResourceSpec<unknown> {
  return {
    kind,
    create: () => {
      if (failAt === index) throw new Error(`create-${kind}`);
      order.push(`create:${kind}`);
      return { kind };
    },
    cleanup: () => {
      order.push(`cleanup:${kind}`);
    },
  };
}

describe('DeviceScope lifecycle transaction', () => {
  it('rolls back the first N-1 resources in reverse order and keeps the primary error', async () => {
    const scope = DeviceScope.create(7, 'renderer');
    const order: string[] = [];
    const transaction = new LifecycleTransaction(scope, { failureAt: 4 });
    transaction.add(spec('listener', order, 1));
    transaction.add(spec('surface', order, 2));
    transaction.add(spec('shader', order, 3));
    transaction.add(spec('pipeline', order, 4, 4));

    const result = await transaction.commit();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.primary.code).toBe('lifecycle-construction-failed');
      expect(result.error.primary.detail.owner).toBe('renderer');
      expect(result.error.cleanupFailures).toEqual([]);
      expect(result.error.receipt.generation).toBe(7);
    }
    expect(order).toEqual([
      'create:listener',
      'create:surface',
      'create:shader',
      'cleanup:shader',
      'cleanup:surface',
      'cleanup:listener',
    ]);
    expect(scope.resourceDelta()).toBe(0);
    expect(scope.state).toBe('active');
  });

  it('collects cleanup failures without changing the primary error or resource delta', async () => {
    const scope = DeviceScope.create(8, 'renderer');
    const transaction = new LifecycleTransaction(scope, { failureAt: 3 });
    transaction.add({
      kind: 'buffer',
      create: () => ({ id: 'buffer' }),
      cleanup: () => {
        throw new Error('buffer-cleanup');
      },
    });
    transaction.add({
      kind: 'texture',
      create: () => ({ id: 'texture' }),
      cleanup: () => undefined,
    });
    transaction.add({
      kind: 'binding',
      create: () => {
        throw new Error('binding-create');
      },
      cleanup: () => undefined,
    });

    const result = await transaction.commit();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.primary.detail.operation).toBe('create');
      expect(result.error.primary.detail.resourceKind).toBe('binding');
      expect(result.error.cleanupFailures).toHaveLength(1);
      expect(result.error.cleanupFailures[0]?.resourceKind).toBe('buffer');
    }
    expect(scope.resourceDelta()).toBe(0);
  });

  it('publishes a replacement only after complete success and retires the old scope', async () => {
    const current = DeviceScope.create(10, 'renderer');
    const oldRef = current.ref('shader', { id: 'old' });

    const replacementResult = await current.replace(11, [
      {
        kind: 'shader',
        create: () => ({ id: 'new' }),
        cleanup: () => undefined,
      },
    ]);

    expect(replacementResult.ok).toBe(true);
    if (replacementResult.ok) {
      expect(current.state).toBe('retired');
      expect(replacementResult.value.state).toBe('active');
      expect(replacementResult.value.parent).toBe(current);
      expect(oldRef.isStale(replacementResult.value)).toBe(true);
    }
  });

  it('keeps the current scope active when replacement construction is lost', async () => {
    const current = DeviceScope.create(20, 'renderer');
    const result = await current.replace(21, [
      {
        kind: 'surface',
        create: () => {
          throw new Error('replacement-loss');
        },
        cleanup: () => undefined,
      },
    ]);

    expect(result.ok).toBe(false);
    expect(current.state).toBe('active');
    expect(current.generation).toBe(20);
    expect(current.resourceDelta()).toBe(0);
  });

  it('makes dispose win over an in-flight construction and terminalizes pending work', async () => {
    const scope = DeviceScope.create(30, 'renderer');
    let resolveCreate: ((value: { id: string }) => void) | undefined;
    const transaction = new LifecycleTransaction(scope);
    transaction.add({
      kind: 'post-effect',
      create: () => new Promise<{ id: string }>((resolve) => (resolveCreate = resolve)),
      cleanup: () => undefined,
    });

    const pending = transaction.commit();
    scope.dispose();
    resolveCreate?.({ id: 'late' });
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(scope.state).toBe('disposed');
    expect(scope.resourceDelta()).toBe(0);
  });
});
