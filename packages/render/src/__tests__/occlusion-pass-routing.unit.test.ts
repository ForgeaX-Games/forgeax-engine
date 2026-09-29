import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const typedPrimitivesSource = readFileSync(
  new URL('../typed-render-graph-primitives.ts', import.meta.url),
  'utf8',
);

describe('typed scene occlusion pass routing', () => {
  it('only forwards a projection to the pass that owns its query set', () => {
    expect(typedPrimitivesSource).toContain('const activeOcclusion = options.occlusion;');
    expect(typedPrimitivesSource).not.toContain(
      '...(internal.occlusion === undefined ? {} : { occlusion: internal.occlusion })',
    );
  });
});
