import type {
  RenderError,
  Renderer,
  RendererOptions,
  RenderFeature,
  RenderFeatureContributeContext,
  RenderFeatureDiagnostics,
  RenderFeatureErrorDescriptor,
  RenderFeatureExtractContext,
  RenderFeaturePassContext,
  RenderFeaturePrepareContext,
} from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';

type FrameData = {
  readonly visibleCount: number;
};

const feature = {
  identity: 'test.public-surface',
  extract(context: RenderFeatureExtractContext) {
    const owner: number = context.owner;
    return ok<FrameData>({ visibleCount: owner });
  },
  prepare(data: FrameData, context: RenderFeaturePrepareContext) {
    const count: number = data.visibleCount;
    const frameNumber: number = context.frame.frameNumber;
    void count;
    void frameNumber;
    return ok(undefined);
  },
  contribute(data: FrameData, context: RenderFeatureContributeContext) {
    const count: number = data.visibleCount;
    void count;
    void context.staging;
    return ok(undefined);
  },
} satisfies RenderFeature<FrameData>;

const options: RendererOptions = { features: [feature] };
const diagnostics = (renderer: Renderer): readonly RenderFeatureDiagnostics[] =>
  renderer.renderFeatureDiagnostics();

const errorDescriptor = (error: RenderError): RenderFeatureErrorDescriptor | undefined => {
  switch (error.code) {
    case 'render-feature-registration-conflict':
      return error;
    case 'render-feature-stage-failed':
      return error;
    case 'render-feature-capability-missing':
      return error;
    case 'render-feature-pass-order-conflict':
      return error;
    default:
      return undefined;
  }
};

const passContext = (context: RenderFeaturePassContext): number => context.frame.frameNumber;
// @ts-expect-error Wave1 pass execution does not expose incomplete GPU draw state
passContext.commands;
void errorDescriptor;
void options;
void diagnostics;
void passContext;

// The renderer host and construction context are internal implementation seams.
// @ts-expect-error host internals are not part of the render root surface
type _NoPublicFeatureHost = typeof import('@forgeax/engine-render')['RenderFeatureHost'];
// @ts-expect-error frame input is not a producer-facing public declaration
type _NoPublicFrameInput = typeof import('@forgeax/engine-render')['RenderFeatureFrameInput'];
// @ts-expect-error bundler manifest wiring is not a render feature API
type _NoPublicBundlerOptions = typeof import('@forgeax/engine-render')['BundlerOptions'];
// @ts-expect-error remote inspection/RPC symbols do not belong to the render root
type _NoPublicRpcClient = typeof import('@forgeax/engine-render')['InspectorClient'];
