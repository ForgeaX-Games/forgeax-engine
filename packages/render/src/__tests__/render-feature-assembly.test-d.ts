import { ok } from '@forgeax/engine-types';
import type { RenderFeature } from '../features/types';
import type { RendererOptions } from '../renderer';

type BoundsFrame = {
  readonly visibleCount: number;
};

type OverlayFrame = {
  readonly layer: 'overlay';
};

const boundsFeature = {
  identity: 'test.bounds',
  extract({ owner }) {
    return ok({ visibleCount: owner });
  },
  prepare(data: BoundsFrame) {
    const count: number = data.visibleCount;
    void count;
    return ok(undefined);
  },
  contribute(data: BoundsFrame) {
    const count: number = data.visibleCount;
    void count;
    return ok(undefined);
  },
} satisfies RenderFeature<BoundsFrame>;

const overlayFeature = {
  identity: 'test.overlay',
  extract() {
    return ok({ layer: 'overlay' as const });
  },
  prepare(data: OverlayFrame) {
    const layer: 'overlay' = data.layer;
    void layer;
    return ok(undefined);
  },
  contribute(data: OverlayFrame) {
    const layer: 'overlay' = data.layer;
    void layer;
    return ok(undefined);
  },
} satisfies RenderFeature<OverlayFrame>;

const rendererOptions = {
  features: [boundsFeature, overlayFeature],
} satisfies RendererOptions;

void rendererOptions;
