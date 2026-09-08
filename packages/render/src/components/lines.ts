import { defineComponent } from '@forgeax/engine-ecs';

/** Screen-space independent line segment style. */
export const Lines = defineComponent(
  'Lines',
  {
    widthPx: { type: 'f32', default: 1 },
  },
  {
    meta: {
      quickStart: 'Attach Lines to render line-list MeshAsset pairs in screen pixels.',
      diagnostics: 'Inspect widthPx at the points-lines admission boundary.',
      recovery: 'Use points-lines-invalid-style for non-finite or non-positive widthPx values.',
      boundaries:
        'Lines owns raster width only; MeshFilter and MeshRenderer own geometry and material.',
    },
  },
);
