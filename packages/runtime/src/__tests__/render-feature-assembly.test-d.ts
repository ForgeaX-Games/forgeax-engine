import type {
  RendererState,
  RenderFeature,
  RenderFeaturePlanContext,
} from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { createRenderer } from '../createRenderer';

type TestFrameData = {
  readonly visibleCount: number;
};

const feature = {
  identity: 'test.runtime-assembly',
  extract({ owner }) {
    return ok({ visibleCount: owner });
  },
  plan(data: TestFrameData, context: RenderFeaturePlanContext) {
    const count: number = data.visibleCount;
    void count;
    void context;
    return ok({ resources: [], passes: [] });
  },
} satisfies RenderFeature<TestFrameData>;

declare const canvas: HTMLCanvasElement;

const creation = createRenderer(canvas, { features: [feature] });
creation.then((result) => {
  if (!result.ok) return;
  const alive: RendererState = 'alive';
  const state: RendererState = result.value.state();
  const unsubscribe = result.value.subscribe((event) => {
    if (event.kind === 'error') void event.error.code;
  });
  void alive;
  void state;
  unsubscribe();
});
