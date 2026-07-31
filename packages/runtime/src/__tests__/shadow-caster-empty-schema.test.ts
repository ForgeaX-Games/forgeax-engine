// @ts-nocheck — node:fs / node:path / node:url imports outside @types/node
// coverage in runtime tsconfig (mirrors pipeline.unit.test.ts header).
// shadow-caster-empty-schema.test.ts -- M4 / w21 explicit empty-schema gate.
//
// feat-20260613-material-paramschema-driven-binding M4 / w21.
//
// Decision anchors (plan-strategy §2 + §3.4):
//   - D-12  empty schema is graceful: derive([]) -> bglEntries=[],
//           totalBytes=0, textureFieldNames=empty, samplerForTexture=empty,
//           userRegionBindingEnd=0. The shadow_caster shader has zero
//           @group(1) bindings and registers under an empty paramSchema.
//   - the shadow-caster module has no authored material parameter sidecar;
//           its empty MaterialAsset parameter list is derived at runtime.
//
// What this test asserts:
//   (a) derive([]) produces all-empty / zero output -- the graceful path.
//   (b) The shadow_caster source is present without a sidecar schema.
//   (c) appendInjection over the empty user-region starts injected
//       bindings at binding 0 (covered also in append-injection.test.ts;
//       this test pins the empty-schema path explicitly).
//   (d) The runtime registers `forgeax::default-shadow-caster` with
//       paramSchema=[] (createRenderer.ts:3172) -- structural assertion that
//       no static literal in createRenderer hardcodes a non-empty schema
//       for this identifier.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendInjection } from '@forgeax/engine-render/internal';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const repoRoot = (() => {
  // packages/runtime/src/__tests__/<this file>.ts -> repo root
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', '..');
})();

describe('shadow_caster empty schema (M4 w21)', () => {
  it('(a) derive([]) returns all-empty/zero output (D-12 graceful path)', () => {
    const out = derive([]);
    expect(out.bglEntries.length).toBe(0);
    expect(out.uboLayout.entries.length).toBe(0);
    expect(out.uboLayout.totalBytes).toBe(0);
    expect(out.textureFieldNames.size).toBe(0);
    expect(out.samplerForTexture.size).toBe(0);
    expect(out.userRegionBindingEnd).toBe(0);
  });

  it('(b) shadow_caster has no material sidecar', () => {
    const sourcePath = join(repoRoot, 'packages', 'shader', 'src', 'shadow_caster.wgsl');
    expect(readFileSync(sourcePath, 'utf8')).toContain('shadow_caster.wgsl');
    expect(existsSync(`${sourcePath}.meta.json`)).toBe(false);
  });

  it('(c) appendInjection on empty user-region starts at binding 0', () => {
    const out = derive([]);
    // derive returns the forgeax-shim BindGroupLayoutEntry (?: undefined);
    // appendInjection consumes @webgpu/types GPUBindGroupLayoutEntry. Use
    // the explicit two-step `as unknown as` cast (RHI gate j exempts this
    // form as an opt-in to a known-unsafe assertion — same pattern as
    // builtin-shader-register-e2e.test.ts).
    const userBgl = [...out.bglEntries] as unknown as readonly GPUBindGroupLayoutEntry[];
    const injected = appendInjection(userBgl, 'shadow');
    expect(injected.length).toBeGreaterThan(0);
    expect(injected[0]?.binding).toBe(0);
  });

  it('(d) shadow_caster register call site carries paramSchema: []', () => {
    const createRendererPath = join(
      repoRoot,
      'packages',
      'render',
      'src',
      'renderer',
      'renderer-factory.ts',
    );
    const src = readFileSync(createRendererPath, 'utf8');
    const re =
      /installMaterialArtifact\(\s*shadowCasterIdentifier\s*,\s*\{[^}]*paramSchema\s*:\s*\[\s*\][^}]*\}\s*\)/s;
    expect(src).toMatch(re);
  });
});
