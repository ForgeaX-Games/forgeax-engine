// feat-20260612-hdrp-deferred-shading-learn-render-5-8 M3 / w14
// Materials.standard multi-pass literal grep — TDD red-phase.
//
// Tests that Materials.standard() produces a MaterialAsset whose passes[]
// array includes three ShaderPass entries:
//   1. passKind='deferred' — opaque g-buffer write (fs_gbuffer entry)
//   2. passKind='forward' — transparent cluster-forward (fs_main entry)
//   3. passKind='shadow-caster' — depth-only shadow map write
//
// Also validates:
//   - Materials.unlit() stays forward-only (no deferred pass)
//   - castShadow=false suppresses the shadow-caster pass
//   - Default material has correct shader references for each pass
//
// AcceptanceCheck: pnpm test:unit -t 'material.*pass.*deferred|material.*multi.*pass'
// Grep gate: passKind:'deferred' / passKind:'forward' / passKind:'shadow-caster'
//   each hit >=1 in packages/runtime/src/materials.ts

import type { PassKind } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Materials } from '../materials';

describe('Materials.standard multi-pass (w14)', () => {
  describe('deferred pass', () => {
    it('includes a passKind=deferred pass', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const deferredPass = mat.passes?.find((p) => p.passKind === ('deferred' as PassKind));
      expect(deferredPass).toBeDefined();
    });

    it('deferred pass uses forgeax::default-standard-pbr shader', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const deferredPass = mat.passes?.find((p) => p.passKind === ('deferred' as PassKind));
      expect(deferredPass?.shader).toBe('forgeax::default-standard-pbr');
    });

    it('deferred pass fragment entry is fs_gbuffer', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const deferredPass = mat.passes?.find((p) => p.passKind === ('deferred' as PassKind));
      expect(deferredPass?.fragmentEntry).toBe('fs_gbuffer');
    });
  });

  describe('forward pass', () => {
    it('includes a passKind=forward pass', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const forwardPass = mat.passes?.find((p) => p.passKind === ('forward' as PassKind));
      expect(forwardPass).toBeDefined();
    });

    it('forward pass uses forgeax::default-standard-pbr shader', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const forwardPass = mat.passes?.find((p) => p.passKind === ('forward' as PassKind));
      expect(forwardPass?.shader).toBe('forgeax::default-standard-pbr');
    });

    it('forward pass fragment entry is fs_main', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const forwardPass = mat.passes?.find((p) => p.passKind === ('forward' as PassKind));
      expect(forwardPass?.fragmentEntry).toBe('fs_main');
    });
  });

  describe('shadow-caster pass', () => {
    it('includes a passKind=shadow-caster pass by default', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const shadowPass = mat.passes?.find((p) => p.passKind === ('shadow-caster' as PassKind));
      expect(shadowPass).toBeDefined();
    });

    it('shadow-caster pass uses forgeax::default-shadow-caster shader', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      const shadowPass = mat.passes?.find((p) => p.passKind === ('shadow-caster' as PassKind));
      expect(shadowPass?.shader).toBe('forgeax::default-shadow-caster');
    });

    it('castShadow=false suppresses the shadow-caster pass', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1], castShadow: false });
      const shadowPass = mat.passes?.find((p) => p.passKind === ('shadow-caster' as PassKind));
      expect(shadowPass).toBeUndefined();
    });
  });

  describe('pass count', () => {
    it('standard material has 3 passes (deferred + forward + shadow-caster)', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      expect(mat.passes).toHaveLength(3);
    });

    it('standard material with castShadow=false has 2 passes', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1], castShadow: false });
      expect(mat.passes).toHaveLength(2);
    });
  });

  describe('PBR properties preserved', () => {
    it('paramValues includes metallic and roughness defaults', () => {
      const mat = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
      expect(mat.paramValues?.metallic).toBe(0);
      expect(mat.paramValues?.roughness).toBe(0.5);
    });

    it('paramValues includes optional emissive/occlusion', () => {
      const mat = Materials.standard({
        baseColor: [0.5, 0.5, 0.5, 1],
        emissive: [0.1, 0.2, 0.3],
        emissiveIntensity: 2,
        baseColorTexture: 42,
        occlusionTexture: 84,
        occlusionStrength: 0.75,
      });
      expect(mat.paramValues?.emissive).toEqual([0.1, 0.2, 0.3]);
      expect(mat.paramValues?.emissiveIntensity).toBe(2);
      expect(mat.paramValues?.baseColorTexture).toBe(42);
      expect(mat.paramValues?.occlusionTexture).toBe(84);
      expect(mat.paramValues?.occlusionStrength).toBe(0.75);
    });
  });
});

describe('Materials.unlit forward-only (w14)', () => {
  it('unlit material has no deferred pass', () => {
    const mat = Materials.unlit([1, 1, 1, 1]);
    const deferredPass = mat.passes?.find((p) => p.passKind === ('deferred' as PassKind));
    expect(deferredPass).toBeUndefined();
  });

  it('unlit material has a forward pass', () => {
    const mat = Materials.unlit([1, 1, 1, 1]);
    const forwardPass = mat.passes?.find((p) => p.passKind === ('forward' as PassKind));
    expect(forwardPass).toBeDefined();
    expect(forwardPass?.shader).toBe('forgeax::default-unlit');
  });

  it('unlit material includes shadow-caster by default', () => {
    const mat = Materials.unlit([1, 1, 1, 1]);
    const shadowPass = mat.passes?.find((p) => p.passKind === ('shadow-caster' as PassKind));
    expect(shadowPass).toBeDefined();
  });
});
