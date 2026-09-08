import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { createRenderReadLease, type RenderProjectionRequest } from '../projection/index';
import { World } from '../world';

const Position = defineComponent('RenderReadPosition', {
  x: 'f32',
  y: 'f32',
});

const request: RenderProjectionRequest = {
  components: [{ component: Position, fields: ['x', 'y'] }],
};

describe('RenderReadLease contract', () => {
  it('attaches, exposes a world generation, and reads continuous spans', () => {
    const world = new World();
    world.spawn({ component: Position, data: { x: 1, y: 2 } }).unwrap();
    const lease = createRenderReadLease(world);

    expect(lease.worldIdentity).toBe(world.identity);
    expect(lease.generation).toBeGreaterThan(0);
    const projection = lease.querySpans(request);
    expect(projection.generation).toBe(lease.generation);
    expect(projection.spans).toHaveLength(1);
    expect(projection.spans[0]?.fields.x).toEqual(new Float32Array([1]));
    expect(projection.spans[0]?.fields.y).toEqual(new Float32Array([2]));
  });

  it('publishes world and shared-ref changes through one cursor contract', () => {
    const world = new World();
    const lease = createRenderReadLease(world);
    const cursor = lease.inspectCursor();
    const entity = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    world.set(entity, Position, { x: 3 }).unwrap();
    const batch = lease.readChanges(cursor);

    expect(batch.status).toBe('ok');
    if (batch.status !== 'ok') return;
    expect(batch.cursor).toBeGreaterThan(cursor);
    expect(batch.world.records.some((record) => record.kind === 'component-changed')).toBe(true);
    expect(batch.sharedRefs.status).toBe('ok');
  });

  it('reports overflow and requires an explicit resync', () => {
    const world = new World();
    const lease = createRenderReadLease(world);
    const staleCursor = 0;

    for (let index = 0; index < 65537; index += 1) {
      const entity = world.spawn({ component: Position, data: { x: index, y: 0 } }).unwrap();
      world.despawn(entity).unwrap();
    }

    const batch = lease.readChanges(staleCursor);
    expect(batch.status).toBe('overflow');
    if (batch.status !== 'overflow') return;
    expect(batch.resync).toBe(true);
    expect(batch.oldestAvailable).toBeGreaterThan(staleCursor);
  });

  it('detaches idempotently and rejects reads after dispose', () => {
    const lease = createRenderReadLease(new World());
    lease.dispose();
    lease.dispose();

    expect(() => lease.inspectCursor()).toThrow(/disposed/i);
    expect(() => lease.querySpans(request)).toThrow(/disposed/i);
  });

  it('distinguishes leases from renderer-owned projections', () => {
    const world = new World();
    const lease = createRenderReadLease(world);
    const projection = lease.querySpans(request);

    expect(projection).not.toBe(lease);
    expect(Object.keys(projection)).toEqual(['generation', 'sharedRefEpoch', 'spans']);
  });
});
