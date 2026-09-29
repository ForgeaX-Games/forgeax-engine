import { RenderQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { CameraSnapshot } from '../../render-contract';
import type { DispatchEntry, RenderableSnapshot } from '../../render-system-extract';
import { TransparentSortCache } from '../transparent-dispatch';
import {
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../transparent-sort-config';

function scope(mode: number): RenderResourceScope {
  return {
    hasResource: () => true,
    getResource: () => ({ mode, yzAlpha: 1 }),
  } as unknown as RenderResourceScope;
}

function renderable(x: number, y: number, z: number): RenderableSnapshot {
  const world = new Float32Array(16);
  world[0] = world[5] = world[10] = world[15] = 1;
  world[12] = x;
  world[13] = y;
  world[14] = z;
  return { transform: { world } } as unknown as RenderableSnapshot;
}

function entry(renderableIndex: number, queue: number, layer = 0, material = 0): DispatchEntry {
  return {
    entityIndex: renderableIndex,
    materialHandle: material,
    renderableIndex,
    passIndex: 0,
    queue,
    layer,
    tags: {},
  } as unknown as DispatchEntry;
}

function camera(x: number, y: number, z: number): CameraSnapshot {
  return { position: new Float32Array([x, y, z]) } as unknown as CameraSnapshot;
}

/** Independent reference: stable sort of the transparent subset in place. */
function reference(
  dispatch: readonly DispatchEntry[],
  renderables: readonly RenderableSnapshot[],
  mode: number,
  eye: CameraSnapshot,
): DispatchEntry[] {
  const slots = dispatch.flatMap((e, i) => (e.queue === RenderQueue.Transparent ? [i] : []));
  const value = (e: DispatchEntry) => {
    const w = renderables[e.renderableIndex]?.transform.world as Float32Array;
    if (mode === TRANSPARENT_SORT_MODE_LAYER_Z) return w[14] as number;
    const d = [0, 1, 2].map((k) => (w[12 + k] as number) - (eye.position[k] as number));
    return -d.reduce((sum, n) => sum + n * n, 0);
  };
  const sorted = slots
    .map((slot) => dispatch[slot] as DispatchEntry)
    .sort((a, b) =>
      mode === TRANSPARENT_SORT_MODE_DISTANCE
        ? value(a) - value(b)
        : a.layer - b.layer || value(a) - value(b) || a.materialHandle - b.materialHandle,
    );
  const result = dispatch.slice();
  slots.forEach((slot, k) => {
    result[slot] = sorted[k] as DispatchEntry;
  });
  return result;
}

describe('TransparentSortCache', () => {
  it('matches a fresh stable sort every frame under an orbiting camera and moving slots', () => {
    let seed = 0x7a11;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed / 2 ** 32;
    };
    for (const mode of [TRANSPARENT_SORT_MODE_DISTANCE, TRANSPARENT_SORT_MODE_LAYER_Z]) {
      const cache = new TransparentSortCache();
      const positions = Array.from({ length: 40 }, () => [
        random() * 40 - 20,
        random() * 4,
        // Integer depths create exact key ties that must keep dispatch order.
        Math.floor(random() * 6),
      ]);
      const dispatch = positions.map((_, i) =>
        entry(i, i % 3 === 0 ? RenderQueue.Geometry : RenderQueue.Transparent, i % 2, i % 4),
      );
      for (let frame = 0; frame < 240; frame++) {
        if (frame % 50 === 49) {
          const moved = positions[frame % positions.length] as number[];
          moved[0] = (moved[0] as number) + 3;
        }
        const renderables = positions.map(([x, y, z]) => renderable(x ?? 0, y ?? 0, z ?? 0));
        const angle = frame * 0.02;
        const eye = camera(Math.cos(angle) * 60, 10, Math.sin(angle) * 60);
        const sorted = cache.sort(dispatch, scope(mode), [eye], renderables);
        expect(sorted, `mode=${mode} frame=${frame}`).toEqual(
          reference(dispatch, renderables, mode, eye),
        );
      }
      const { hits, misses } = cache.inspect();
      expect(hits + misses).toBe(240);
      // Layer order is camera-independent: only the five moves (and the
      // first frame) re-sort. Distance order is camera-dependent: every
      // pair crossing under the orbit re-sorts, so only exactness is gated.
      if (mode === TRANSPARENT_SORT_MODE_LAYER_Z) expect(misses).toBeLessThanOrEqual(6);
      else expect(hits).toBeGreaterThan(0);
    }
  });

  it('returns the previous array when the source and verified order are unchanged', () => {
    const cache = new TransparentSortCache();
    const renderables = [renderable(0, 0, 3), renderable(0, 0, 1), renderable(0, 0, 2)];
    const dispatch = renderables.map((_, i) => entry(i, RenderQueue.Transparent));
    const first = cache.sort(dispatch, scope(TRANSPARENT_SORT_MODE_LAYER_Z), [], renderables);
    const second = cache.sort(dispatch, scope(TRANSPARENT_SORT_MODE_LAYER_Z), [], renderables);
    expect(second).toBe(first);
    expect(first.map((e) => e.renderableIndex)).toEqual([1, 2, 0]);
    expect(cache.inspect()).toEqual({ hits: 1, misses: 1 });
  });

  it('never allocates or counts when no reorder is possible', () => {
    const cache = new TransparentSortCache();
    const renderables = [renderable(0, 0, 1), renderable(0, 0, 2)];
    const opaque = renderables.map((_, i) => entry(i, RenderQueue.Geometry));
    expect(cache.sort(opaque, scope(TRANSPARENT_SORT_MODE_DISTANCE), [], renderables)).toBe(opaque);
    const transparent = renderables.map((_, i) => entry(i, RenderQueue.Transparent));
    expect(cache.sort(transparent, scope(TRANSPARENT_SORT_MODE_DISTANCE), [], renderables)).toBe(
      transparent,
    );
    expect(cache.inspect()).toEqual({ hits: 0, misses: 0 });
  });
});
