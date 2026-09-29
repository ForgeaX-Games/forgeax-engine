import {
  AssetRegistry,
  HANDLE_CUBE,
  RuntimeMaterialValue,
  RuntimeMeshVertices,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
import { Time, World } from '@forgeax/engine-ecs';
import { ChildOf, GlobalTransform, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  Camera,
  CameraView,
  Instances,
  MeshFilter,
  MeshRenderer,
  Points,
  PostProcessParams,
  Skylight,
  Visibility,
  VisibilityStateValue,
} from '../../components';
import { PersistentRenderScene } from '../../scene/render-scene';
import { renderPublicationTransfers } from '../contract';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';

function fixture() {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const identity = { source: 'publication-test', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 3 } },
    )
    .unwrap();
  const spawn = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
  const first = spawn(),
    second = spawn();
  world.update(0).unwrap();
  const receiver = new RenderPublicationReceiver(identity),
    scene = new PersistentRenderScene();
  const publish = () => {
    const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    const saved = structuredClone(packet);
    const accepted = receiver.accept(packet).unwrap();
    const frame = scene.consumePublication(accepted);
    const returned = structuredClone(renderPublicationTransfers(packet), {
      transfer: renderPublicationTransfers(packet),
    });
    publisher.recycle(packet.revision, returned).unwrap();
    // Preserve logical rows independently from the returned transport storage.
    return { packet: saved, frame };
  };
  return { world, publisher, receiver, scene, first, second, spawn, publish };
}

describe('native render publication', () => {
  it('queries detached bounds by publication identity and rejects another epoch', () => {
    const f = fixture();
    const identity = { source: 'publication-test', epoch: 1 };
    expect(f.scene.bounds(identity, f.first)).toBeUndefined();
    f.publish();
    const bounds = f.scene.bounds(identity, f.first);
    expect(bounds).toBeDefined();
    expect(f.scene.bounds({ ...identity, epoch: 2 }, f.first)).toBeUndefined();
    expect(f.scene.bounds({ source: 'other', epoch: 1 }, f.first)).toBeUndefined();
    if (bounds !== undefined) Reflect.set(bounds.min, '0', -999);
    expect(f.scene.bounds(identity, f.first)?.min[0]).not.toBe(-999);
    f.publisher.dispose();
  });

  it('publishes a numeric baseline, observes no static delta and retains the same CPU slots', () => {
    const f = fixture();
    const initial = f.publish();
    expect(initial.frame.renderables).toHaveLength(2);
    expect(initial.packet.templates).toHaveLength(1);
    const slots = f.scene.compositionSlots().map((slot) => [slot.slot, slot.generation]);
    const next = f.publish();
    expect(
      next.packet.upserts.length + next.packet.transforms.length + next.packet.removed.length,
    ).toBe(0);
    expect(next.packet.assets).toHaveLength(0);
    expect(f.scene.compositionSlots().map((slot) => [slot.slot, slot.generation])).toEqual(slots);
    f.publisher.dispose();
  });

  it('accumulates changes across a slow consumer without transferring ECS columns', () => {
    const f = fixture();
    f.publish();
    f.world.set(f.first, Transform, { pos: [1, 0, 0] }).unwrap();
    f.world.update(1 / 60).unwrap();
    f.world.set(f.second, Transform, { pos: [2, 0, 0] }).unwrap();
    f.world.update(1 / 60).unwrap();
    const next = f.publish();
    expect(next.packet.upserts).toHaveLength(0);
    expect(new Set(next.packet.transformEntities)).toEqual(new Set([f.first, f.second]));
    for (const entity of [f.first, f.second]) {
      const matrix = f.world.get(entity, GlobalTransform).unwrap().world;
      expect(matrix.byteLength).toBe(64);
      expect([
        ...(next.frame.renderables.find((row) => row.entityKey === entity)?.transform.world ?? []),
      ]).toEqual([...matrix]);
    }
    f.publisher.dispose();
  });

  it('reconciles destruction and generation reuse without reviving the old render identity', () => {
    const f = fixture();
    f.publish();
    f.world.despawn(f.first).unwrap();
    const replacement = f.spawn();
    f.world.update(0).unwrap();
    const next = f.publish();
    expect(next.packet.removed).toContain(f.first);
    expect(next.frame.renderables.map((row) => row.entityKey)).toEqual(
      expect.arrayContaining([replacement, f.second]),
    );
    expect(next.frame.renderables.some((row) => row.entityKey === f.first)).toBe(false);
    f.publisher.dispose();
  });

  it('rejects old epochs before the first baseline and wrong revisions without advancing acceptance', () => {
    const f = fixture();
    const candidate = f.publisher.prepare(0).unwrap();
    expect(f.receiver.accept({ ...candidate.packet, epoch: 0 })).toMatchObject({
      ok: false,
      error: { detail: { reason: 'identity' } },
    });
    expect(f.receiver.accept({ ...candidate.packet, base: 1 })).toMatchObject({
      ok: false,
      error: { detail: { reason: 'base' } },
    });
    expect(f.receiver.accept({ ...candidate.packet, revision: 2 })).toMatchObject({
      ok: false,
      error: { detail: { reason: 'revision' } },
    });
    expect(f.receiver.acceptedRevision).toBe(0);
    candidate.discard();
    f.publish();
    expect(f.receiver.acceptedRevision).toBe(1);
    f.publisher.dispose();
  });

  it('rejects malformed columns and missing dependencies without consuming the baseline', () => {
    const f = fixture();
    const candidate = f.publisher.prepare(0).unwrap();
    for (const packet of [
      { ...candidate.packet, transforms: new Float32Array(1) },
      { ...candidate.packet, assets: [] },
      { ...candidate.packet, upserts: new Uint32Array([f.first, 99]) },
      { ...candidate.packet, removed: new Uint32Array([f.first]) },
    ]) {
      expect(f.receiver.accept(packet).ok).toBe(false);
      expect(f.receiver.acceptedRevision).toBe(0);
    }
    candidate.discard();
    expect(f.publish().frame.renderables).toHaveLength(2);
    f.publisher.dispose();
  });

  it('retries observed transforms after a discarded synchronous publication', () => {
    const f = fixture();
    f.publish();
    f.world.set(f.first, Transform, { pos: [3, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    const discarded = f.publisher.prepare(0).unwrap();
    discarded.discard();
    const next = f.publish();
    expect(
      next.frame.renderables.find((row) => row.entityKey === f.first)?.transform.world[12],
    ).toBe(3);
    f.publisher.dispose();
  });
});

it('publishes shared material changes and their removal, and retires detached dependencies', () => {
  const f = fixture();
  const asset: MaterialAsset = {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [1, 0, 0, 1] },
  };
  const handle = f.world.allocSharedRef('MaterialAsset', asset);
  f.world.set(f.first, MeshRenderer, { materials: [handle] }).unwrap();
  f.world.set(f.second, MeshRenderer, { materials: [handle] }).unwrap();
  f.publish();
  const content = f.world
    .spawn({
      component: RuntimeMaterialValue,
      data: { asset: handle, parameter: 'baseColor', kind: 2, value: [0, 1, 0, 1] },
    })
    .unwrap();
  const changed = f.publish();
  expect(changed.packet.upserts.length).toBe(4);
  expect(changed.packet.invalidatedAssets).toContain(handle);
  expect(changed.frame.renderables.every((row) => row.material.baseColor[1] === 1)).toBe(true);
  f.world.despawn(content).unwrap();
  expect(f.publish().frame.renderables.every((row) => row.material.baseColor[0] === 1)).toBe(true);
  f.world.despawn(f.first).unwrap();
  f.world.despawn(f.second).unwrap();
  expect(f.publish().packet.retiredAssets).toContain(handle);
  f.publisher.dispose();
});

it('publishes projected mesh buffers and restores their base payload after content removal', () => {
  const f = fixture();
  f.publish();
  const original = resolveAssetHandle<MeshAsset>(f.world, HANDLE_CUBE).unwrap();
  const vertices = new Float32Array(original.vertices);
  vertices[0] = Number(vertices[0]) + 0.25;
  const content = f.world
    .spawn({ component: RuntimeMeshVertices, data: { asset: HANDLE_CUBE, vertices } })
    .unwrap();
  const changed = f.publish();
  expect(changed.packet.invalidatedAssets).toContain(HANDLE_CUBE);
  expect(
    (changed.packet.assets.find((row) => row.handle === HANDLE_CUBE)?.value as MeshAsset)
      .vertices[0],
  ).toBe(vertices[0]);
  f.world.despawn(content).unwrap();
  expect(
    (f.publish().packet.assets.find((row) => row.handle === HANDLE_CUBE)?.value as MeshAsset)
      .vertices[0],
  ).toBe(original.vertices[0]);
  f.publisher.dispose();
});

it('propagates parent visibility and reuses returned storage without allocation growth', () => {
  const f = fixture();
  f.publish();
  const parent = f.world
    .spawn(
      { component: Transform, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  f.world.addComponent(f.first, { component: ChildOf, data: { parent } }).unwrap();
  f.world.update(0).unwrap();
  f.publish();
  f.world.set(parent, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
  expect(f.publish().frame.renderables.some((row) => row.entityKey === f.first)).toBe(false);
  f.world.set(parent, Visibility, { state: VisibilityStateValue.visible }).unwrap();
  f.publish();
  const allocations = f.publisher.inspect().allocations;
  for (let i = 0; i < 12; i++) {
    f.world.set(f.second, Transform, { pos: [i, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    f.publish();
  }
  expect(f.publisher.inspect().allocations).toBe(allocations);
  f.publisher.dispose();
});

it('ignores unbound geometry vocabulary just like local extraction', () => {
  const f = fixture();
  f.publish();
  f.world.spawn({ component: Points, data: {} }).unwrap();
  const result = f.publisher.prepare(0);
  expect(result.ok).toBe(true);
  if (result.ok) result.value.discard();
  f.publisher.dispose();
});

it.each([
  10_000, 50_000,
])('keeps static publication delta and native scanned rows at zero for %i entities', (count) => {
  const f = fixture();
  for (let i = 2; i < count; i++) f.spawn();
  f.world.update(0).unwrap();
  const baseline = f.publish();
  expect(baseline.packet.upserts.length).toBe(count * 2);
  const allocations = f.publisher.inspect().allocations;
  for (let i = 0; i < 3; i++) {
    const next = f.publish();
    expect(
      next.packet.upserts.length +
        next.packet.transforms.length +
        next.packet.removed.length +
        next.packet.assets.length,
    ).toBe(0);
    expect(f.publisher.inspect().scannedRows).toBe(0);
    expect(f.publisher.inspect().allocations).toBe(allocations);
  }
  f.publisher.dispose();
}, 60_000);

it('publishes instance poses without detaching source storage and accumulates skipped updates', () => {
  const f = fixture();
  const matrices = new Float32Array(32);
  for (let i = 0; i < 2; i++) for (const j of [0, 5, 10, 15]) matrices[i * 16 + j] = 1;
  f.world.addComponent(f.first, { component: Instances, data: { transforms: matrices } }).unwrap();
  const initial = f.publish();
  expect(
    initial.frame.renderables.find((row) => row.entityKey === f.first)?.instances?.transforms,
  ).toEqual(matrices);
  matrices[12] = 0.5;
  f.world.set(f.first, Instances, { transforms: matrices }).unwrap();
  matrices[28] = -0.5;
  f.world.set(f.first, Instances, { transforms: matrices }).unwrap();
  const next = f.publish();
  expect(
    next.frame.renderables.find((row) => row.entityKey === f.first)?.instances?.transforms,
  ).toEqual(matrices);
  expect(f.world.get(f.first, Instances).unwrap().transforms.byteLength).toBe(128);
  expect(f.publish().packet.upserts).toHaveLength(0);
  f.publisher.dispose();
});

it('publishes frame-owned environment and post parameters without geometry churn', () => {
  const f = fixture();
  f.publish();
  f.world.spawn({ component: Skylight, data: { intensity: 2 } }).unwrap();
  f.world
    .spawn({
      component: PostProcessParams,
      data: { shader: 'test-post', data: new Uint8Array([1, 2, 3, 4]) },
    })
    .unwrap();
  const next = f.publish();
  expect(next.frame.skylight?.intensity).toBe(2);
  expect(next.frame.postProcessParams.get('test-post')).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(next.packet.upserts).toHaveLength(0);
  f.publisher.dispose();
});

it('publishes detached skin poses and follows joint changes across skipped source frames', () => {
  const f = fixture();
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const skeleton = f.world.allocSharedRef('SkeletonAsset', {
    kind: 'skeleton',
    jointCount: 1,
    inverseBindMatrices: identity,
  });
  const joint = f.world.spawn({ component: Transform, data: {} }).unwrap();
  f.world
    .addComponent(f.first, {
      component: Skin,
      data: { skeleton, joints: new Uint32Array([joint]) },
    })
    .unwrap();
  f.world.update(0).unwrap();
  const initial = f.publish();
  const pose = initial.packet.templates.find((t) => t.snapshot.skinPose !== undefined)?.snapshot
    .skinPose;
  expect(pose?.jointCount).toBe(1);
  expect(initial.packet.templates.every((t) => t.snapshot.skin === undefined)).toBe(true);
  f.world.set(joint, Transform, { pos: [0.5, 0, 0] }).unwrap();
  f.world.update(1 / 60).unwrap();
  f.world.set(joint, Transform, { pos: [1, 0, 0] }).unwrap();
  f.world.update(1 / 60).unwrap();
  const next = f.publish();
  const nextPose = next.packet.templates.find((t) => t.snapshot.skinPose !== undefined)?.snapshot
    .skinPose;
  expect(nextPose?.jointWorlds[0]?.[12]).toBe(1);
  expect(pose?.jointWorlds[0]?.[12]).toBe(0);
  expect(f.publish().packet.upserts).toHaveLength(0);
  f.world.removeComponent(f.first, Skin).unwrap();
  expect(
    f.publish().frame.renderables.find((row) => row.entityKey === f.first)?.skinPose,
  ).toBeUndefined();
  f.publisher.dispose();
});

it('renders a one-frame identity before its sealed removal and reuses two buffer slots', () => {
  const f = fixture();
  const seal = () => {
    const candidate = f.publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    return packet;
  };
  try {
    const first = seal();
    f.world.despawn(f.first).unwrap();
    const replacement = f.spawn();
    f.world.update(0).unwrap();
    const second = seal();
    // More source mutations cannot edit either already-transferred publication.
    f.world.despawn(replacement).unwrap();
    f.world.update(0).unwrap();
    const firstFrame = f.scene.consumePublication(f.receiver.accept(first).unwrap());
    expect(firstFrame.renderables.map((row) => row.entityKey)).toContain(f.first);
    f.publisher.recycle(first.revision, renderPublicationTransfers(first)).unwrap();
    const secondFrame = f.scene.consumePublication(f.receiver.accept(second).unwrap());
    expect(secondFrame.renderables.map((row) => row.entityKey)).toContain(replacement);
    expect(secondFrame.renderables.map((row) => row.entityKey)).not.toContain(f.first);
    f.publisher.recycle(second.revision, renderPublicationTransfers(second)).unwrap();
    // Warm both slots for equivalent changed-transform frames, then drain in pairs.
    let warmAllocations: number | undefined;
    for (let index = 0; index < 4; index++) {
      const packets = [1, 2].map((x) => {
        f.world.set(f.second, Transform, { pos: [x, index, 0] }).unwrap();
        f.world.update(0).unwrap();
        return seal();
      });
      const allocations = f.publisher.inspect().allocations;
      for (const packet of packets)
        f.publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
      warmAllocations ??= allocations;
      expect(allocations).toBe(warmAllocations);
    }
  } finally {
    f.publisher.dispose();
  }
});

it('publishes detached view configuration and seeds a late view from the current scene', () => {
  const f = fixture();
  const camera = f.world
    .spawn(
      { component: Transform, data: {} },
      { component: Camera, data: {} },
      { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], updateInterval: 4 } },
    )
    .unwrap();
  f.world.update(0).unwrap();
  const first = f.publish();
  expect(first.packet.metadata.cameras).toHaveLength(1);
  expect(first.packet.metadata.cameras[0]?.view).toMatchObject({ updateInterval: 4 });
  f.world.set(camera, CameraView, { viewport: [0, 0, 1, 1] }).unwrap();
  expect(Array.from(first.packet.metadata.cameras[0]?.view?.viewport ?? [])).toEqual([
    0.5, 0, 0.5, 1,
  ]);
  f.world.set(f.first, Transform, { pos: [3, 0, 0] }).unwrap();
  f.world.despawn(f.second).unwrap();
  f.world.update(0).unwrap();
  const candidate = f.publisher.prepare(1).unwrap();
  const packet = structuredClone(candidate.packet, {
    transfer: renderPublicationTransfers(candidate.packet),
  });
  candidate.accept();
  const accepted = f.receiver.accept(packet).unwrap();
  const late = new PersistentRenderScene();
  const frame = late.consumePublication(f.receiver.snapshot(accepted));
  expect(frame.renderables.map((row) => row.entityKey)).toEqual([Number(f.first)]);
  expect(frame.renderables[0]?.transform.world[12]).toBe(3);
  f.publisher.dispose();
});
