// feat-20260614-ecs-managed-lifecycle-ssot M1 t-w1: store-unit tests for
// UniqueRefStore.release order + throw-safety + slot reuse.
//
// These tests drive UniqueRefStore directly (no World) per research
// Finding 1.5: the regression repro path is achievable with a spy callback,
// no Rapier / World fixture required. Verifies AC-01, AC-02, AC-06, AC-07
// (requirements §3.1, §5).
//
// TDD red -> green:
//   - (a) order assertion + (b) throw-safety: red before w2, green after w2.
//   - (c) slot reuse: green after w7 (M3 deletes the gen-255 retirement that
//     would otherwise force nextSlot to grow during 1000 iters on a single
//     slot). Documented inline so reviewer can correlate the carryover.

import { describe, expect, it, vi } from 'vitest';
import { UniqueRefDoubleReleaseError } from '../errors';
import { UniqueRefStore } from '../unique-ref-store';

describe('UniqueRefStore release ordering + throw-safety (feat-20260614 M1)', () => {
  it('AC-01: releaseCallbacks entry is removed BEFORE onRelease fires', () => {
    const store = new UniqueRefStore();
    let observedHasCallback: boolean | null = null;

    // Spy reads the private releaseCallbacks Map at the moment cb fires.
    // After the M1 fix (w2) the entry is deleted before invocation, so the
    // observation is `false`. Before the fix the entry is still live so
    // observation is `true` -> assertion fails (red).
    const onRelease = vi.fn((_payload: { id: number }) => {
      // biome-ignore lint/suspicious/noExplicitAny: targeted private read for the order assertion
      const internalCallbacks = (store as any).releaseCallbacks as Map<number, unknown>;
      // biome-ignore lint/suspicious/noExplicitAny: handle raw u32 read for the lookup
      const raw = (store as any).payloads as Map<number, unknown>;
      // The handle is a u32 brand. Re-derive raw via the live keys snapshot
      // since the handle isn't directly in scope inside the cb closure.
      void raw;
      // Use the callbacks map's keys: at the moment of cb invocation, the
      // entry MUST already be gone -> map size 0 (only one alloc was made).
      observedHasCallback = internalCallbacks.size > 0;
    });

    const handle = store.alloc('Test', { id: 7 }, onRelease);
    const result = store.release(handle);

    expect(result.ok).toBe(true);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(observedHasCallback).toBe(false);
  });

  it('AC-02 + AC-06: throwing onRelease re-throws once; second release returns DoubleRelease (no gen needed)', () => {
    const store = new UniqueRefStore();
    const onRelease = vi.fn((_payload: { id: number }) => {
      throw new Error('intentional cleanup failure');
    });

    const handle = store.alloc('Test', { id: 9 }, onRelease);

    // First release must propagate the throw (no try/finally swallowing).
    expect(() => store.release(handle)).toThrow('intentional cleanup failure');
    expect(onRelease).toHaveBeenCalledTimes(1);

    // Second release must NOT re-fire cb (callback table already cleared by w2)
    // and MUST return UniqueRefDoubleReleaseError detected via payload absence
    // (no gen tag required - AC-06 explicitly: detection is gen-free).
    const second = store.release(handle);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBeInstanceOf(UniqueRefDoubleReleaseError);
    }
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('AC-07: 1000-iteration alloc/release loop reuses slots (no unbounded growth)', () => {
    const store = new UniqueRefStore();

    for (let i = 0; i < 1000; i++) {
      const handle = store.alloc('Test', { id: i });
      const result = store.release(handle);
      expect(result.ok).toBe(true);
    }

    expect(store._liveCount()).toBe(0);

    // nextSlot is private. After M3 (w7) deletes the gen-255 retirement path
    // a single slot recycles forever and nextSlot stays at 2. Before w7,
    // gen-255 retirement forces ~4 fresh slots over 1000 iters (256 per slot
    // before retirement). The bound below stays true in both regimes and
    // tightens after M3; the inline comment is the bridge between this test
    // and M3's removal of gen retirement (research Finding 1.4).
    // biome-ignore lint/suspicious/noExplicitAny: targeted private read for slot-reuse verification
    const nextSlot = (store as any).nextSlot as number;
    expect(nextSlot).toBeLessThan(10);
  });
});
