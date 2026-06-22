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
//   - §3.4 row 5: `default-shadow-caster` carries an empty paramSchema; the
//           engine-injection appendInjection(bgl=[], kind) starts at
//           binding 0 because userRegionBindingEnd=0 (chained from
//           derive([]).userRegionBindingEnd).
//
// What this test asserts:
//   (a) derive([]) produces all-empty / zero output -- the graceful path.
//   (b) The shadow_caster sidecar (packages/shader/src/shadow_caster.wgsl
//       .meta.json) declares paramSchema: [].
//   (c) appendInjection over the empty user-region starts injected
//       bindings at binding 0 (covered also in append-injection.test.ts;
//       this test pins the empty-schema path explicitly).
//   (d) The runtime registers `forgeax::default-shadow-caster` with
//       paramSchema=[] (createRenderer.ts:3172) -- structural assertion that
//       no static literal in createRenderer hardcodes a non-empty schema
//       for this identifier.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { appendInjection } from '../pbr-pipeline';

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

  it('(b) shadow_caster sidecar declares paramSchema: []', () => {
    const sidecarPath = join(repoRoot, 'packages', 'shader', 'src', 'shadow_caster.wgsl.meta.json');
    const raw = readFileSync(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw) as { paramSchema?: unknown };
    expect(Array.isArray(parsed.paramSchema)).toBe(true);
    expect((parsed.paramSchema as unknown[]).length).toBe(0);
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
    const createRendererPath = join(repoRoot, 'packages', 'runtime', 'src', 'createRenderer.ts');
    const src = readFileSync(createRendererPath, 'utf8');
    const re =
      /registerMaterialShader\(\s*shadowCasterIdentifier\s*,\s*\{[^}]*paramSchema\s*:\s*\[\s*\][^}]*\}\s*\)/s;
    expect(src).toMatch(re);
  });
});
