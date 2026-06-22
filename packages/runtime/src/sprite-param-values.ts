/**
 * Type-only helper mirroring the `forgeax::sprite` shader's paramSchema
 * (sprite.wgsl.meta.json). Field set is 1:1 with paramSchema entries; field
 * order matches schema order so the std140 UBO layout (slot 0..3 = colorTint
 * / region / pivotAndSize / slicesAndMode) reads top-to-bottom.
 *
 * AI-user discoverability: annotate a sprite material's `paramValues`
 * literal as `SpriteParamValues` to get autocomplete on `slices`,
 * `sliceMode`, etc. Without the annotation the literal binds to
 * `MaterialAsset.paramValues: Record<string, unknown>` and field
 * autocomplete is unavailable.
 *
 * Required fields:
 * - `texture`: AssetGuid string of a registered TextureAsset
 *
 * Optional 9-slice fields (omit / leave at `[0,0,0,0]` for legacy single-quad
 * path):
 * - `slices`: `[left, top, right, bottom]` border widths in UV (0..1) on the
 *   source texture region. Sum of opposite borders must be < 1 (left+right
 *   < region width, top+bottom < region height); register-time validation
 *   surfaces structured `AssetError` for `[NaN]`, infinite, negative,
 *   length-mismatch, or sum-exceed cases.
 * - `sliceMode`: `0` stretch (mid-band stretches with the entity's scale,
 *   default), `1` tile (mid-band tiles via sampler `addressMode='repeat'`).
 *   Numeric literal — the shader UBO encodes mode as `slicesAndMode.w`
 *   sign (D-3 sentinel: `.w < 0` ⇒ tile).
 *
 * Composes with {@link SpriteRegionOverride}: when both are present, the
 * `slices` are interpreted relative to the per-entity `region` override
 * (AC-14), not the material's `paramValues.region`.
 *
 * Sibling type, not a sibling asset kind: `MaterialAsset` is the only
 * material asset shape; using `SpriteParamValues` as an annotation does
 * not branch the closed `AssetUnion` (plan-strategy §D-1).
 */
export type SpriteParamValues = {
  baseColor?: readonly [number, number, number, number];
  texture: string;
  sampler?: string | null;
  region?: readonly [number, number, number, number];
  pivot?: readonly [number, number];
  slices?: readonly [number, number, number, number];
  sliceMode?: 0 | 1;
  flipX?: 0 | 1;
  flipY?: 0 | 1;
};
