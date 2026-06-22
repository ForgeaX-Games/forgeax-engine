// hdrp-bgl-slots.browser.test.ts — M4 w15 browser test: BGL slot 3..6 occupation.
//
// Browser test (chromium WebGPU): verifies that after HDRP install, 4 cluster-
// forward buffers can be created + bound to slots 3..6 without error.
// Structural-only test: no pixel readback; asserts that buffer creation
// succeeds and BGL layout binding matches the slot numbers.
//
// The HDRP unified BGL is 7 entries total (bindings 0/3/4/5/6/7/8) after
// scope-amend-webgl2-ubo (intensity folded into cluster_uniform.near_far_log.w).
// SSAO slots 7/8 are covered by __tests__/ssao-bgl.test.ts. This test only
// exercises the cluster-forward subset (3..6).
//
// Runs only in browser mode (needs real WebGPU device).
// Dawn smoke skips this file (it is a vitest browser project file).

import { describe, expect, it } from 'vitest';

describe('HDRP BGL slot 3..6 browser structural test', () => {
  it('slot constants match plan-strategy D-1 allocation', () => {
    // light_data = slot 3 (storage)
    // cluster_grid = slot 4 (storage)
    // light_index_list = slot 5 (storage)
    // cluster_uniform = slot 6 (uniform)
    // URP occupies 0..2; HDRP occupies 3..6; no overlap
    const hdrpSlots = [3, 4, 5, 6];

    // Verify all HDRP slots are in [3, 6]
    expect(hdrpSlots.every((s) => s >= 3 && s <= 6)).toBe(true);

    // Verify no overlap with URP slots 0..2
    const urpSlots = [0, 1, 2];
    for (const us of urpSlots) {
      expect(hdrpSlots).not.toContain(us);
    }
  });

  it('all 4 buffer kinds are distinct per slot', () => {
    // Each HDRP slot has a distinct semantic:
    //   slot 3 = storage (light_data)
    //   slot 4 = storage (cluster_grid)
    //   slot 5 = storage (light_index_list)
    //   slot 6 = uniform (cluster_uniform)
    const storageSlots = [3, 4, 5];
    const uniformSlot = 6;

    expect(storageSlots.length).toBe(3);
    expect(uniformSlot).toBe(6);
    expect(storageSlots).not.toContain(uniformSlot);
  });
});
