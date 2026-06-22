// Consolidated by feat-20260608-ci-time-cut M5 w13/w14: merges
//   - bind-group-cache-key.test.ts
//   - bind-group-cache-sentinel.test.ts
// Each original file body sits in its own block-scope so helper names
// cannot collide; describe() inside still registers globally with vitest.

import type { BindGroup } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  buildBindGroupCacheKey,
  cleanPerEntityCache,
  type RenderFrameState,
} from '../render-system-record';
import { urpPipeline } from '../urp-pipeline';

// ─── from bind-group-cache-key.test.ts ───
{
  // bind-group-cache-key.test.ts -- w9-a (R-2 mutation-resistance unit test)
  //
  // Direct unit test of the pure key-construction function
  // `buildBindGroupCacheKey`. No GPU, no renderer, no draw — the function
  // is the exact seam where the R-2 invariant lives (handle-set completeness
  // in the cache key). A dropped handle produces a key collision that the
  // smoke gate cannot reliably detect (sec.5.3.1 risk).
  //
  // Anchors:
  //   AC-06: variant discriminator isolates main vs shadow
  //   D-2: fine-grain handle-set keys
  //   F-5: Skylight active vs fallback handle ids differ
  //   sec.5.3.1: mutation-resistance criterion
  //
  // Scenarios:
  //   (a) same handle set + same variant -> same key (deterministic)
  //   (b) different handle in any position -> different key
  //   (c) variant discriminator distinguishes (main vs shadow)
  //   (d) dropped handle (shorter list) -> different key (R-2 guard)
  //   (e) 14-entry material-shape key: 1 differing texture handle -> key differs
  //   (f) Skylight active vs fallback: 3 view handles differ -> keys differ

  // ─── helpers ────────────────────────────────────────────────────────────────

  function makeFrameState(): RenderFrameState {
    return {
      frameNumber: 1,
      handleToId: new WeakMap<object, number>(),
      nextHandleId: 0,
      perFrameGraph: null,
      instanceBuffers: new Map(),
      warnedZeroLightStandard: false,
      warnedShadowDisabled: false,
      warnedMultiLightDirectional: false,
      warnedMultiLightPoint: false,
      warnedMultiLightSpot: false,
      warnedMissingSpriteTextureHandles: new Set(),
      warnedNineSliceScaleEntities: new Set(),
      warnedSkyboxTonemapNone: false,
      viewBindGroupCache: new Map(),
      meshBindGroupCache: new Map(),
      materialBgCache: new Map(),
      instancesBgCache: new Map(),
      installedPipelineHandle: 0,
      activePipeline: urpPipeline,
      installedPipelineConfig: undefined,
      isHdrpActive: false,
      hdrpOncePerFrameFired: new Set(),
      pointShadowAtlas: null,
      pointShadowSnapshots: [],
    };
  }

  /** Fresh object for each handle slot — `Map<object,number>` keys by reference. */
  function h(): object {
    return {};
  }

  // ─── deterministic (a) ───────────────────────────────────────────────────────

  describe('buildBindGroupCacheKey', () => {
    it('same handle set + same variant produces the same key (deterministic)', () => {
      const fs = makeFrameState();
      const handle1 = h();
      const handle2 = h();
      const k1 = buildBindGroupCacheKey('main', [handle1, handle2], fs);
      const k2 = buildBindGroupCacheKey('main', [handle1, handle2], fs);
      expect(k1).toBe(k2);
    });
  });

  // ─── different handle in any position (b) ────────────────────────────────────

  describe('buildBindGroupCacheKey', () => {
    it('different handle in position 0 produces different keys', () => {
      const fs = makeFrameState();
      const k1 = buildBindGroupCacheKey('main', [h(), h(), h()], fs);
      const k2 = buildBindGroupCacheKey('main', [h(), h(), h()], fs);
      expect(k1).not.toBe(k2);
    });

    it('different handle in last position produces different keys', () => {
      const fs = makeFrameState();
      const shared = [h(), h()];
      const k1 = buildBindGroupCacheKey('main', [...shared, h()], fs);
      const k2 = buildBindGroupCacheKey('main', [...shared, h()], fs);
      expect(k1).not.toBe(k2);
    });
  });

  // ─── variant discriminator (c) AC-06 ─────────────────────────────────────────

  describe('buildBindGroupCacheKey', () => {
    it("variant 'main' vs 'shadow' produces different keys for same handle set (AC-06)", () => {
      const fs = makeFrameState();
      const handles = [h(), h(), h()];
      const kMain = buildBindGroupCacheKey('main', handles, fs);
      const kShadow = buildBindGroupCacheKey('shadow', handles, fs);
      expect(kMain).not.toBe(kShadow);
    });
  });

  // ─── dropped handle (d): R-2 mutation-resistance ─────────────────────────────

  describe('buildBindGroupCacheKey', () => {
    it('a handle list missing its last entry produces a different key (R-2 guard)', () => {
      const fs = makeFrameState();
      const full = [h(), h(), h(), h(), h()];
      const dropped = full.slice(0, 4); // omit last
      const kFull = buildBindGroupCacheKey('main', full, fs);
      const kDropped = buildBindGroupCacheKey('main', dropped, fs);
      expect(kFull).not.toBe(kDropped);
    });

    it('a handle list missing its first entry produces a different key (R-2 guard)', () => {
      const fs = makeFrameState();
      const full = [h(), h(), h(), h(), h()];
      const dropped = full.slice(1); // omit first
      const kFull = buildBindGroupCacheKey('main', full, fs);
      const kDropped = buildBindGroupCacheKey('main', dropped, fs);
      expect(kFull).not.toBe(kDropped);
    });

    it('a handle list missing a mid-position entry produces a different key (R-2 guard)', () => {
      const fs = makeFrameState();
      const full = [h(), h(), h(), h(), h()];
      const dropped = [full[0], full[1], full[3], full[4]]; // omit index 2
      const kFull = buildBindGroupCacheKey('main', full, fs);
      const kDropped = buildBindGroupCacheKey('main', dropped as object[], fs);
      expect(kFull).not.toBe(kDropped);
    });
  });

  // ─── 14-entry material-shape (e) ─────────────────────────────────────────────
  //
  // Single frameState — key comparison within one frame (both key derivations
  // happen against the same handleToId map). The second call sees the first
  // call's previously-registered handles and assigns the next id for the new
  // handle only, producing a differing key.

  describe('buildBindGroupCacheKey', () => {
    it('14-entry material-shape: one differing baseColor texture id produces different keys', () => {
      const fs = makeFrameState();
      const base = Array.from({ length: 13 }, () => h()); // first 13 shared
      // key A: base + handleX at position 2
      const hX = h();
      const setA = [...base.slice(0, 2), hX, ...base.slice(2)];
      const kA = buildBindGroupCacheKey('material', setA, fs);
      // key B: base + handleY at position 2 (all other handles already in map -> same ids)
      const hY = h();
      const setB = [...base.slice(0, 2), hY, ...base.slice(2)];
      const kB = buildBindGroupCacheKey('material', setB, fs);
      expect(kA).not.toBe(kB);
    });

    it('14-entry material-shape: one differing skylight irr view id produces different keys', () => {
      const fs = makeFrameState();
      const base = Array.from({ length: 13 }, () => h());
      const hX = h();
      const setA = [...base.slice(0, 7), hX, ...base.slice(7)];
      const kA = buildBindGroupCacheKey('material', setA, fs);
      const hY = h();
      const setB = [...base.slice(0, 7), hY, ...base.slice(7)];
      const kB = buildBindGroupCacheKey('material', setB, fs);
      expect(kA).not.toBe(kB);
    });

    it('14-entry material-shape: one differing skylight pref view id produces different keys', () => {
      const fs = makeFrameState();
      const base = Array.from({ length: 13 }, () => h());
      const hX = h();
      const setA = [...base.slice(0, 9), hX, ...base.slice(9)];
      const kA = buildBindGroupCacheKey('material', setA, fs);
      const hY = h();
      const setB = [...base.slice(0, 9), hY, ...base.slice(9)];
      const kB = buildBindGroupCacheKey('material', setB, fs);
      expect(kA).not.toBe(kB);
    });

    it('14-entry material-shape: one differing skylight brdf lut view id produces different keys', () => {
      const fs = makeFrameState();
      const base = Array.from({ length: 13 }, () => h());
      const hX = h();
      const setA = [...base.slice(0, 11), hX, ...base.slice(11)];
      const kA = buildBindGroupCacheKey('material', setA, fs);
      const hY = h();
      const setB = [...base.slice(0, 11), hY, ...base.slice(11)];
      const kB = buildBindGroupCacheKey('material', setB, fs);
      expect(kA).not.toBe(kB);
    });
  });

  // ─── Skylight active vs fallback (f) AC-05 F-5 ──────────────────────────────
  //
  // Active and fallback sets share the first 7 material handles + the 3
  // sampler handles + the intensity buffer handle. The 3 skylight view
  // handles (irrView, prefView, brdfLutView) differ between states. Both
  // derivations run against the same frameState so shared handles get the
  // same ids, while differing views get new distinct ids.

  describe('buildBindGroupCacheKey', () => {
    it('skylight active handle set vs fallback handle set produces different keys (AC-05 / F-5)', () => {
      const fs = makeFrameState();

      // Shared: 7 material + 3 samplers + intensity = 11 shared handles
      const shared = Array.from({ length: 11 }, () => h());

      // Active Skylight: 3 fresh view handles (irr, pref, brdf)
      const activeSet = [
        ...shared.slice(0, 7), // material 0-6
        h(), // irrView (binding 7)
        shared[7] as object, // irrSampler (binding 8)
        h(), // prefView (binding 9)
        shared[8] as object, // prefSampler (binding 10)
        h(), // brdfView (binding 11)
        shared[9] as object, // brdfSampler (binding 12)
        shared[10] as object, // intensityBuffer (binding 13)
      ];
      const kActive = buildBindGroupCacheKey('material', activeSet, fs);

      // Fallback Skylight: 3 DIFFERENT view handles at the same slots
      const fallbackSet = [
        ...shared.slice(0, 7), // material 0-6 — same handles -> same ids
        h(), // irrView (different)
        shared[7] as object, // irrSampler (same — gets same id)
        h(), // prefView (different)
        shared[8] as object, // prefSampler (same — gets same id)
        h(), // brdfView (different)
        shared[9] as object, // brdfSampler (same — gets same id)
        shared[10] as object, // intensityBuffer (same — gets same id)
      ];
      const kFallback = buildBindGroupCacheKey('material', fallbackSet, fs);

      expect(kActive).not.toBe(kFallback);
    });
  });
}

// ─── from bind-group-cache-sentinel.test.ts ───
{
  // bind-group-cache-sentinel.test.ts -- w16 sentinel-survival unit test
  //
  // Direct unit test of cleanPerEntityCache for D-6 sentinel key survival.
  // The shadow-singleton cache keys ('shadow-material-singleton' and
  // 'shadow-instances-singleton') use non-numeric entityKey segments that
  // yield NaN from Number(...). The Number.isNaN guard in cleanPerEntityCache
  // must skip them so they survive across frames.
  //
  // This test mirrors the w9-a R-2 pattern: import the real pure-function
  // seam (cleanPerEntityCache from ../render-system-record), preset cache
  // Maps with a mix of sentinel and per-entity keys, call the function, and
  // assert survivor/eviction semantics directly.
  //
  // Mutation-test: removing the Number.isNaN(ek) guard from the production
  // function causes the sentinel-survival assertion to turn RED (sentinels
  // evicted with NaN entityKey), proving the test guards the production fix.

  // ─── helpers ────────────────────────────────────────────────────────────────

  /** Opaque-handle stub for BindGroup slots — the cache Map cares about keys, not values. */
  function stubBindGroup(): BindGroup {
    return {} as unknown as BindGroup;
  }

  // ─── tests ──────────────────────────────────────────────────────────────────

  describe('w16 — cleanPerEntityCache sentinel survival', () => {
    it('sentinel keys survive cleanPerEntityCache (Number.isNaN guard)', () => {
      // Preset a cache Map with a MIX of sentinel and per-entity keys.
      // Sentinels: 'shadow-material-singleton', 'shadow-instances-singleton'
      // (the exact string literal cache keys from the shadow pass call sites
      // at render-system-record.ts ~:1577 and ~:1597).
      //
      // Per-entity keys follow the buildBindGroupCacheKey format:
      //   ${variant}-${entityKey}-${handleIds...}
      // where variant is 'material' or 'instances', entityKey is the packed
      // entity-id-with-generation u32, and handleIds are numeric ids joined
      // by '-'. cleanPerEntityCache parses the segment between the first two
      // dashes as the entityKey.

      const cache = new Map<string, BindGroup>();
      cache.set('shadow-material-singleton', stubBindGroup());
      cache.set('shadow-instances-singleton', stubBindGroup());
      cache.set('material-123-45-67-89', stubBindGroup()); // entity 123, validated
      cache.set('material-456-11-22-33', stubBindGroup()); // entity 456, stale
      cache.set('instances-123-77-88', stubBindGroup()); // entity 123, validated
      cache.set('instances-789-99-00', stubBindGroup()); // entity 789, stale

      // Validated set: entity 123 is live, 456 and 789 are NOT.
      const validated = new Set<number>([123]);

      // Call the REAL production function (not a copy of the loop).
      cleanPerEntityCache(
        cache,
        validated,
        'material', // variant unused by cleanPerEntityCache (retained for future use)
      );

      // Assertions: sentinel keys survived.
      expect(cache.has('shadow-material-singleton')).toBe(true);
      expect(cache.has('shadow-instances-singleton')).toBe(true);

      // Validated entity key survived.
      expect(cache.has('material-123-45-67-89')).toBe(true);
      expect(cache.has('instances-123-77-88')).toBe(true);

      // Stale entity keys were evicted.
      expect(cache.has('material-456-11-22-33')).toBe(false);
      expect(cache.has('instances-789-99-00')).toBe(false);
    });

    it('sentinel keys survive even when validated set is empty', () => {
      // Edge case: all per-entity keys should be evicted (empty validated
      // set), but sentinels must survive. This models the scenario after
      // all entities are despawned — the next frame's clean-up must not
      // nuke the singletons.

      const cache = new Map<string, BindGroup>();
      cache.set('shadow-material-singleton', stubBindGroup());
      cache.set('shadow-instances-singleton', stubBindGroup());
      cache.set('material-42-1-2', stubBindGroup());
      cache.set('instances-42-3', stubBindGroup());

      const validated = new Set<number>(); // empty — no entities

      cleanPerEntityCache(cache, validated, 'material');

      // Sentinels always survive.
      expect(cache.has('shadow-material-singleton')).toBe(true);
      expect(cache.has('shadow-instances-singleton')).toBe(true);

      // Per-entity keys all evicted (none in validated set).
      expect(cache.has('material-42-1-2')).toBe(false);
      expect(cache.has('instances-42-3')).toBe(false);
    });
  });
}
