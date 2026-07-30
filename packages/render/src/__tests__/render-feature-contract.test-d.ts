import { ok } from '@forgeax/engine-types';
import type { RenderFeature } from '../features/types';

type AlphaFrame = {
  readonly visibleCount: number;
};

type BetaFrame = {
  readonly bounds: readonly [number, number, number, number];
};

const alphaFeature = {
  identity: 'synthetic.alpha',
  extract({ owner }) {
    const frame: AlphaFrame = { visibleCount: owner };
    return ok(frame);
  },
  prepare(data: AlphaFrame) {
    const count: number = data.visibleCount;
    void count;
    return ok(undefined);
  },
  contribute(data: AlphaFrame) {
    const count: number = data.visibleCount;
    void count;
    return ok(undefined);
  },
} satisfies RenderFeature<AlphaFrame>;

const betaFeature = {
  identity: 'synthetic.beta',
  extract() {
    return ok({ bounds: [0, 0, 1, 1] as const });
  },
  prepare(data: BetaFrame) {
    const bounds: BetaFrame['bounds'] = data.bounds;
    void bounds;
    return ok(undefined);
  },
  contribute(data: BetaFrame) {
    const bounds: BetaFrame['bounds'] = data.bounds;
    void bounds;
    return ok(undefined);
  },
} satisfies RenderFeature<BetaFrame>;

const heterogeneousFeatures = [
  alphaFeature,
  betaFeature,
] satisfies readonly RenderFeature<unknown>[];

for (const feature of heterogeneousFeatures) {
  const identity: string = feature.identity;
  void identity;
}

void alphaFeature;
void betaFeature;
