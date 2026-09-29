import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createDynamicGeometryHost } from '../assembly/dynamic-geometry-host';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { GpuResidencyCache } from '../device/gpu-residency';
import { createDynamicGeometryLifecycle } from '../dynamic-geometry';

function mesh(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
    attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    aabb: new Float32Array([0, 0, 0, 1, 1, 0]),
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'default' }],
  };
}

async function fixture() {
  const world = new World();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('unused cubemap');
    },
    device.caps,
  );
  const topologyChanged = vi.fn();
  const lifecycle = createDynamicGeometryLifecycle();
  const host = createDynamicGeometryHost({
    lifecycle,
    attachedWorlds: new Set([world]),
    getGpuStore: () => store,
    currentGeneration: () => 1,
    isConsumedByRenderFrame: () => true,
    onTopologyChanged: topologyChanged,
  });
  const entities = Array.from({ length: 2 }, () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', mesh()) } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap(),
  );
  const prepare = (revision: number) =>
    entities.map((entity) => {
      const source = mesh();
      return host
        .prepareDynamicGeometry({
          world,
          entity,
          mesh: source,
          meshHandle: world.allocSharedRef('MeshAsset', source),
          revision,
        })
        .unwrap();
    });
  const handles = () =>
    entities.map((entity) => world.get(entity, MeshFilter).unwrap().assetHandle);
  return { world, store, host, lifecycle, entities, prepare, handles, topologyChanged };
}

describe('dynamic geometry batch admission', () => {
  it('admits both meshes in one ordering and publishes both receipts', async () => {
    const f = await fixture();
    const prepared = f.prepare(1);
    const old = f.handles();
    const accepted = f.host
      .acceptDynamicGeometryCandidates(prepared, { world: f.world, fixedStep: 0 })
      .unwrap();
    expect(f.handles()).not.toEqual(old);
    expect(accepted.map((candidate) => candidate.state)).toEqual(['accepted', 'accepted']);
    expect(f.topologyChanged).toHaveBeenCalledTimes(1);
    const receipts = f.host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1 });
    expect(receipts.map((receipt) => receipt.candidateId).sort()).toEqual(
      prepared.map((candidate) => candidate.candidateId).sort(),
    );
    f.store.destroyAll();
  });

  it('retains prior unpublished candidates when the second ECS swap fails', async () => {
    const f = await fixture();
    const prior = f
      .prepare(1)
      .map((candidate) =>
        f.host.acceptDynamicGeometry(candidate, { world: f.world, fixedStep: 0 }).unwrap(),
      );
    const old = f.handles();
    const next = f.prepare(2);
    const set = f.world.set.bind(f.world);
    // Use the ECS's own missing-component failure without changing either live mesh.
    const absent = f.world.spawn({ component: Transform, data: {} }).unwrap();
    const refused = set(absent, MeshFilter, { assetHandle: old[0] });
    expect(refused.ok).toBe(false);
    vi.spyOn(f.world, 'set').mockImplementation((entity, component, data) =>
      entity === f.entities[1] && component === MeshFilter ? refused : set(entity, component, data),
    );
    expect(f.host.acceptDynamicGeometryCandidates(next, { world: f.world, fixedStep: 0 }).ok).toBe(
      false,
    );
    expect(f.handles()).toEqual(old);
    const receipts = f.host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1 });
    expect(receipts.map((receipt) => receipt.candidateId).sort()).toEqual(
      prior.map((candidate) => candidate.candidateId).sort(),
    );
    vi.restoreAllMocks();
    f.store.destroyAll();
  });

  it('throws when a failed group cannot restore its first ECS binding', async () => {
    const f = await fixture();
    const old = f.handles();
    const next = f.prepare(1);
    const set = f.world.set.bind(f.world);
    const absent = f.world.spawn({ component: Transform, data: {} }).unwrap();
    const refused = set(absent, MeshFilter, { assetHandle: old[0] });
    let writes = 0;
    vi.spyOn(f.world, 'set').mockImplementation((entity, component, data) => {
      if (component === MeshFilter && ++writes >= 2) return refused;
      return set(entity, component, data);
    });
    expect(() =>
      f.host.acceptDynamicGeometryCandidates(next, { world: f.world, fixedStep: 0 }),
    ).toThrow('restores every previous ECS binding');
    vi.restoreAllMocks();
    f.store.destroyAll();
  });

  it('rejects duplicate entities before changing the visible meshes', async () => {
    const f = await fixture();
    const candidates = f.prepare(1);
    const first = candidates[0];
    if (first === undefined) throw new Error('fixture requires a prepared candidate');
    const old = f.handles();
    expect(
      f.host.acceptDynamicGeometryCandidates([first, first], {
        world: f.world,
        fixedStep: 0,
      }).ok,
    ).toBe(false);
    expect(f.handles()).toEqual(old);
    expect(f.topologyChanged).not.toHaveBeenCalled();
    f.store.destroyAll();
  });
});
