import { defineComponent } from '@forgeax/engine-ecs';

/** Screen-space line width and local-space dash pattern for lists and strips. */
export const Lines = defineComponent(
  'Lines',
  {
    widthPx: { type: 'f32', default: 1 },
    dashSize: { type: 'f32', default: 1 },
    gapSize: { type: 'f32', default: 0 },
    dashOffset: { type: 'f32', default: 0 },
  },
  {
    meta: {
      quickStart: 'Attach Lines to line-list or line-strip meshes; gapSize > 0 enables dashes.',
      diagnostics: 'Inspect widthPx, dashSize, gapSize and dashOffset at points-lines admission.',
      recovery: 'Use finite widthPx > 0, dashSize > 0, gapSize >= 0 and finite dashOffset.',
      boundaries:
        'Lines owns width and dash style; MeshFilter and MeshRenderer own geometry and material.',
    },
  },
);
