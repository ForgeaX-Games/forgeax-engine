// @forgeax/engine-debug-draw -- capacity unit tests (w9 + w10)
//
// Tests for:
// - w9: capacity resize triggers warn + doubles buffer (AC-08)
// - w10: hard-capacity truncate + warn (AC-09)

import { describe, expect, it, vi } from 'vitest';
import { DebugDraw, INITIAL_VERTEX_CAPACITY, MAX_VERTEX_CAPACITY } from '../src';

function makeMockDevice() {
  return {
    destroyBuffer: vi.fn(),
    queue: { writeBuffer: vi.fn() },
  } as any;
}

function makeDd(initialCap = INITIAL_VERTEX_CAPACITY) {
  const device = makeMockDevice();
  return new DebugDraw(
    device,
    {} as any, // pipeline
    {} as any, // vbo
    {} as any, // uniformBuf
    {} as any, // bindGroup
    initialCap,
    MAX_VERTEX_CAPACITY,
  );
}

describe('w9: capacity resize triggers warn + doubles buffer (AC-08)', () => {
  it('INITIAL_VERTEX_CAPACITY is imported and matches constant', () => {
    expect(INITIAL_VERTEX_CAPACITY).toBe(1024);
  });

  it('buffer capacity doubles to 2048 when exceeding INITIAL_VERTEX_CAPACITY', () => {
    const dd = makeDd();

    // Push exactly INITIAL_VERTEX_CAPACITY vertices (512 lines of 2 vertices each)
    for (let i = 0; i < INITIAL_VERTEX_CAPACITY / 2; i++) {
      dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);
    }

    expect(dd._stagingVertexCount).toBe(INITIAL_VERTEX_CAPACITY);

    // One more line (2 vertices) should trigger resize
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);

    expect(dd._capacity).toBe(INITIAL_VERTEX_CAPACITY * 2); // 2048
    expect(dd._stagingVertexCount).toBe(INITIAL_VERTEX_CAPACITY + 2);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe('w10: hard-capacity truncate + warn (AC-09)', () => {
  it('MAX_VERTEX_CAPACITY is imported and matches constant', () => {
    expect(MAX_VERTEX_CAPACITY).toBe(1_000_000);
  });

  it('vertices are capped at MAX_VERTEX_CAPACITY; excess discarded with warning', () => {
    // Create with capacity = MAX to test truncation at the hard cap
    const dd = makeDd(MAX_VERTEX_CAPACITY);

    // Fill staging to MAX_VERTEX_CAPACITY
    for (let i = 0; i < MAX_VERTEX_CAPACITY / 2; i++) {
      dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);
    }

    // Try to add more vertices
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);

    // Staging should be capped at MAX
    expect(dd._stagingVertexCount).toBeLessThanOrEqual(MAX_VERTEX_CAPACITY);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});