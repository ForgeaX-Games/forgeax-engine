import { Entity, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, Transform } from '../index';
import { projectHierarchy, type SceneHierarchyDiagnostic } from '../systems';

describe('scene hierarchy projection contract', () => {
  it('exposes stable parent edges and diagnostic detail without throwing', () => {
    const world = new World();
    const parent = world.spawn({ component: Transform, data: {} }).unwrap();
    const child = world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent } })
      .unwrap();

    const snapshot = projectHierarchy(world);

    expect(snapshot.parentOf.get(child)).toBe(parent);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it('keeps every diagnostic machine-readable and deterministically ordered', () => {
    const world = new World();
    const first = world.spawn({ component: Transform, data: {} }).unwrap();
    const second = world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent: first } })
      .unwrap();
    const third = world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent: second } })
      .unwrap();
    const graph = (
      world as unknown as {
        _getGraph(): {
          archetypes: ReadonlyArray<
            | {
                size: number;
                columns: Map<number, Map<string, { view: Uint32Array }>>;
              }
            | undefined
          >;
        };
      }
    )._getGraph();
    for (const archetype of graph.archetypes) {
      if (archetype === undefined) continue;
      const entities = archetype?.columns.get(Entity.id)?.get('self')?.view;
      const parents = archetype?.columns.get(ChildOf.id)?.get('parent')?.view;
      if (entities === undefined || parents === undefined) continue;
      for (let row = 0; row < archetype.size; row++) {
        if (entities[row] === second) parents[row] = third;
      }
    }

    const diagnostics: readonly SceneHierarchyDiagnostic[] = projectHierarchy(world).diagnostics;

    expect(diagnostics.map((item) => item.detail.entity)).toEqual(
      [...diagnostics.map((item) => item.detail.entity)].sort((a, b) => a - b),
    );
    for (const diagnostic of diagnostics) {
      expect(['hierarchy-cycle', 'hierarchy-broken']).toContain(diagnostic.code);
      expect(diagnostic.expected).toEqual(expect.any(String));
      expect(diagnostic.hint).toEqual(expect.any(String));
      expect(diagnostic.detail.entity).toEqual(expect.any(Number));
      expect(diagnostic.detail.parent).toEqual(expect.any(Number));
    }
  });
});
