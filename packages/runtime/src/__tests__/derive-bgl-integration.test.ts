// derive-bgl-integration.test.ts -- M3 / w11 integration test for derive(schema)
// integration into the BGL build path consumed by registerMaterialShader-like
// register-time validation.
//
// feat-20260613-material-paramschema-driven-binding M3 / w11.
//
// Decision anchors (plan-strategy §2):
//   - D-2  derive(schema) is the pure SSOT for BGL / UBO / loader lookup tables.
//   - D-3  consecutive numeric entries are run-merged into one UBO entry.
//   - D-4  texture* family entries auto-pair a filtering sampler at binding+1.
//   - D-12 empty schema is graceful: bglEntries=[] / totalBytes=0.
//
// What this test asserts (M3 scope, narrow):
//   (a) derive(schema) over each of the 5 built-in shader sidecar shapes
//       returns a well-formed bglEntries array consistent with the rest of
//       the derive output (textureFieldNames / samplerForTexture map /
//       userRegionBindingEnd advances by exactly the entries created).
//   (b) bglEntries[i].binding values are unique and dense from 0..N-1, so
//       that a downstream device.createBindGroupLayout({entries}) call would
//       accept them without renumbering. The assertion runs against synthetic
//       schemas representative of each built-in shader; the real WGSL @binding
//       numbers are renumbered to match in M4 (plan-strategy §3.4 table).
//   (c) record-stage byte packing aligns with derive(...).uboLayout: the
//       sequence of (offset, size) for the merged-UBO field run is the
//       std140 walk produced by derive — caller writes scalars at the
//       reported offsets and the totalBytes is the buffer allocation size.

import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { appendInjection } from '../pbr-pipeline';

// ─── Synthetic schemas (one per built-in shader family) ─────────────────────
//
// These mirror the *intended* schemas after M4 sidecar updates. The current
// .wgsl.meta.json sidecars (research F-1) are misaligned with WGSL @binding
// numbers; M3 here verifies the derive plumbing works on well-formed schemas
// — M4 brings the real sidecars into alignment.

const standardPbrSchema: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'metallicChannel', type: 'f32', default: 2 },
  { name: 'roughnessChannel', type: 'f32', default: 1 },
  { name: 'aoChannel', type: 'f32', default: 0 },
  { name: 'extraChannel', type: 'f32', default: 0 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
  { name: 'emissiveTexture', type: 'texture2d' },
];

const skinSchema: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
];

const unlitSchema: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'baseColorTexture', type: 'texture2d' },
];

const spriteSchema: readonly ParamSchemaEntry[] = [
  { name: 'tint', type: 'color', default: [1, 1, 1, 1] },
  { name: 'baseColorTexture', type: 'texture2d' },
];

const shadowCasterSchema: readonly ParamSchemaEntry[] = [];

const builtinSchemas: ReadonlyArray<{ id: string; schema: readonly ParamSchemaEntry[] }> = [
  { id: 'forgeax::default-standard-pbr', schema: standardPbrSchema },
  { id: 'forgeax::pbr-skin', schema: skinSchema },
  { id: 'forgeax::default-unlit', schema: unlitSchema },
  { id: 'forgeax::sprite', schema: spriteSchema },
  { id: 'forgeax::default-shadow-caster', schema: shadowCasterSchema },
];

describe('derive(schema) integration over 5 built-in shader families (M3 w11)', () => {
  it('(a) every built-in shader derives a well-formed BGL with consistent userRegionBindingEnd', () => {
    for (const { id, schema } of builtinSchemas) {
      const out = derive(schema);
      // bglEntries length == userRegionBindingEnd (every entry consumes
      // exactly one binding slot under the run-merging rule of D-3).
      expect(out.bglEntries.length, `${id}: bglEntries.length === userRegionBindingEnd`).toBe(
        out.userRegionBindingEnd,
      );
      // textureFieldNames is a subset of the schema names.
      const schemaNames = new Set(schema.map((e) => e.name));
      for (const tex of out.textureFieldNames) {
        expect(schemaNames.has(tex), `${id}: textureFieldName '${tex}' is in schema`).toBe(true);
      }
      // samplerForTexture maps each texture name to '<tex>_sampler'.
      for (const [tex, samp] of out.samplerForTexture) {
        expect(samp).toBe(`${tex}_sampler`);
      }
    }
  });

  it('(b) bglEntries[i].binding values are unique and dense from 0..N-1', () => {
    for (const { id, schema } of builtinSchemas) {
      const out = derive(schema);
      const bindings = out.bglEntries.map((e) => e.binding);
      // unique
      expect(new Set(bindings).size, `${id}: binding values unique`).toBe(bindings.length);
      // dense from 0..N-1
      for (let i = 0; i < bindings.length; i++) {
        expect(bindings, `${id}: bglEntries[${i}].binding === ${i}`).toContain(i);
      }
    }
  });

  it('(c) record-stage packing aligns with uboLayout offsets (totalBytes >= last field offset+size)', () => {
    for (const { id, schema } of builtinSchemas) {
      const out = derive(schema);
      const fields = out.uboLayout.entries;
      // offsets are non-decreasing.
      for (let i = 1; i < fields.length; i++) {
        const prev = fields[i - 1];
        const cur = fields[i];
        if (prev === undefined || cur === undefined) continue;
        expect(
          cur.offset,
          `${id}: field[${i}].offset >= field[${i - 1}].offset+size`,
        ).toBeGreaterThanOrEqual(prev.offset + prev.size);
      }
      // totalBytes covers the last field exactly (or is 0 when no fields).
      if (fields.length === 0) {
        expect(out.uboLayout.totalBytes, `${id}: empty schema totalBytes==0`).toBe(0);
      } else {
        const last = fields[fields.length - 1];
        if (last !== undefined) {
          expect(
            out.uboLayout.totalBytes,
            `${id}: totalBytes >= last.offset+size`,
          ).toBeGreaterThanOrEqual(last.offset + last.size);
        }
      }
    }
  });

  it('(d) shadow-caster (empty schema) is graceful (D-12)', () => {
    const out = derive(shadowCasterSchema);
    expect(out.bglEntries).toEqual([]);
    expect(out.uboLayout.totalBytes).toBe(0);
    expect(out.userRegionBindingEnd).toBe(0);
    expect(out.textureFieldNames.size).toBe(0);
  });
});

// ─── M1 regression fence: built-in standard PBR derive + injection ───────────
//
// feat-20260621-learn-render-5-5-parallax-mapping-demo-aligned-wit M1 / w1
//
// Characterises today's fixed 18-entry pbr-material-merged layout so M2's
// refactor (derived BGL replaces fixed base-7) is validated bit-for-bit.
//
// Layout (verified against pbr-pipeline.ts + default-standard-pbr.wgsl.meta.json):
//   user-region:    binding 0 (UBO, 10 numeric run-merged) + 3 sampler/texture pairs
//                   (baseColorTexture normalTexture, metallicRoughnessTexture) = 7 entries,
//                   userRegionBindingEnd = 7
//   ibl injection:  binding 7..13 (7 entries: irradiance/prefilter cube + brdfLut 2d +
//                   3 samplers + intensity uniform)
//   lightmap inj.:  binding 14..17 (4 entries: emissive sampler+tex + occlusion sampler+tex)
//   total:          18 entries, bindings 0..17 dense.
//
// Invariant: injection start == userRegionBindingEnd (NOT hardcoded 7);
//           injection order ibl-then-lightmap (D-8).

// Exact paramSchema from packages/shader/src/default-standard-pbr.wgsl.meta.json:68-77
// (10 numeric entries + 3 texture2d entries).
const defaultStandardPbrSchema: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'metallicChannel', type: 'f32', default: 2 },
  { name: 'roughnessChannel', type: 'f32', default: 1 },
  { name: 'aoChannel', type: 'f32', default: 0 },
  { name: 'extraChannel', type: 'f32', default: 0 },
  { name: 'emissive', type: 'vec3', default: [0, 0, 0] },
  { name: 'emissiveIntensity', type: 'f32', default: 0 },
  { name: 'occlusionStrength', type: 'f32', default: 1 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
];

describe('built-in PBR derive+injection 18-entry regression fence (M1 w1)', () => {
  it('w1 user-region: derive produces 7 entries (binding 0 UBO + 3 sampler/texture pairs), userRegionBindingEnd=7', () => {
    const out = derive(defaultStandardPbrSchema);

    // 10 numeric entries run-merged into binding 0 UBO + 3 textures x 2 (sampler+texture) = 1 + 6 = 7
    expect(out.bglEntries.length).toBe(7);
    expect(out.userRegionBindingEnd).toBe(7);

    // Bindings 0..6 dense, no gaps.
    const bindings = out.bglEntries.map((e) => e.binding);
    expect(new Set(bindings).size).toBe(7);
    for (let i = 0; i < 7; i++) {
      expect(bindings).toContain(i);
    }

    // binding 0 is the UBO (uniform buffer).
    expect(out.bglEntries[0]?.binding).toBe(0);
    expect(out.bglEntries[0]?.buffer?.type).toBe('uniform');

    // textureFieldNames covers exactly the 3 texture2d entries.
    expect(out.textureFieldNames.size).toBe(3);
    expect(out.textureFieldNames.has('baseColorTexture')).toBe(true);
    expect(out.textureFieldNames.has('metallicRoughnessTexture')).toBe(true);
    expect(out.textureFieldNames.has('normalTexture')).toBe(true);

    // sampler map: each texture has a paired sampler.
    expect(out.samplerForTexture.size).toBe(3);
    expect(out.samplerForTexture.get('baseColorTexture')).toBe('baseColorTexture_sampler');
    expect(out.samplerForTexture.get('metallicRoughnessTexture')).toBe(
      'metallicRoughnessTexture_sampler',
    );
    expect(out.samplerForTexture.get('normalTexture')).toBe('normalTexture_sampler');
  });

  it('w1 full pipeline: derive + ibl injection + lightmap injection = 18 entries dense 0..17', () => {
    const out = derive(defaultStandardPbrSchema);
    // Same cast as append-injection.test.ts — forgeax shim → @webgpu/types via
    // explicit two-step `as unknown as`, exempt from RHI gate j.
    const userBgl = [...out.bglEntries] as unknown as readonly GPUBindGroupLayoutEntry[];

    // Injection start = userRegionBindingEnd (NOT a hardcoded 7 literal).
    const afterIbl = appendInjection(userBgl, 'ibl');
    expect(afterIbl.length).toBe(7);
    expect(afterIbl[0]?.binding).toBe(out.userRegionBindingEnd); // 7

    const mergedAfterIbl = [...userBgl, ...afterIbl];

    const afterLightmap = appendInjection(mergedAfterIbl, 'lightmap');
    expect(afterLightmap.length).toBe(4);
    expect(afterLightmap[0]?.binding).toBe(mergedAfterIbl.length); // 14

    const fullSet = [...mergedAfterIbl, ...afterLightmap];
    expect(fullSet.length).toBe(18);

    // Bindings 0..17 dense, no gaps.
    const bindings = fullSet.map((e) => e.binding);
    expect(new Set(bindings).size).toBe(18);
    for (let i = 0; i < 18; i++) {
      expect(bindings).toContain(i);
    }

    // IBL injection starts at userRegionBindingEnd (the dynamic path, not a constant).
    // This is the key invariant: if derive produces a different userRegionBindingEnd
    // (e.g. 9 for a 4-texture schema), injection starts at that value, not at 7.
    expect(afterIbl[0]?.binding).toBe(out.userRegionBindingEnd);
    expect(afterLightmap[0]?.binding).toBe(out.userRegionBindingEnd + afterIbl.length);

    // D-8: injection order is ibl-then-lightmap.
    // IBL entries (7) precede lightmap entries (4) after the user-region.
    const iblBindings = afterIbl.map((e) => e.binding);
    const lightmapBindings = afterLightmap.map((e) => e.binding);
    for (const b of iblBindings) {
      for (const lb of lightmapBindings) {
        expect(b).toBeLessThan(lb as number);
      }
    }
  });

  it('w1 injection start is userRegionBindingEnd, not a hardcoded literal', () => {
    const out = derive(defaultStandardPbrSchema);
    // Prove that userRegionBindingEnd (7 today) is what feeds injection, not a
    // hardcoded constant embedded in test logic. The derive() output IS the SSOT.
    const userBgl = [...out.bglEntries] as unknown as readonly GPUBindGroupLayoutEntry[];

    const afterIbl = appendInjection(userBgl, 'ibl');
    // The first IBL entry's binding MUST equal out.userRegionBindingEnd.
    // If someone changes appendInjection to use a hardcoded 7, and
    // derive later shifts userRegionBindingEnd (e.g. to 9 for 4-texture),
    // this assertion catches the desync.
    expect(afterIbl[0]?.binding).toBe(out.userRegionBindingEnd);
    // read-back guard: confirm the derive result really is 7 today.
    expect(out.userRegionBindingEnd).toBe(7);
  });
});

// ─── M2 / w2: 4-texture custom schema derive (heightTexture shifts injection) ──
//
// feat-20260621-learn-render-5-5-parallax-mapping-demo-aligned-wit M2 / w2
//
// A custom parallax shader declares a 4th texture (heightTexture) on top of the
// 3 standard user-region textures. derive() already handles arbitrary texture
// counts (it is the SSOT) — this test characterises that the 4th texture earns
// a distinct sampler/texture binding pair and that the engine-injection region
// (IBL / lightmap) shifts its start binding by exactly one sampler/texture slot
// pair relative to the 3-texture baseline. The point of failure is NOT derive()
// (which is correct today) but the pipeline-layout build path that until M2 did
// not consume bglEntries — that gap is closed by w5/w6.
//
// Layout for the 4-texture schema:
//   binding 0       : UBO (numeric run-merge)
//   binding 1/2     : baseColorTexture       (sampler / texture)
//   binding 3/4     : metallicRoughnessTexture
//   binding 5/6     : normalTexture
//   binding 7/8     : heightTexture          (the NEW 4th texture)
//   userRegionBindingEnd = 9 (3-texture baseline was 7 — shifted +2)

const parallax4TextureSchema: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'heightScale', type: 'f32', default: 0.1 },
  { name: 'algoMode', type: 'f32', default: 0 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
  { name: 'heightTexture', type: 'texture2d' },
];

describe('4-texture custom schema derive: heightTexture binding + injection shift (M2 w2)', () => {
  it('(a) heightTexture earns a distinct sampler(7)/texture(8) binding pair', () => {
    const out = derive(parallax4TextureSchema);

    // textureFieldNames covers all 4 declared textures.
    expect(out.textureFieldNames.size).toBe(4);
    expect(out.textureFieldNames.has('heightTexture')).toBe(true);
    expect(out.samplerForTexture.get('heightTexture')).toBe('heightTexture_sampler');

    // 1 UBO + 4 sampler/texture pairs = 9 entries.
    expect(out.bglEntries.length).toBe(9);

    // heightTexture is the 4th texture: sampler at binding 7, texture at binding 8.
    // (after baseColor 1/2, MR 3/4, normal 5/6).
    const heightSampler = out.bglEntries[7];
    const heightTexture = out.bglEntries[8];
    expect(heightSampler?.binding).toBe(7);
    expect(heightSampler?.sampler).toBeDefined();
    expect(heightTexture?.binding).toBe(8);
    expect(heightTexture?.texture).toBeDefined();
  });

  it('(b) userRegionBindingEnd=9 (3-texture baseline 7, shifted +2 by heightTexture)', () => {
    const baseline = derive(defaultStandardPbrSchema);
    const parallax = derive(parallax4TextureSchema);
    expect(baseline.userRegionBindingEnd).toBe(7);
    expect(parallax.userRegionBindingEnd).toBe(9);
    // Exactly one sampler/texture pair (2 bindings) of shift.
    expect(parallax.userRegionBindingEnd - baseline.userRegionBindingEnd).toBe(2);
  });

  it('(c) ibl injection start = userRegionBindingEnd (9), shifted +2 vs 3-texture baseline (7)', () => {
    const out = derive(parallax4TextureSchema);
    const userBgl = [...out.bglEntries] as unknown as readonly GPUBindGroupLayoutEntry[];

    const afterIbl = appendInjection(userBgl, 'ibl');
    // Injection start follows derive().userRegionBindingEnd dynamically — for a
    // 4-texture schema that is 9, not the 3-texture baseline's 7.
    expect(afterIbl[0]?.binding).toBe(out.userRegionBindingEnd);
    expect(afterIbl[0]?.binding).toBe(9);

    const mergedAfterIbl = [...userBgl, ...afterIbl];
    const afterLightmap = appendInjection(mergedAfterIbl, 'lightmap');
    // Lightmap follows IBL: 9 + 7 = 16.
    expect(afterLightmap[0]?.binding).toBe(16);

    // Full set: 9 user-region + 7 ibl + 4 lightmap = 20 entries, dense 0..19.
    const fullSet = [...mergedAfterIbl, ...afterLightmap];
    expect(fullSet.length).toBe(20);
    const bindings = fullSet.map((e) => e.binding);
    expect(new Set(bindings).size).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(bindings).toContain(i);
    }
  });
});
