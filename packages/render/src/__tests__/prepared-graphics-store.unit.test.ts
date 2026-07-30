import { describe, expect, it } from 'vitest';
import {
  createPreparedGraphicsStore,
  type PreparedGraphicsKind,
} from '../features/prepared-graphics-store';

function prepare(
  transaction: ReturnType<ReturnType<typeof createPreparedGraphicsStore>['beginFrame']>,
  kind: PreparedGraphicsKind,
  name: string,
) {
  return transaction.prepare(kind, name, { signature: `${kind}:${name}` });
}

describe('prepared graphics store transactions', () => {
  it('reuses committed same-generation resources and keeps new resources in the overlay', () => {
    const store = createPreparedGraphicsStore();
    const first = store.beginFrame('synthetic.feature', 4);
    const committed = prepare(first, 'pipeline', 'forward');
    expect(committed.ok).toBe(true);
    expect(first.committedItems()).toHaveLength(0);
    expect(first.overlayItems()).toHaveLength(1);
    expect(first.commit().ok).toBe(true);

    const second = store.beginFrame('synthetic.feature', 4);
    const reused = prepare(second, 'pipeline', 'forward');
    const fresh = prepare(second, 'bindings', 'forward');
    expect(reused.ok).toBe(true);
    expect(fresh.ok).toBe(true);
    if (committed.ok && reused.ok) expect(reused.value).toBe(committed.value);
    expect(second.committedItems()).toHaveLength(1);
    expect(second.overlayItems()).toHaveLength(1);
  });

  it('aborts the overlay without changing committed ownership', () => {
    const store = createPreparedGraphicsStore();
    const initial = store.beginFrame('synthetic.feature', 1);
    prepare(initial, 'pipeline', 'forward');
    initial.commit();

    const failed = store.beginFrame('synthetic.feature', 1);
    prepare(failed, 'bindings', 'forward');
    failed.abort();

    expect(store.snapshot('synthetic.feature')).toMatchObject({
      generation: 1,
      items: [{ kind: 'pipeline', name: 'forward' }],
    });
    expect(failed.overlayItems()).toEqual([]);
    expect(failed.commit().ok).toBe(false);
  });

  it('keeps ownership scoped to the feature and generation', () => {
    const store = createPreparedGraphicsStore();
    const alpha = store.beginFrame('synthetic.alpha', 2);
    const beta = store.beginFrame('synthetic.beta', 2);
    const old = store.beginFrame('synthetic.alpha', 1);
    prepare(alpha, 'vertex-data', 'quad');
    prepare(beta, 'vertex-data', 'quad');
    prepare(old, 'vertex-data', 'quad');
    alpha.commit();
    beta.commit();
    old.commit();

    expect(store.snapshot('synthetic.alpha').items).toHaveLength(1);
    expect(store.snapshot('synthetic.beta').items).toHaveLength(1);
    expect(store.snapshot('synthetic.alpha').generation).toBe(1);
  });
});
