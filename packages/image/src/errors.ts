import type { ImageError, ImageErrorCode, ImageErrorDetail } from '@forgeax/engine-types';
import { IMAGE_ERROR_HINTS } from '@forgeax/engine-types';

// Per-code .expected string literals SSOT.
// Mirrors ASSET_ERROR_HINTS / IMAGE_ERROR_HINTS shape (charter P5 consistent
// abstraction). AI users surface .expected when a structured error needs to
// describe the precondition that was violated.
const IMAGE_ERROR_EXPECTED: Readonly<Record<ImageErrorCode, string>> = {
  'image-decode-failed': 'PNG / JPG byte stream decodes successfully',
  'image-format-unsupported':
    "mime is one of ['image/png', 'image/jpeg']; uploadTexture format <-> colorSpace family agrees",
  'image-dimension-out-of-bounds':
    'width and height fall under device caps maxTextureDimension2D (or 16384 hard cap)',
  'image-meta-missing':
    "<source>.meta.json sidecar (importer: 'image') exists in the same directory",
  'image-hdr-decode-failed': 'Radiance RGBE header is valid and pixel data decodes successfully',
  // feat-20260521-sprite-atlas-animation M1 T-03 — vite-plugin-image atlas
  // hook .expected literals (plan-strategy section 2 D-2 + AC-10 a/b/c).
  // ImageErrorImpl construction path is unchanged: the new atlas-* errors
  // flow through `new ImageErrorImpl({ code: 'atlas-...', ...detail })` and
  // pick the .expected string up from this Record at construction time
  // (charter P3 explicit failure SSOT — AI users surface .expected next to
  // .hint after switch (err.code) without parsing the message).
  'atlas-empty-input': 'images.length >= 1',
  'atlas-size-exceeded':
    'image width x height <= maxAtlasSize^2 and each image fits in the atlas footprint',
  'atlas-region-mismatch': 'sum(regions[i].w x regions[i].h) <= atlasWidth x atlasHeight',
};

/**
 * Runtime ImageError class -- 4-field surface (.code / .expected / .hint /
 * .detail) parallel to RhiError + AssetError + MetricError (charter P5
 * consistent abstraction; AGENTS.md "Errors are structured. Return Result,
 * never throw for expected failures.").
 *
 * The class implements the `ImageError` interface from
 * `@forgeax/engine-types` (T-M2-04 SSOT). AI users perform a single
 * `switch (err.code)` over the 4 ImageErrorCode members and pick up
 * `err.detail.<per-code-field>` with full IDE autocomplete (charter P3
 * machine-readable union > prose; T-M2-04 ImageErrorDetail discriminated
 * union narrows `.detail` per `.code`).
 */
export class ImageErrorImpl extends Error implements ImageError {
  readonly code: ImageErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: ImageErrorDetail;

  constructor(detail: ImageErrorDetail) {
    const code = detail.code;
    const expected = IMAGE_ERROR_EXPECTED[code];
    const hint = IMAGE_ERROR_HINTS[code];
    super(`[ImageError ${code}] expected: ${expected}; hint: ${hint}`);
    this.name = 'ImageError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

/**
 * Construct a structured ImageError from a discriminated detail variant.
 * Producer call sites pass the typed detail directly so the `.code` field
 * narrows ImageErrorDetail to the matching variant (charter P4 explicit
 * failure: TypeScript guards completeness at construction time).
 */
export function imageError(detail: ImageErrorDetail): ImageError {
  return new ImageErrorImpl(detail);
}

export { IMAGE_ERROR_EXPECTED };
