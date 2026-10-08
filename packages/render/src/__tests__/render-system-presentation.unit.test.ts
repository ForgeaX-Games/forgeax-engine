import { expect, it } from 'vitest';
import type { RenderSystemInternals } from '../record/render-context';
import {
  type DispatchEntry,
  defaultMaterialSnapshot,
  type RenderableSnapshot,
} from '../render-system-extract';
import { projectFramePresentation } from '../render-system-presentation';

it.each([
  'instances',
  'spriteInstances',
] as const)('excludes empty %s from presentation and resumes gating when populated', (field) => {
  const project = (count: number | undefined) =>
    projectFramePresentation({
      hasCamera: true,
      hasEnvironment: true,
      environmentReady: true,
      submissionRenderables: [
        {
          worldId: 0,
          authorVisible: true,
          assetHandle: 0,
          entityKey: 1,
          transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
          material: defaultMaterialSnapshot(),
          materials: [defaultMaterialSnapshot()],
          materialBindingSources: [],
          ...(count === undefined
            ? {}
            : {
                [field]: {
                  instanceCount: count,
                  transforms: new Float32Array(count * 16),
                  ...(field === 'spriteInstances' ? { regions: new Float32Array(count * 4) } : {}),
                  cacheKey: 1,
                  archVersion: 0,
                },
              }),
        } satisfies RenderableSnapshot,
      ],
      submissionDispatch: [
        {
          entityIndex: 0,
          materialHandle: 0,
          renderableIndex: 0,
          passIndex: 0,
          queue: 2000,
          layer: 0,
          tags: { LightMode: 'Forward' },
          renderState: undefined,
          defines: undefined,
          vertexEntry: undefined,
          fragmentEntry: undefined,
          materialShaderId: undefined,
          paramSnapshot: undefined,
        } satisfies DispatchEntry,
      ],
      // An absent material world makes residency pending; no GPU mock is needed.
      preparedWorlds: [],
      internals: {} as RenderSystemInternals,
    });
  expect(project(0)).toEqual({ renderables: [], presentation: 'ready' });
  expect(project(1).presentation).toBe('pending');
  expect(project(0)).toEqual({ renderables: [], presentation: 'ready' });
  expect(project(undefined).presentation).toBe('pending');
});
