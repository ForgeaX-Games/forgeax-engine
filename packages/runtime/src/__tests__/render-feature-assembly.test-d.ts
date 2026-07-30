import type { RenderFeature } from '@forgeax/engine-render';
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
  prepare(data: TestFrameData) {
    const count: number = data.visibleCount;
    void count;
    return ok(undefined);
  },
  contribute(data: TestFrameData) {
    const count: number = data.visibleCount;
    void count;
    return ok(undefined);
  },
} satisfies RenderFeature<TestFrameData>;

declare const canvas: HTMLCanvasElement;

void createRenderer(canvas, { features: [feature] });
