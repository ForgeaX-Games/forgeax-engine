// pipeline-layout-selection.test.ts
// feat-20260609-hdrp-cluster-fragment-ggx M4.5 / w35 (test, TDD red phase).
//
// Verifies that the per-variant PipelineLayout selector correctly picks
// `hdrpPbrPipelineLayout` for HDRP variants (CLUSTER_FORWARD_AVAILABLE=true
// or canonical '' all-true) and `pbrPipelineLayout` for URP variants
// (CLUSTER_FORWARD_AVAILABLE=false / undefined).
//
// Anchors:
//   - plan-strategy D-10: per-variant PipelineLayout (option A) -- boot-time
//     build a second `hdrpPbrPipelineLayout` with HDRP 7-slot BGL; selector
//     dispatches by `variantSet`.
//   - plan-strategy D-11: variantSet `''` is canonical all-true (when the
//     shader declares CLUSTER_FORWARD_AVAILABLE axis) -- HDRP path.
//   - implement-decisions section 3: hotfix-1 left URP-side standard pipeline
//     using the 1-slot pbr-mesh-array BGL, mismatching HDRP 7-slot BGL.
//
// Mocks:
//   PipelineLayout is an opaque RHI handle; we use sentinel objects to test
//   reference identity (the selector returns one of two layouts).
//
// TDD red phase (w35): `selectPipelineLayoutForVariant` does NOT exist and
// pipelineState carries no `hdrpPbrPipelineLayout` field yet. Test imports
// will fail until w36 lands the boot-time build + w37 lands the selector.

import type { PipelineLayout } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';

import { selectPipelineLayoutForVariant } from '../createRenderer';

// Sentinel handles -- structurally `unknown` opaque tokens.
const URP_LAYOUT = { __brand: 'urp' } as unknown as PipelineLayout;
const HDRP_LAYOUT = { __brand: 'hdrp' } as unknown as PipelineLayout;
// bug-20260611-skin-pipeline-layout: selector state shape now includes
// `pbrSkinPipelineLayout`. Pre-existing HDRP/URP routing tests pass null
// for the skin slot to keep their behaviour byte-identical to pre-bug;
// dedicated skin-routing cases live below in their own describe block.
const SKIN_LAYOUT = { __brand: 'skin' } as unknown as PipelineLayout;

const FULL_STATE = {
  pbrPipelineLayout: URP_LAYOUT,
  hdrpPbrPipelineLayout: HDRP_LAYOUT,
  pbrSkinPipelineLayout: null,
};

describe('selectPipelineLayoutForVariant -- HDRP vs URP routing (M4.5 / w35)', () => {
  it('(a) HDRP variantSet `CLUSTER_FORWARD_AVAILABLE=true+...` -> hdrpPbrPipelineLayout', () => {
    const layout = selectPipelineLayoutForVariant(
      FULL_STATE,
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true',
    );
    expect(layout).toBe(HDRP_LAYOUT);
  });

  it("(a) HDRP variantSet '' (canonical all-true) -> hdrpPbrPipelineLayout", () => {
    // Per D-11: '' is the canonical all-true variant key -- equivalent to
    // explicit `CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true`
    // when the shader declares both axes. boot-time registers the HDRP-active
    // entry under '' (createRenderer.ts:2483-2485), so the selector must
    // route '' to the HDRP layout.
    const layout = selectPipelineLayoutForVariant(FULL_STATE, '');
    expect(layout).toBe(HDRP_LAYOUT);
  });

  it("(b) URP variantSet `CLUSTER_FORWARD_AVAILABLE=false+...' -> pbrPipelineLayout", () => {
    const layout = selectPipelineLayoutForVariant(
      FULL_STATE,
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
    );
    expect(layout).toBe(URP_LAYOUT);
  });

  it('(b) URP variantSet without CLUSTER_FORWARD_AVAILABLE axis -> pbrPipelineLayout', () => {
    // STORAGE_BUFFER_AVAILABLE-only variant (shader without the cluster axis
    // declared). Selector must fall back to pbrPipelineLayout because the
    // entry was not registered as HDRP-active.
    const layout = selectPipelineLayoutForVariant(FULL_STATE, 'STORAGE_BUFFER_AVAILABLE=true');
    expect(layout).toBe(URP_LAYOUT);
  });

  it('(c) variantSet undefined -> pbrPipelineLayout (backward-compat default)', () => {
    const layout = selectPipelineLayoutForVariant(FULL_STATE, undefined);
    expect(layout).toBe(URP_LAYOUT);
  });

  it('null pipelineState -> null (Camera-only / empty-manifest path)', () => {
    expect(selectPipelineLayoutForVariant(null, '')).toBeNull();
    expect(selectPipelineLayoutForVariant(null, undefined)).toBeNull();
    expect(
      selectPipelineLayoutForVariant(
        null,
        'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true',
      ),
    ).toBeNull();
  });

  it('hdrpPbrPipelineLayout null but pbrPipelineLayout non-null -> graceful URP fallback for HDRP variant', () => {
    // When manifest has the cluster axis but boot-time HDRP layout build
    // failed (e.g., storage buffer not capable), HDRP variant falls back to
    // URP layout instead of returning null. This avoids hard-disabling the
    // PSO build path; the WGSL itself will be the URP variant via
    // findVariantByKey resolution upstream.
    const partial = {
      pbrPipelineLayout: URP_LAYOUT,
      hdrpPbrPipelineLayout: null,
      pbrSkinPipelineLayout: null,
    };
    expect(selectPipelineLayoutForVariant(partial, '')).toBe(URP_LAYOUT);
    expect(
      selectPipelineLayoutForVariant(
        partial,
        'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true',
      ),
    ).toBe(URP_LAYOUT);
  });

  it('pbrPipelineLayout null -> null (URP variant has no fallback)', () => {
    const partial = {
      pbrPipelineLayout: null,
      hdrpPbrPipelineLayout: HDRP_LAYOUT,
      pbrSkinPipelineLayout: null,
    };
    expect(selectPipelineLayoutForVariant(partial, undefined)).toBeNull();
    expect(
      selectPipelineLayoutForVariant(
        partial,
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
      ),
    ).toBeNull();
  });
});

// bug-20260611-skin-pipeline-layout-mesh-array-bgl-2bindings:
// dedicated tests for the LayoutKind='pbr-skin' branch + grep gate.
describe('selectPipelineLayoutForVariant -- skin LayoutKind routing (bug-20260611)', () => {
  it('(a) layoutKind=pbr-skin -> pbrSkinPipelineLayout', () => {
    const state = {
      pbrPipelineLayout: URP_LAYOUT,
      hdrpPbrPipelineLayout: HDRP_LAYOUT,
      pbrSkinPipelineLayout: SKIN_LAYOUT,
    };
    expect(selectPipelineLayoutForVariant(state, undefined, 'pbr-skin')).toBe(SKIN_LAYOUT);
  });

  it('(b) layoutKind=pbr-skin + variantSet="" -> pbrSkinPipelineLayout (skin overrides HDRP)', () => {
    // HDRP × skin is OOS-1; skin routing wins. Tests the precedence ordering.
    const state = {
      pbrPipelineLayout: URP_LAYOUT,
      hdrpPbrPipelineLayout: HDRP_LAYOUT,
      pbrSkinPipelineLayout: SKIN_LAYOUT,
    };
    expect(selectPipelineLayoutForVariant(state, '', 'pbr-skin')).toBe(SKIN_LAYOUT);
  });

  it('(c) layoutKind=pbr-skin + pbrSkinPipelineLayout=null -> null (charter P3 explicit fail, AC-10)', () => {
    // Explicit failure -- no silent fallback to URP layout. Mirrors memory
    // anchor `hdrp-active-must-not-fallback-to-urp-pipeline`.
    const state = {
      pbrPipelineLayout: URP_LAYOUT,
      hdrpPbrPipelineLayout: HDRP_LAYOUT,
      pbrSkinPipelineLayout: null,
    };
    expect(selectPipelineLayoutForVariant(state, undefined, 'pbr-skin')).toBeNull();
  });

  it('(d) layoutKind=undefined + skin layout present -> still URP/HDRP path (back-compat)', () => {
    // Existing PBR/HDRP callers (no layoutKind argument) MUST NOT pick the
    // skin layout. AC-08 no-collateral.
    const state = {
      pbrPipelineLayout: URP_LAYOUT,
      hdrpPbrPipelineLayout: HDRP_LAYOUT,
      pbrSkinPipelineLayout: SKIN_LAYOUT,
    };
    expect(selectPipelineLayoutForVariant(state, undefined)).toBe(URP_LAYOUT);
    expect(selectPipelineLayoutForVariant(state, '')).toBe(HDRP_LAYOUT);
  });
});

// bug-20260708 M2 (c) AC-04: dedicated tests for the LayoutKind='sprite-urp'
// branch. Sprite / sprite-lit shaders reuse the URP 1-slot mesh-array
// pipeline layout but their canonical all-true variant key ''
// (SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET === '') MUST NOT be
// mis-routed through the variantSet==='' -> HDRP branch. Prevents
// R-1' device-lost when a SpriteInstances batch requests the canonical
// PIR=true variant.
describe('selectPipelineLayoutForVariant -- sprite-urp LayoutKind routing (bug-20260708)', () => {
  const SPRITE_FULL_STATE = {
    pbrPipelineLayout: URP_LAYOUT,
    hdrpPbrPipelineLayout: HDRP_LAYOUT,
    pbrSkinPipelineLayout: SKIN_LAYOUT,
  };

  it('(a) layoutKind=sprite-urp + variantSet=undefined -> pbrPipelineLayout (character / sprite-atlas per-entity path)', () => {
    expect(selectPipelineLayoutForVariant(SPRITE_FULL_STATE, undefined, 'sprite-urp')).toBe(
      URP_LAYOUT,
    );
  });

  it('(b) layoutKind=sprite-urp + variantSet="" -> pbrPipelineLayout (SpriteInstances canonical PIR=true batch, NOT HDRP)', () => {
    // Critical assertion. Without the sprite-urp branch the canonical ''
    // variantSet falls into the isHdrpVariant branch of
    // selectPipelineLayoutForVariant (variantSet === '' short-circuit) and
    // returns HDRP_LAYOUT — a 7-slot mesh-array BGL incompatible with the
    // sprite shader's group(2) binding shape. R-1' device-lost path.
    expect(selectPipelineLayoutForVariant(SPRITE_FULL_STATE, '', 'sprite-urp')).toBe(URP_LAYOUT);
  });

  it('(c) layoutKind=sprite-urp overrides variantSet with CLUSTER_FORWARD_AVAILABLE=true -> URP (sprite has no HDRP variant)', () => {
    // Sprite shaders never emit CLUSTER_FORWARD_AVAILABLE axis; this
    // scenario is a defensive check that sprite-urp routing is stable
    // even if some caller mis-passes an HDRP-like variantSet.
    expect(
      selectPipelineLayoutForVariant(
        SPRITE_FULL_STATE,
        'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true',
        'sprite-urp',
      ),
    ).toBe(URP_LAYOUT);
  });

  it('(d) layoutKind=sprite-urp + pbrPipelineLayout=null -> null (URP layout unavailable, charter P3 explicit fail)', () => {
    const partial = {
      pbrPipelineLayout: null,
      hdrpPbrPipelineLayout: HDRP_LAYOUT,
      pbrSkinPipelineLayout: SKIN_LAYOUT,
    };
    expect(selectPipelineLayoutForVariant(partial, undefined, 'sprite-urp')).toBeNull();
    expect(selectPipelineLayoutForVariant(partial, '', 'sprite-urp')).toBeNull();
  });

  it('(e) pbr-skin still wins over sprite-urp when both would apply (skin precedence anchored earlier in selector)', () => {
    // Defensive: if a call ever lands with layoutKind='pbr-skin' + a
    // sprite-like variantSet, the skin branch must take precedence (order
    // of switch arms in the selector). This pins the ordering so a future
    // reshuffle of the switch arms doesn't silently accept sprite routing
    // for a skin caller.
    expect(selectPipelineLayoutForVariant(SPRITE_FULL_STATE, '', 'pbr-skin')).toBe(SKIN_LAYOUT);
  });
});
