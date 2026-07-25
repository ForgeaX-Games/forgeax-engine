import { Camera } from '@forgeax/engine-render';
import { GlyphText, Tilemap } from '@forgeax/engine-render/authoring';

void Camera;
void GlyphText;
void Tilemap;

// The host assembly factory belongs to engine-runtime, not the render barrel.
// @ts-expect-error createRenderer is not a public render export
type _NoPublicCreateRenderer = typeof import('@forgeax/engine-render')['createRenderer'];

// Optional authoring and frame machinery must not silently re-enter the root.
// @ts-expect-error GlyphText is authoring-only
type _NoPublicGlyphText = typeof import('@forgeax/engine-render')['GlyphText'];
// @ts-expect-error Tilemap is authoring-only
type _NoPublicTilemap = typeof import('@forgeax/engine-render')['Tilemap'];
// @ts-expect-error GPU stores are package-internal
type _NoPublicGpuResourceStore = typeof import('@forgeax/engine-render')['GpuResourceStore'];
// @ts-expect-error extract stages are package-internal
type _NoPublicExtractFrame = typeof import('@forgeax/engine-render')['extractFrame'];
