// tweak-20260714-tilemap-layer-childed-render-entities M1 / m1-1 — coAttach
// metadata semantics (AC-01 root cause coverage; TileLayer default identity
// Transform in packages/runtime rides on this mechanism).
//
// coAttach lets a component declare companion components that the engine
// auto-attaches at spawn time when the caller does not name them in the
// spawn bundle. plan-strategy §2 D-1 chose this ECS-side default-injection
// path over demo-side explicit Transform to satisfy requirements AC-09
// (demo spawn code zero-change).
//
// Coverage:
//   (a) declaration surface — `defineComponent` accepts an optional
//       `coAttach: readonly [{ component, data }, ...]` array on options and
//       surfaces it on the frozen Component token.
//   (b) spawn injection — when the caller omits a coAttach-declared companion,
//       the engine spawn path adds it with the declared data (identity
//       defaults flow through defineComponent field-level defaults).
//   (c) explicit-caller wins — when the caller names the companion in the
//       spawn bundle, the caller value is preserved (coAttach must not
//       clobber layer-1 data).
//   (d) multiple companions — a component with N coAttach entries auto-adds
//       all N missing companions in one spawn call.
//   (e) chain isolation — coAttach fires exactly once per spawn bundle;
//       auto-attached companions do NOT recursively trigger their own
//       coAttach (charter P4 explicit boundary; keeps archetype hash stable
//       and prevents unbounded expansion).

import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '../index';

describe('coAttach — declaration surface (AC-01 layer 1)', () => {
  it('defineComponent accepts optional coAttach on options', () => {
    const CompA = defineComponent('CoAttachDeclA', { value: 'f32' });
    const Holder = defineComponent(
      'CoAttachDeclHolder',
      { flag: 'u8' },
      { coAttach: [{ component: CompA, data: { value: 1.5 } }] },
    );
    expect(Holder.coAttach).toBeDefined();
    // Frozen readonly array of one entry — component / data payloads survive.
    expect(Holder.coAttach?.length).toBe(1);
    expect(Holder.coAttach?.[0]?.component).toBe(CompA);
    expect((Holder.coAttach?.[0]?.data as { value: number }).value).toBe(1.5);
  });

  it('defineComponent without coAttach leaves the token field undefined', () => {
    const Plain = defineComponent('CoAttachDeclPlain', { value: 'f32' });
    expect(Plain.coAttach).toBeUndefined();
  });
});

describe('coAttach — spawn injection (AC-01 core)', () => {
  it('spawn adds a coAttach-declared companion when the caller omits it', () => {
    const Slot = defineComponent('CoAttachSlot', {
      x: { type: 'f32', default: 7 },
    });
    const Holder = defineComponent(
      'CoAttachSpawnHolder',
      { tag: 'u32' },
      { coAttach: [{ component: Slot, data: {} }] },
    );

    const world = new World();
    const e = world.spawn({ component: Holder, data: { tag: 42 } }).unwrap();

    // Holder itself present.
    const h = world.get(e, Holder).unwrap();
    expect(h.tag).toBe(42);
    // Slot auto-attached; default fill lands x = 7.
    const s = world.get(e, Slot).unwrap();
    expect(s.x).toBe(7);
  });

  it('coAttach data overrides field defaults when explicit values are given', () => {
    const Slot = defineComponent('CoAttachSlotOverride', {
      x: { type: 'f32', default: 0 },
    });
    const Holder = defineComponent(
      'CoAttachOverrideHolder',
      { tag: 'u32' },
      { coAttach: [{ component: Slot, data: { x: 99 } }] },
    );

    const world = new World();
    const e = world.spawn({ component: Holder, data: { tag: 1 } }).unwrap();
    expect(world.get(e, Slot).unwrap().x).toBe(99);
  });
});

describe('coAttach — explicit-caller wins (layer-1 preservation)', () => {
  it('caller-supplied companion is not overwritten by coAttach data', () => {
    const Slot = defineComponent('CoAttachWinsSlot', { x: 'f32' });
    const Holder = defineComponent(
      'CoAttachWinsHolder',
      { tag: 'u32' },
      { coAttach: [{ component: Slot, data: { x: 111 } }] },
    );

    const world = new World();
    // Caller names Slot with x=5; coAttach declares x=111 but must yield.
    const e = world
      .spawn({ component: Holder, data: { tag: 1 } }, { component: Slot, data: { x: 5 } })
      .unwrap();
    expect(world.get(e, Slot).unwrap().x).toBe(5);
  });
});

describe('coAttach — multiple companions per component', () => {
  it('N coAttach entries auto-attach all missing companions', () => {
    const A = defineComponent('CoAttachMultiA', {
      v: { type: 'u32', default: 11 },
    });
    const B = defineComponent('CoAttachMultiB', {
      w: { type: 'u32', default: 22 },
    });
    const Holder = defineComponent(
      'CoAttachMultiHolder',
      { tag: 'u32' },
      {
        coAttach: [
          { component: A, data: {} },
          { component: B, data: {} },
        ],
      },
    );

    const world = new World();
    const e = world.spawn({ component: Holder, data: { tag: 1 } }).unwrap();
    expect(world.get(e, A).unwrap().v).toBe(11);
    expect(world.get(e, B).unwrap().w).toBe(22);
  });
});

describe('coAttach — chain isolation (auto-attached companions are terminal)', () => {
  it('coAttach is not applied recursively — auto-attached companions do not add their own coAttach', () => {
    const Deep = defineComponent('CoAttachChainDeep', {
      d: { type: 'u32', default: 1 },
    });
    // Inner declares coAttach: [Deep]; if the engine chained recursively,
    // spawning Holder would land Deep on the entity via Inner's coAttach.
    const Inner = defineComponent(
      'CoAttachChainInner',
      { i: 'u32' },
      { coAttach: [{ component: Deep, data: {} }] },
    );
    const Holder = defineComponent(
      'CoAttachChainHolder',
      { tag: 'u32' },
      { coAttach: [{ component: Inner, data: {} }] },
    );

    const world = new World();
    const e = world.spawn({ component: Holder, data: { tag: 1 } }).unwrap();
    // Inner auto-attached — Holder's coAttach fires.
    expect(world.get(e, Inner).ok).toBe(true);
    // Deep NOT auto-attached — Inner's coAttach does not fire (chain
    // terminates at one level; charter P4 boundary).
    expect(world.get(e, Deep).ok).toBe(false);
  });
});
