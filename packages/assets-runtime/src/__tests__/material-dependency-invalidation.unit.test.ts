import { describe, expect, it } from 'vitest';
import { MaterialDependencyGraph } from '../material/dependency-graph.js';

describe('material dependency invalidation', () => {
  it('enumerates reverse edges and selectively invalidates descendants', () => {
    const graph = new MaterialDependencyGraph();
    graph.link('mat-child', ['mat-parent', 'texture/albedo', 'shader/module']);
    graph.link('mat-other', ['texture/other']);

    expect(graph.dependentsOf('mat-parent')).toEqual(['mat-child']);
    expect(graph.invalidate(['mat-parent'])).toEqual(['mat-child']);
    expect(graph.isInvalidated('mat-other')).toBe(false);
  });
});
