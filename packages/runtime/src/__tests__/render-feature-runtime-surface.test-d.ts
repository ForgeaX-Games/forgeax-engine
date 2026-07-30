import type {
  Renderer,
  RendererOptions,
  RenderFeature,
  RenderFeatureDiagnostics,
} from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { createRenderer } from '../createRenderer';

type FrameData = {
  readonly visibleCount: number;
};

const feature = {
  identity: 'test.runtime-public-surface',
  extract({ owner }) {
    return ok<FrameData>({ visibleCount: owner });
  },
  prepare(data: FrameData) {
    const count: number = data.visibleCount;
    void count;
    return ok(undefined);
  },
  contribute(data: FrameData) {
    const count: number = data.visibleCount;
    void count;
    return ok(undefined);
  },
} satisfies RenderFeature<FrameData>;

declare const canvas: HTMLCanvasElement;

const options: RendererOptions = { features: [feature] };
const rendererPromise: Promise<Renderer> = createRenderer(canvas, options);
const diagnostics = (renderer: Renderer): readonly RenderFeatureDiagnostics[] =>
  renderer.renderFeatureDiagnostics();

void rendererPromise;
void diagnostics;

// Runtime owns assembly; its public factory does not expose the internal host.
// @ts-expect-error the feature host is private to engine-render
type _NoRuntimeFeatureHost = typeof import('@forgeax/engine-runtime')['RenderFeatureHost'];
// @ts-expect-error runtime does not expose manifest/RPC implementation symbols
type _NoRuntimeBundlerOptions = typeof import('@forgeax/engine-runtime')['BundlerOptions'];
