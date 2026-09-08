import type {
  FrameObservationRequest,
  FrameReceipt,
  RendererState,
  RenderFrameInput,
  RenderInspection,
  RenderWorldLease,
} from '@forgeax/engine-render';
import { Camera, type Tonemap, visibilityStateFromU32 } from '@forgeax/engine-render';
import { GlyphText, Tilemap } from '@forgeax/engine-render/authoring';

void Camera;
void visibilityStateFromU32(0);
void GlyphText;
void Tilemap;

const publicToneModes: readonly Tonemap[] = [
  'none',
  'reinhard-extended',
  'linear',
  'reinhard',
  'cineon',
  'aces-filmic',
  'agx',
  'neutral',
];
void publicToneModes;

// M6 red snapshot: the public frame contract is receipt-bound and lease-bound.
declare const lease: RenderWorldLease;
declare const receipt: FrameReceipt;
declare const request: FrameObservationRequest;
const drawRequest: RenderFrameInput = {
  leases: [lease],
  camera: { lease },
  environment: { lease },
};
void receipt;
void request;
void drawRequest;
const alive: RendererState = 'alive';
void alive;

declare const inspection: RenderInspection;
const backendKind: RenderInspection['capabilities']['backendKind'] =
  inspection.capabilities.backendKind;
void backendKind;

// M6 red snapshot: the root must expose the four target concepts without
// reopening the old renderer/device/store/readback surface.
type _RootKeys = keyof typeof import('@forgeax/engine-render');
type _RendererLegacyKeys = Extract<
  keyof import('../render-contract').Renderer,
  | 'ready'
  | 'onError'
  | 'device'
  | 'store'
  | 'readPixels'
  | 'observeCurrentFrame'
  | 'installRenderFeature'
  | 'uninstallRenderFeature'
>;
const noLegacyRendererKeys: never = null as unknown as _RendererLegacyKeys;
void noLegacyRendererKeys;
type _ForbiddenRootKeys = Extract<
  _RootKeys,
  | 'RendererCreateOptions'
  | 'RendererBackend'
  | 'RendererError'
  | 'FrameObservation'
  | 'FrameObservationOptions'
  | 'TONEMAP_POST_PROCESS_ID'
>;
const noBroadLegacyRoot: never = null as unknown as _ForbiddenRootKeys;
void noBroadLegacyRoot;

type _ForbiddenRendererIdentity = Extract<
  keyof import('../render-contract').Renderer,
  'projectionLedger' | 'registerPipeline' | 'installPipeline' | 'postProcess' | 'debugReadback'
>;
const noLegacyRendererIdentity: never = null as unknown as _ForbiddenRendererIdentity;
void noLegacyRendererIdentity;

// The host assembly factory belongs to engine-runtime, not the render barrel.
// @ts-expect-error createRenderer is not a public render export
type _NoPublicCreateRenderer = typeof import('@forgeax/engine-render')['createRenderer'];

// Optional authoring and frame machinery must not silently re-enter the root.
// @ts-expect-error GlyphText is authoring-only
type _NoPublicGlyphText = typeof import('@forgeax/engine-render')['GlyphText'];
// @ts-expect-error Tilemap is authoring-only
type _NoPublicTilemap = typeof import('@forgeax/engine-render')['Tilemap'];
// @ts-expect-error extract stages are package-internal
type _NoPublicExtractFrame = typeof import('@forgeax/engine-render')['extractFrame'];
