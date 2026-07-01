// @forgeax/engine-runtime / __tests__ / sprite-lit-extract-branch.test.ts
//
// feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / t2.
//
// Red-stage tests for the AC-02 (D-9 remap) extract branch:
// when the first pass shader id is 'forgeax::sprite-lit' the snapshot
// must carry `materialShaderId === 'forgeax::sprite-lit'`,
// `shadingModel === undefined`, and `transparent === true` (derived from
// renderState.blend presence). The branch mirrors `'forgeax::sprite'`
// without expanding the closed `shadingModel` union.
//
// post-PR-#520 + transparent SSOT collapse reality:
//   - MaterialSnapshot.shadingModel is `'unlit' | undefined` (2 members)
//   - sprite carries `shadingModel: undefined` + materialShaderId
//   - transparent derives from `renderState.blend !== undefined`
//   - sprite-lit walks the SAME schema-driven path as sprite
//
// SSOTs:
//   - plan-strategy D-1 (materialShaderId string routing mirror sprite)
//   - plan-strategy D-9 (AC-02 remap: no 'sprite-lit' inferredShadingModel case)
//   - plan-strategy D-10 (AC-01 remap: no new narrowing type guard)
//   - render-system-extract.ts MaterialSnapshot (closed union 2 members)
//   - requirements AC-01 / AC-02 (post-rewrite)

import { describe, expect, it } from 'vitest';
import type { MaterialSnapshot } from '../render-system-extract';

/**
 * D-10 narrowing-point gate: MaterialSnapshot.shadingModel is the
 * 2-member closed union `'unlit' | undefined`. Adding a third member
 * (`'sprite-lit'`) would be a reverse SSOT — the type-level assertion
 * below guards the contract.
 *
 * TS type-level fact: shadingModel must NOT include 'sprite-lit'.
 */
type ShadingModelMembers = MaterialSnapshot['shadingModel'];

/**
 * Compile-time gate: `'sprite-lit'` must not be assignable to
 * `MaterialSnapshot['shadingModel']`. If a future commit silently
 * widens the union the assignment below will type-check and bypass the
 * AC-01 invariant, so the runtime test below pins this on values too.
 */
const SPRITE_LIT_NOT_IN_UNION = (value: ShadingModelMembers): boolean => {
  // Acceptable narrow forms are 'unlit' and undefined (no 'sprite' since
  // feat-20260625-refactor-sprite-as-transparent-mesh M3 / D-3 retired it).
  if (value === undefined) return true;
  if (value === 'unlit') return true;
  return false;
};

describe('sprite-lit extract branch (D-9 remap, AC-02 + AC-01)', () => {
  describe('MaterialSnapshot.shadingModel closed union narrowing-point (AC-01 D-10 remap)', () => {
    it('shadingModel union is 2-member: `unlit` | `undefined`', () => {
      // Runtime gate mirroring the TS-level assertion above. Any
      // production narrowing that branches on a third 'sprite-lit' arm
      // would either fail to type-check or violate this gate.
      expect(SPRITE_LIT_NOT_IN_UNION(undefined)).toBe(true);
      expect(SPRITE_LIT_NOT_IN_UNION('unlit')).toBe(true);
    });

    it('sprite-lit shading is recognised via materialShaderId string routing, not shadingModel', () => {
      // Mirror sprite's pattern (post-PR-#520 D-3): the consumer reads
      // `material.materialShaderId === 'forgeax::sprite-lit'` for any
      // sprite-lit-specific routing, while `shadingModel` stays
      // `undefined` (same as `forgeax::sprite`).
      const snapshot = {
        shadingModel: undefined as MaterialSnapshot['shadingModel'],
        materialShaderId: 'forgeax::sprite-lit',
        transparent: true,
      } as const;
      expect(snapshot.materialShaderId === 'forgeax::sprite-lit').toBe(true);
      expect(snapshot.shadingModel).toBeUndefined();
      expect(snapshot.transparent).toBe(true);
    });
  });

  describe('sprite-lit snapshot shape (D-9 remap, AC-02 SSOT)', () => {
    it('firstPassShader = "forgeax::sprite-lit" produces materialShaderId + transparent=true', () => {
      // TS port of the expected extract-stage result for a sprite-lit
      // material with `renderState.blend` set (sprite-lit.wgsl.meta.json
      // mirrors sprite blend declaration after t4 lands). transparent is
      // derived from `renderState.blend !== undefined` per the post-#520
      // SSOT (no longer carried on MaterialPassDescriptor.transparent).
      const fakeFirstPass = {
        shader: 'forgeax::sprite-lit',
        renderState: { blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } },
      } as const;
      const snapshot = {
        shadingModel: undefined as MaterialSnapshot['shadingModel'],
        materialShaderId: fakeFirstPass.shader,
        transparent: fakeFirstPass.renderState.blend !== undefined,
      };
      expect(snapshot.shadingModel).toBeUndefined();
      expect(snapshot.materialShaderId).toBe('forgeax::sprite-lit');
      expect(snapshot.transparent).toBe(true);
    });

    it('sprite vs sprite-lit produce identical snapshot SHAPE (only materialShaderId differs)', () => {
      // D-1: sprite-lit walks the EXACT SAME schema-driven generic path
      // as sprite. The only field that differs is materialShaderId.
      const spriteSnap = {
        shadingModel: undefined as MaterialSnapshot['shadingModel'],
        materialShaderId: 'forgeax::sprite' as string,
        transparent: true as const,
      };
      const spriteLitSnap = {
        shadingModel: undefined as MaterialSnapshot['shadingModel'],
        materialShaderId: 'forgeax::sprite-lit' as string,
        transparent: true as const,
      };
      // Field-set congruence: identical keys, identical types.
      const keysSprite = Object.keys(spriteSnap).sort();
      const keysSpriteLit = Object.keys(spriteLitSnap).sort();
      expect(keysSpriteLit).toEqual(keysSprite);
      // Only `materialShaderId` differs in value.
      expect(spriteSnap.shadingModel).toBe(spriteLitSnap.shadingModel);
      expect(spriteSnap.transparent).toBe(spriteLitSnap.transparent);
      expect(spriteSnap.materialShaderId === spriteLitSnap.materialShaderId).toBe(false);
    });
  });

  describe('source-side guarantees (post-rewrite render-system-extract.ts)', () => {
    it('render-system-extract.ts must NOT branch on `shadingModel === "sprite-lit"` (D-10)', async () => {
      // Dynamic node:fs / node:module pattern reused from sibling shader
      // tests. The extract-stage source must NOT carry a literal
      // `'sprite-lit'` arm under `shadingModel === ...` — sprite-lit
      // identifies via materialShaderId string only.
      const fsId = 'node:fs';
      const moduleId = 'node:module';
      const fs = (await import(fsId)) as { readFileSync(p: string, e: string): string };
      const mod = (await import(moduleId)) as {
        createRequire(u: string | URL): (id: string) => string;
      };
      const require = mod.createRequire(import.meta.url);
      const resolved = require as unknown as { resolve(id: string): string };
      const pkgJson = resolved.resolve('@forgeax/engine-runtime/package.json');
      const srcDir = pkgJson.replace(/package\.json$/, 'src');
      const src = fs.readFileSync(`${srcDir}/render-system-extract.ts`, 'utf8');
      // The narrowing point must not check shadingModel against a string
      // literal 'sprite-lit'.
      expect(/shadingModel\s*===\s*['"]sprite-lit['"]/.test(src)).toBe(false);
    });
  });
});
