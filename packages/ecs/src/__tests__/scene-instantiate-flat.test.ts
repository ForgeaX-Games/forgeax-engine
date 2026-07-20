// instantiateSceneFlat — "edit the scene itself" primitive.
//
// Unlike instantiateScene (which mints a synthetic SceneInstance root and force-
// parents every top-level member under it), instantiateSceneFlat spawns the
// scene's entities as plain top-level world entities: no wrapper root, no forced
// ChildOf. Hierarchy is exactly the authored ChildOf. Nested prefabs (mounts[])
// STILL materialise as their own SceneInstance anchors (charter P4).

/// <reference types="vitest" />

import type { Handle, LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { Component } from '../component';
import { defineComponent, resolveComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { World } from '../world';

const Transform = defineComponent('Transform', {
  posX: { type: 'f32' },
  posY: { type: 'f32' },
  posZ: { type: 'f32' },
});

// Registered for the global resolveComponent index (accessed by name below);
// the return values are unused, defineComponent's side effect is the point.
defineComponent('ChildOf', {
  parent: { type: 'entity' },
});
defineComponent('Name', {
  value: { type: 'string' },
});
defineComponent('SceneInstance', {
  source: { type: 'shared<SceneAsset>' },
  mapping: { type: 'array<entity>' },
  state: { type: 'unique<SceneInstanceState>' },
});

function localId(n: number): LocalEntityId {
  return n as LocalEntityId;
}
function buildScene(nodes: readonly SceneEntity[]): SceneAsset {
  return { kind: 'scene', entities: nodes };
}
function reg(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  return world.allocSharedRef('SceneAsset', asset);
}
function tok(name: string): Component<string> {
  const t = resolveComponent(name);
  if (t === undefined) throw new Error(`${name} not registered`);
  return t;
}
function nameOf(world: World, e: EntityHandle): string | undefined {
  const r = world.get(e, tok('Name'));
  return r.ok ? (r.value as { value: string }).value : undefined;
}
function hasSceneInstance(world: World, e: EntityHandle): boolean {
  return world.get(e, tok('SceneInstance')).ok;
}

describe('instantiateSceneFlat', () => {
  it('(a) spawns exactly N entities, NO synthetic root, NO SceneInstance', () => {
    const nodes: SceneEntity[] = [
      {
        localId: localId(0),
        components: { Name: { value: 'A' }, Transform: { posX: 0, posY: 0, posZ: 0 } },
      },
      {
        localId: localId(1),
        components: { Name: { value: 'B' }, Transform: { posX: 1, posY: 1, posZ: 1 } },
      },
      {
        localId: localId(2),
        components: { Name: { value: 'C' }, Transform: { posX: 2, posY: 2, posZ: 2 } },
      },
    ];
    const world = new World();
    const before = world.inspect().entityCount;
    const r = world.instantiateSceneFlat(reg(world, buildScene(nodes)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Exactly N — no +1 wrapper.
    expect(world.inspect().entityCount - before).toBe(3);
    expect(r.value.roots.length).toBe(3);
    // No entity carries SceneInstance (no anchor exists for a flat scene).
    for (const e of r.value.roots) expect(hasSceneInstance(world, e)).toBe(false);
  });

  it("(b) an entity's authored ChildOf is preserved verbatim (no re-parent)", () => {
    // localId 1 is a child of localId 0 in the authored data.
    const nodes: SceneEntity[] = [
      {
        localId: localId(0),
        components: { Name: { value: 'Parent' }, Transform: { posX: 0, posY: 0, posZ: 0 } },
      },
      {
        localId: localId(1),
        components: {
          Name: { value: 'Child' },
          Transform: { posX: 0, posY: 0, posZ: 0 },
          ChildOf: { parent: 0 },
        },
      },
    ];
    const world = new World();
    const r = world.instantiateSceneFlat(reg(world, buildScene(nodes)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only localId 0 (rootless) is a top-level root; localId 1 stays a child.
    expect(r.value.roots.length).toBe(1);
    const parent = r.value.roots[0];
    if (parent === undefined) throw new Error('expected one root');
    expect(nameOf(world, parent)).toBe('Parent');
    // The child (localId 1) is NOT a root; its ChildOf.parent still points at the
    // real parent entity — the authored edge is untouched, not re-pointed at a
    // synthetic root. Find it by scanning raw handles for the named child.
    let child: EntityHandle | undefined;
    for (let raw = 0; raw < 12; raw++) {
      const e = raw as unknown as EntityHandle;
      if (nameOf(world, e) === 'Child') child = e;
    }
    if (child === undefined) throw new Error('expected a Child entity');
    const co = world.get(child, tok('ChildOf'));
    expect(co.ok && (co.value as { parent: EntityHandle }).parent).toBe(parent);
  });

  it('(c) ChildOf-less entities are top-level and returned in roots', () => {
    const nodes: SceneEntity[] = [
      {
        localId: localId(0),
        components: { Name: { value: 'R0' }, Transform: { posX: 0, posY: 0, posZ: 0 } },
      },
      {
        localId: localId(1),
        components: { Name: { value: 'R1' }, Transform: { posX: 0, posY: 0, posZ: 0 } },
      },
      {
        localId: localId(2),
        components: {
          Name: { value: 'K' },
          Transform: { posX: 0, posY: 0, posZ: 0 },
          ChildOf: { parent: 0 },
        },
      },
    ];
    const world = new World();
    const r = world.instantiateSceneFlat(reg(world, buildScene(nodes)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // R0 + R1 are roots; K is not.
    expect(r.value.roots.length).toBe(2);
    const names = r.value.roots.map((e) => nameOf(world, e)).sort();
    expect(names).toEqual(['R0', 'R1']);
  });

  it('(d) a scene WITH a mount still mints a child SceneInstance anchor', () => {
    const world = new World();
    // Burn a slot so the mount entity does not land on raw 0.
    world.spawn({ component: Transform, data: { posX: 0, posY: 0, posZ: 0 } });
    const child = buildScene([
      {
        localId: localId(0),
        components: { Name: { value: 'bed' }, Transform: { posX: 0, posY: 0, posZ: 0 } },
      },
    ]);
    const childHandle = reg(world, child);
    const outer: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: localId(0),
          components: { Name: { value: 'Ground' }, Transform: { posX: 0, posY: 0, posZ: 0 } },
        },
      ],
      mounts: [{ localId: localId(1), source: 0, memberFirst: localId(2), memberCount: 1 }],
    };
    const outerHandle = reg(world, outer);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateSceneFlat(outerHandle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // roots: Ground (own rootless) + the mount carrier (default-parented, now
    // top-level because there is no synthetic root to attach to).
    expect(r.value.roots.length).toBe(2);
    // Exactly one live entity carries SceneInstance — the nested child anchor
    // (the mount expansion). It is NOT one of the flat scene's own roots. We
    // scan raw handles directly: these ecs unit tests register a plain `ChildOf`
    // with no `Children` mirror, so `iterDescendants` (mirror-walk) can't reach
    // it — a harness artifact, not a runtime behavior (the runtime `ChildOf`
    // carries the mirror).
    const rootSet = new Set<number>(r.value.roots as unknown as number[]);
    let anchorCount = 0;
    for (let raw = 0; raw < 12; raw++) {
      const e = raw as unknown as EntityHandle;
      if (!hasSceneInstance(world, e)) continue;
      anchorCount += 1;
      expect(rootSet.has(raw)).toBe(false); // the anchor is not a flat-scene root
    }
    expect(anchorCount).toBe(1);
  });
});
