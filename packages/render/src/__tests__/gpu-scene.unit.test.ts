import type { Buffer, Result, RhiError } from '@forgeax/engine-rhi';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { GpuScene } from '../gpu-scene';
import { GPU_SCENE_LAYOUTS, gpuSceneFieldOffset } from '../gpu-scene-schema';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

interface WriteRecord {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

class RecordingQueue extends RhiNullQueue {
  readonly writes: WriteRecord[] = [];

  override writeBuffer(
    buffer: Buffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): Result<void, RhiError> {
    const source =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const start = dataOffset ?? 0;
    const length = size ?? source.byteLength - start;
    this.writes.push({ offset: bufferOffset, bytes: source.slice(start, start + length) });
    return super.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
  }
}

const material = {
  baseColor: new Float32Array([0.25, 0.5, 0.75]),
  metallic: 0.2,
  roughness: 0.8,
  materialHandle: 17,
} as MaterialSnapshot;

function snapshot(entityKey: number, translationX = 0): RenderableSnapshot {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[12] = translationX;
  return {
    assetHandle: 9,
    transform: { world },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
  };
}

function createDevice(queue: RecordingQueue): RhiNullDevice {
  return new RhiNullDevice(
    queue,
    (bookkeeper, device) => new RhiNullCommandEncoder(bookkeeper, device),
  );
}

describe('GpuScene', () => {
  it('uploads only coalesced dirty ranges and performs no upload on no-change', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 4).unwrap();
    expect(created.status).toBe('available');
    if (created.status !== 'available') return;
    const projection = new RenderScene();

    const initial = projection.apply([
      { kind: 'create', snapshot: snapshot(0) },
      { kind: 'create', snapshot: snapshot(1) },
      { kind: 'create', snapshot: snapshot(2) },
    ]);
    expect(created.scene.sync(initial).unwrap()).toMatchObject({ ranges: 5, bytes: 1344 });
    const writesAfterInitial = queue.writes.length;

    created.scene.sync(projection.apply([])).unwrap();
    expect(queue.writes).toHaveLength(writesAfterInitial);

    const dirty = projection.apply([
      { kind: 'update-transform', worldId: 0, entityKey: 0, world: snapshot(0, 4).transform.world },
      { kind: 'update-transform', worldId: 0, entityKey: 2, world: snapshot(2, 8).transform.world },
    ]);
    expect(created.scene.sync(dirty).unwrap()).toMatchObject({ ranges: 10 });
    expect(queue.writes.length).toBeGreaterThan(writesAfterInitial);
    expect(created.scene.inspect()).toMatchObject({ noChangeFrames: 1 });
  });

  it('clears removed slots, grows without losing the CPU mirror, and rebuilds a fresh table', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 2).unwrap();
    if (created.status !== 'available') return;
    const projection = new RenderScene();
    created.scene
      .sync(
        projection.apply([
          { kind: 'create', snapshot: snapshot(0) },
          { kind: 'create', snapshot: snapshot(1) },
          { kind: 'create', snapshot: snapshot(2) },
        ]),
      )
      .unwrap();
    expect(created.scene.inspect()).toMatchObject({ capacity: 8, capacityGrows: 1 });

    const beforeRemove = queue.writes.length;
    created.scene.sync(projection.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }])).unwrap();
    expect(queue.writes.slice(beforeRemove)).toHaveLength(5);
    expect(queue.writes.at(-1)?.bytes.every((value) => value === 0)).toBe(true);
    expect(created.scene.inspect().clearedSlots).toBe(1);

    const rebuilt = GpuScene.create(createDevice(new RecordingQueue()), 1).unwrap();
    if (rebuilt.status !== 'available') return;
    expect(rebuilt.scene.rebuild(projection.slotsSnapshot()).unwrap()).toMatchObject({ ranges: 5 });
    expect(rebuilt.scene.inspect()).toMatchObject({ capacity: 4, fullRebuilds: 1 });
  });

  it('resets previous transform when a slot generation is recreated', () => {
    const queue = new RecordingQueue();
    const created = GpuScene.create(createDevice(queue), 1).unwrap();
    if (created.status !== 'available') return;
    const projection = new RenderScene();
    created.scene.sync(projection.apply([{ kind: 'create', snapshot: snapshot(1, 2) }])).unwrap();

    created.scene
      .sync(
        projection.apply([
          { kind: 'remove', worldId: 0, entityKey: 1 },
          { kind: 'create', snapshot: snapshot(1, 9) },
        ]),
      )
      .unwrap();

    const transformWrite = queue.writes.at(-3);
    expect(transformWrite).toBeDefined();
    if (transformWrite === undefined) return;
    const previousTranslation =
      gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'previousWorld') + 12 * 4;
    expect(new DataView(transformWrite.bytes.buffer).getFloat32(previousTranslation, true)).toBe(9);
  });
});
