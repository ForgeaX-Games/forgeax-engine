import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import {
  defineSharedKernel,
  SHARED_KERNEL_EXECUTOR_RESOURCE_KEY,
  type SharedKernelExecutor,
} from '../execution';
import { Update } from '../schedule-token';
import { World } from '../world';

const Position = defineComponent('WorldHealthPosition', { x: 'f32' });
function integrate(): void {}

describe('World execution health', () => {
  it('transitions once to poisoned after a possible partial write and rejects future update', () => {
    const world = new World();
    world.spawn({ component: Position, data: { x: 1 } }).unwrap();
    const executor: SharedKernelExecutor = {
      execute: (_kernel, spans) => {
        spans[0]?.span.mut(Position).x.fill(2);
        return {
          cause: new Error('fixture fault'),
          dispatched: 2,
          completed: 1,
          partialWrite: true,
        };
      },
    };
    world.insertResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY, executor);
    world
      .addSystem(
        Update,
        defineSharedKernel(import.meta.url, {
          name: 'faulting',
          minimumRows: 1,
          queries: [{ write: [Position] }],
          run: integrate,
        }),
      )
      .unwrap();
    expect(() => world.update()).toThrow();
    expect(world.execution.health).toBe('poisoned');
    expect(world.execution.fault?.partialWrite).toBe(true);
    expect(world.execution.fault?.retryable).toBe(false);
    const rejected = world.update();
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('world-poisoned');
  });

  it('gives every rebuilt World a new identity', () => {
    expect(new World().identity).not.toBe(new World().identity);
  });

  it('falls back inline when dispatch fails before any shared write', () => {
    const world = new World();
    world.spawn({ component: Position, data: { x: 1 } }).unwrap();
    const executor: SharedKernelExecutor = {
      execute: () => ({
        cause: new Error('pool not ready'),
        dispatched: 0,
        completed: 0,
        partialWrite: false,
      }),
    };
    world.insertResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY, executor);
    world
      .addSystem(
        Update,
        defineSharedKernel(import.meta.url, {
          name: 'predispatch-fallback',
          minimumRows: 1,
          queries: [{ write: [Position] }],
          run: function inline(spans) {
            spans[0]?.mut(Position).x.fill(3);
          },
        }),
      )
      .unwrap();

    expect(world.update().ok).toBe(true);
    expect(world.execution.health).toBe('healthy');
    const [row] = world.query({ read: [Position] }).unwrap();
    expect(row?.get(Position).x).toBe(3);
  });
});
