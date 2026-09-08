import type { Buffer, Result, RhiDevice } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import {
  GPU_SCENE_LAYOUTS,
  type GpuSceneTableLayout,
  gpuSceneFieldOffset,
} from './gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
} from './gpu-usage';
import type { GpuSceneInspection } from './inspection-types';
import type { RenderSceneApplyResult, RenderSceneSlot } from './scene/render-scene-types';

export type { GpuSceneInspection } from './inspection-types';

const PRIMITIVE = GPU_SCENE_LAYOUTS.primitive;
const INSTANCE = GPU_SCENE_LAYOUTS.instance;
const TRANSFORM = GPU_SCENE_LAYOUTS.transform;
const DRAW_TEMPLATE = GPU_SCENE_LAYOUTS.drawTemplate;
const MATERIAL = GPU_SCENE_LAYOUTS.material;
const PRIMITIVE_ACTIVE = 1;
const PRIMITIVE_HAS_BOUNDS = 2;
const PRIMITIVE_GPU_DRIVEN = 4;
const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

interface GpuSceneBuffers {
  readonly primitive: Buffer;
  readonly instance: Buffer;
  readonly transform: Buffer;
  readonly drawTemplate: Buffer;
  readonly material: Buffer;
}

interface PrimitiveAllocation {
  readonly instanceStart: number;
  readonly instanceCount: number;
  readonly transformStart: number;
  readonly drawStart: number;
  readonly drawCount: number;
  readonly materialStart: number;
  readonly materialCount: number;
}

class StableRangeAllocator {
  private next = 0;
  private readonly free: Array<{ start: number; count: number }> = [];

  allocate(count: number): number {
    const freeIndex = this.free.findIndex((range) => range.count >= count);
    if (freeIndex >= 0) {
      const range = this.free[freeIndex];
      if (range === undefined) throw new RangeError('free range disappeared');
      const start = range.start;
      if (range.count === count) this.free.splice(freeIndex, 1);
      else this.free[freeIndex] = { start: range.start + count, count: range.count - count };
      return start;
    }
    const start = this.next;
    this.next += count;
    return start;
  }

  release(start: number, count: number): void {
    if (count <= 0) return;
    this.free.push({ start, count });
    this.free.sort((left, right) => left.start - right.start);
    for (let index = this.free.length - 1; index > 0; index -= 1) {
      const current = this.free[index];
      const previous = this.free[index - 1];
      if (
        current === undefined ||
        previous === undefined ||
        previous.start + previous.count !== current.start
      ) {
        continue;
      }
      this.free[index - 1] = { start: previous.start, count: previous.count + current.count };
      this.free.splice(index, 1);
    }
  }

  requiredCapacity(): number {
    return this.next;
  }

  reset(): void {
    this.next = 0;
    this.free.length = 0;
  }
}

type GpuSceneTableName = keyof GpuSceneBuffers;

const TABLE_LAYOUTS = {
  primitive: PRIMITIVE,
  instance: INSTANCE,
  transform: TRANSFORM,
  drawTemplate: DRAW_TEMPLATE,
  material: MATERIAL,
} as const satisfies Readonly<Record<GpuSceneTableName, GpuSceneTableLayout>>;

const TABLE_NAMES = Object.keys(TABLE_LAYOUTS) as readonly GpuSceneTableName[];

export interface GpuSceneSyncResult {
  readonly ranges: number;
  readonly bytes: number;
  readonly grew: boolean;
  readonly cleared: number;
}

export type GpuSceneAvailability =
  | { readonly status: 'available'; readonly scene: GpuScene }
  | { readonly status: 'unavailable'; readonly reason: 'storage-buffer-unavailable' };

function createBuffers(device: RhiDevice, capacity: number): Result<GpuSceneBuffers, RhiError> {
  const usage = GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC;
  const created: Partial<Record<GpuSceneTableName, Buffer>> = {};
  for (const name of TABLE_NAMES) {
    const result = device.createBuffer({
      label: `gpu-scene-${name}-table`,
      size: capacity * TABLE_LAYOUTS[name].stride,
      usage,
      mappedAtCreation: false,
    });
    if (!result.ok) {
      for (const buffer of Object.values(created)) device.destroyBuffer(buffer);
      return result;
    }
    created[name] = result.value;
  }
  const { primitive, instance, transform, drawTemplate, material } = created;
  if (
    primitive === undefined ||
    instance === undefined ||
    transform === undefined ||
    drawTemplate === undefined ||
    material === undefined
  ) {
    return err(
      new RhiError({
        code: 'internal-error',
        expected: 'GPU scene creates one buffer for every table',
        hint: 'rebuild the renderer after inspecting the device resource failure',
      }),
    );
  }
  return ok({ primitive, instance, transform, drawTemplate, material });
}

function writeMat4(view: DataView, byteOffset: number, value: Float32Array): void {
  for (let lane = 0; lane < 16; lane += 1) {
    view.setFloat32(byteOffset + lane * 4, value[lane] ?? 0, true);
  }
}

function writeVec4(view: DataView, byteOffset: number, values: readonly number[]): void {
  for (let lane = 0; lane < 4; lane += 1) {
    view.setFloat32(byteOffset + lane * 4, values[lane] ?? 0, true);
  }
}

function offset(layout: GpuSceneTableLayout, field: string): number {
  return gpuSceneFieldOffset(layout, field);
}

function stableU32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function coalesceSlots(
  slots: readonly number[],
): readonly { readonly start: number; readonly end: number }[] {
  const ordered = [...new Set(slots)].sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const slot of ordered) {
    const previous = ranges.at(-1);
    if (previous !== undefined && previous.end === slot) {
      previous.end = slot + 1;
    } else {
      ranges.push({ start: slot, end: slot + 1 });
    }
  }
  return ranges;
}

/** Persistent GPU tables derived only from renderer projection slots. */
export class GpuScene {
  private tableBytes: Record<GpuSceneTableName, ArrayBuffer>;
  private buffers: GpuSceneBuffers;
  private uploadRanges = 0;
  private uploadBytes = 0;
  private capacityGrows = 0;
  private fullRebuilds = 0;
  private clearedSlots = 0;
  private noChangeFrames = 0;
  private readonly allocations = new Map<number, PrimitiveAllocation>();
  private readonly instances = new StableRangeAllocator();
  private readonly transforms = new StableRangeAllocator();
  private readonly draws = new StableRangeAllocator();
  private readonly materials = new StableRangeAllocator();

  private constructor(
    private readonly device: RhiDevice,
    private capacity: number,
    buffers: GpuSceneBuffers,
  ) {
    this.buffers = buffers;
    this.tableBytes = this.allocateCpuTables(capacity);
  }

  static create(device: RhiDevice, initialCapacity = 256): Result<GpuSceneAvailability, RhiError> {
    if (!device.caps.storageBuffer) {
      return ok({ status: 'unavailable', reason: 'storage-buffer-unavailable' });
    }
    const requestedCapacity = Number.isFinite(initialCapacity)
      ? Math.max(1, Math.ceil(initialCapacity))
      : 256;
    const capacity = 2 ** Math.ceil(Math.log2(requestedCapacity));
    const buffers = createBuffers(device, capacity);
    if (!buffers.ok) return err(buffers.error);
    return ok({ status: 'available', scene: new GpuScene(device, capacity, buffers.value) });
  }

  get primitiveBuffer(): Buffer {
    return this.buffers.primitive;
  }

  get instanceBuffer(): Buffer {
    return this.buffers.instance;
  }

  get transformBuffer(): Buffer {
    return this.buffers.transform;
  }

  get drawTemplateBuffer(): Buffer {
    return this.buffers.drawTemplate;
  }

  get materialBuffer(): Buffer {
    return this.buffers.material;
  }

  sync(delta: RenderSceneApplyResult): Result<GpuSceneSyncResult, RhiError> {
    const writes = [...delta.createdSlots, ...delta.updatedSlots, ...delta.recreatedSlots];
    const changedSlots = [
      ...writes.map((record) => record.slot),
      ...delta.removedSlots.map((r) => r.slot),
    ];
    if (changedSlots.length === 0) {
      this.noChangeFrames += 1;
      return ok({ ranges: 0, bytes: 0, grew: false, cleared: 0 });
    }
    const writesByTable: Record<GpuSceneTableName, number[]> = {
      primitive: [],
      instance: [],
      transform: [],
      drawTemplate: [],
      material: [],
    };
    for (const record of writes) this.ensureAllocation(record, writesByTable);
    const requiredCapacity = Math.max(
      Math.max(...changedSlots) + 1,
      this.instances.requiredCapacity(),
      this.transforms.requiredCapacity(),
      this.draws.requiredCapacity(),
      this.materials.requiredCapacity(),
    );
    const grew = requiredCapacity > this.capacity;
    if (grew) {
      const grown = this.grow(requiredCapacity);
      if (!grown.ok) return grown;
    }

    for (const record of delta.createdSlots) this.writeSlot(record, true, writesByTable);
    for (const record of delta.updatedSlots) this.writeSlot(record, false, writesByTable);
    for (const record of delta.recreatedSlots) this.writeSlot(record, true, writesByTable);
    for (const record of delta.removedSlots) this.clearSlot(record.slot, writesByTable);
    const uploaded = this.uploadRows(writesByTable);
    if (!uploaded.ok) return uploaded;
    this.clearedSlots += delta.removedSlots.length;
    return ok({
      ranges: uploaded.value.ranges,
      bytes: uploaded.value.bytes,
      grew,
      cleared: delta.removedSlots.length,
    });
  }

  rebuild(slots: readonly RenderSceneSlot[]): Result<GpuSceneSyncResult, RhiError> {
    this.allocations.clear();
    this.instances.reset();
    this.transforms.reset();
    this.draws.reset();
    this.materials.reset();
    const writesByTable: Record<GpuSceneTableName, number[]> = {
      primitive: [],
      instance: [],
      transform: [],
      drawTemplate: [],
      material: [],
    };
    for (const slot of slots) this.ensureAllocation(slot, writesByTable);
    const highestSlot = slots.reduce((maximum, slot) => Math.max(maximum, slot.slot), -1);
    const requiredCapacity = Math.max(
      highestSlot + 1,
      this.instances.requiredCapacity(),
      this.transforms.requiredCapacity(),
      this.draws.requiredCapacity(),
      this.materials.requiredCapacity(),
    );
    let grew = false;
    if (requiredCapacity > this.capacity) {
      const grown = this.grow(requiredCapacity);
      if (!grown.ok) return grown;
      grew = true;
    }
    for (const bytes of Object.values(this.tableBytes)) new Uint8Array(bytes).fill(0);
    for (const slot of slots) this.writeSlot(slot, true, writesByTable);
    let bytes = 0;
    for (const name of TABLE_NAMES) {
      const table = this.tableBytes[name];
      const write = this.device.queue.writeBuffer(this.buffers[name], 0, new Uint8Array(table));
      if (!write.ok) return write;
      bytes += table.byteLength;
    }
    this.uploadRanges += TABLE_NAMES.length;
    this.uploadBytes += bytes;
    this.fullRebuilds += 1;
    return ok({ ranges: TABLE_NAMES.length, bytes, grew, cleared: 0 });
  }

  inspect(): GpuSceneInspection {
    return {
      capacity: this.capacity,
      tables: {
        primitive: {
          capacity: this.capacity,
          bytes: this.tableBytes.primitive.byteLength,
        },
        instance: {
          capacity: this.capacity,
          bytes: this.tableBytes.instance.byteLength,
        },
        transform: {
          capacity: this.capacity,
          bytes: this.tableBytes.transform.byteLength,
        },
        drawTemplate: {
          capacity: this.capacity,
          bytes: this.tableBytes.drawTemplate.byteLength,
        },
        material: {
          capacity: this.capacity,
          bytes: this.tableBytes.material.byteLength,
        },
      },
      uploadRanges: this.uploadRanges,
      uploadBytes: this.uploadBytes,
      capacityGrows: this.capacityGrows,
      fullRebuilds: this.fullRebuilds,
      clearedSlots: this.clearedSlots,
      noChangeFrames: this.noChangeFrames,
    };
  }

  dispose(): void {
    for (const buffer of Object.values(this.buffers)) this.device.destroyBuffer(buffer);
  }

  private writeSlot(
    record: RenderSceneSlot,
    resetPrevious: boolean,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const allocation = this.allocations.get(record.slot);
    if (allocation === undefined) throw new RangeError('GPU Scene allocation unavailable');
    const primitiveOffset = record.slot * PRIMITIVE.stride;
    const primitive = new DataView(this.tableBytes.primitive);
    const bounds = record.snapshot.localAabb;
    primitive.setUint32(primitiveOffset + offset(PRIMITIVE, 'generation'), record.generation, true);
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'flags'),
      PRIMITIVE_ACTIVE |
        (bounds === undefined ? 0 : PRIMITIVE_HAS_BOUNDS) |
        (record.snapshot.gpuDrivenDraws === undefined ? 0 : PRIMITIVE_GPU_DRIVEN),
      true,
    );
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'transformIndex'),
      allocation.transformStart,
      true,
    );
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'materialIndex'),
      allocation.materialStart,
      true,
    );
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'drawTemplateIndex'),
      allocation.drawStart,
      true,
    );
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'instanceStart'),
      allocation.instanceStart,
      true,
    );
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'instanceCount'),
      allocation.instanceCount,
      true,
    );
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'assetHandle'),
      record.snapshot.assetHandle,
      true,
    );
    writeVec4(primitive, primitiveOffset + offset(PRIMITIVE, 'localBoundsMin'), [
      bounds?.[0] ?? 0,
      bounds?.[1] ?? 0,
      bounds?.[2] ?? 0,
      0,
    ]);
    writeVec4(primitive, primitiveOffset + offset(PRIMITIVE, 'localBoundsMax'), [
      bounds?.[3] ?? 0,
      bounds?.[4] ?? 0,
      bounds?.[5] ?? 0,
      0,
    ]);

    const instance = new DataView(this.tableBytes.instance);
    const transform = new DataView(this.tableBytes.transform);
    for (let ordinal = 0; ordinal < allocation.instanceCount; ordinal += 1) {
      const instanceIndex = allocation.instanceStart + ordinal;
      const instanceOffset = instanceIndex * INSTANCE.stride;
      const transformIndex = allocation.transformStart + 1 + ordinal;
      instance.setUint32(instanceOffset + offset(INSTANCE, 'primitiveIndex'), record.slot, true);
      instance.setUint32(instanceOffset + offset(INSTANCE, 'transformIndex'), transformIndex, true);
      instance.setUint32(instanceOffset + offset(INSTANCE, 'customDataStart'), 0, true);
      instance.setUint32(instanceOffset + offset(INSTANCE, 'flags'), PRIMITIVE_ACTIVE, true);
      const local = record.snapshot.instances?.transforms.subarray(ordinal * 16, ordinal * 16 + 16);
      const localWorld = local?.length === 16 ? local : IDENTITY_MATRIX;
      const localOffset = transformIndex * TRANSFORM.stride;
      const localCurrentOffset = localOffset + offset(TRANSFORM, 'currentWorld');
      const localPreviousOffset = localOffset + offset(TRANSFORM, 'previousWorld');
      const priorLocal = new Uint8Array(
        this.tableBytes.transform.slice(localCurrentOffset, localCurrentOffset + 64),
      );
      writeMat4(transform, localCurrentOffset, localWorld);
      if (!resetPrevious && priorLocal.some((value) => value !== 0)) {
        new Uint8Array(this.tableBytes.transform, localPreviousOffset, 64).set(priorLocal);
      } else {
        writeMat4(transform, localPreviousOffset, localWorld);
      }
      writes.instance.push(instanceIndex);
      writes.transform.push(transformIndex);
    }

    const transformOffset = allocation.transformStart * TRANSFORM.stride;
    const currentOffset = transformOffset + offset(TRANSFORM, 'currentWorld');
    const previousOffset = transformOffset + offset(TRANSFORM, 'previousWorld');
    const priorCurrent = new Uint8Array(
      this.tableBytes.transform.slice(currentOffset, currentOffset + 64),
    );
    const hasPrior = !resetPrevious && priorCurrent.some((value) => value !== 0);
    writeMat4(transform, currentOffset, record.snapshot.transform.world);
    if (hasPrior) new Uint8Array(this.tableBytes.transform, previousOffset, 64).set(priorCurrent);
    else writeMat4(transform, previousOffset, record.snapshot.transform.world);
    writes.primitive.push(record.slot);
    writes.transform.push(allocation.transformStart);

    const draw = new DataView(this.tableBytes.drawTemplate);
    const drawSnapshots = record.snapshot.gpuDrivenDraws ?? [];
    for (let ordinal = 0; ordinal < allocation.drawCount; ordinal += 1) {
      const drawIndex = allocation.drawStart + ordinal;
      const drawOffset = drawIndex * DRAW_TEMPLATE.stride;
      const drawSnapshot = drawSnapshots[ordinal];
      draw.setUint32(
        drawOffset + offset(DRAW_TEMPLATE, 'pipelineClass'),
        drawSnapshot === undefined ? 0 : stableU32(drawSnapshot.pipelineClass),
        true,
      );
      draw.setUint32(
        drawOffset + offset(DRAW_TEMPLATE, 'materialIndex'),
        allocation.materialStart + (drawSnapshot?.materialSlot ?? 0),
        true,
      );
      draw.setUint32(
        drawOffset + offset(DRAW_TEMPLATE, 'firstIndex'),
        drawSnapshot?.first ?? 0,
        true,
      );
      draw.setUint32(
        drawOffset + offset(DRAW_TEMPLATE, 'indexCount'),
        drawSnapshot?.count ?? 0,
        true,
      );
      draw.setInt32(
        drawOffset + offset(DRAW_TEMPLATE, 'baseVertex'),
        drawSnapshot?.baseVertex ?? 0,
        true,
      );
      draw.setUint32(drawOffset + offset(DRAW_TEMPLATE, 'firstInstance'), 0, true);
      draw.setUint32(drawOffset + offset(DRAW_TEMPLATE, 'passFlags'), 0, true);
      draw.setUint32(drawOffset + offset(DRAW_TEMPLATE, 'reserved'), 0, true);
      writes.drawTemplate.push(drawIndex);
    }

    const material = new DataView(this.tableBytes.material);
    for (let ordinal = 0; ordinal < allocation.materialCount; ordinal += 1) {
      const materialIndex = allocation.materialStart + ordinal;
      const materialOffset = materialIndex * MATERIAL.stride;
      const snapshot = record.snapshot.materials[ordinal] ?? record.snapshot.material;
      writeVec4(material, materialOffset + offset(MATERIAL, 'params0'), [
        snapshot.baseColor?.[0] ?? 0,
        snapshot.baseColor?.[1] ?? 0,
        snapshot.baseColor?.[2] ?? 0,
        1,
      ]);
      writeVec4(material, materialOffset + offset(MATERIAL, 'params1'), [
        snapshot.metallic ?? 0,
        snapshot.roughness ?? 1,
        snapshot.clearcoat ?? 0,
        snapshot.clearcoatRoughness ?? 0,
      ]);
      writeVec4(material, materialOffset + offset(MATERIAL, 'params2'), [
        snapshot.emissive?.[0] ?? 0,
        snapshot.emissive?.[1] ?? 0,
        snapshot.emissive?.[2] ?? 0,
        snapshot.emissiveIntensity ?? 0,
      ]);
      writeVec4(material, materialOffset + offset(MATERIAL, 'params3'), [
        snapshot.normalScale ?? 1,
        snapshot.occlusionStrength ?? 1,
        0,
        0,
      ]);
      material.setUint32(
        materialOffset + offset(MATERIAL, 'resource0'),
        snapshot.baseColorTexture ?? 0,
        true,
      );
      material.setUint32(
        materialOffset + offset(MATERIAL, 'resource1'),
        snapshot.metallicRoughnessTexture ?? 0,
        true,
      );
      material.setUint32(
        materialOffset + offset(MATERIAL, 'resource2'),
        snapshot.normalTexture ?? 0,
        true,
      );
      material.setUint32(
        materialOffset + offset(MATERIAL, 'resource3'),
        snapshot.emissiveTexture ?? 0,
        true,
      );
      writes.material.push(materialIndex);
    }
  }

  private clearSlot(slot: number, writes: Record<GpuSceneTableName, number[]>): void {
    for (const name of ['primitive'] as const) {
      const layout = TABLE_LAYOUTS[name];
      new Uint8Array(this.tableBytes[name], slot * layout.stride, layout.stride).fill(0);
      writes[name].push(slot);
    }
    const allocation = this.allocations.get(slot);
    if (allocation === undefined) return;
    this.clearAllocation(allocation, writes);
    this.allocations.delete(slot);
  }

  private uploadRows(
    rows: Readonly<Record<GpuSceneTableName, readonly number[]>>,
  ): Result<{ readonly ranges: number; readonly bytes: number }, RhiError> {
    let rangeCount = 0;
    let bytes = 0;
    for (const name of TABLE_NAMES) {
      const ranges = coalesceSlots(rows[name]);
      rangeCount += ranges.length;
      for (const range of ranges) {
        const layout = TABLE_LAYOUTS[name];
        const tableOffset = range.start * layout.stride;
        const tableSize = (range.end - range.start) * layout.stride;
        const write = this.device.queue.writeBuffer(
          this.buffers[name],
          tableOffset,
          new Uint8Array(this.tableBytes[name], tableOffset, tableSize),
        );
        if (!write.ok) return write;
        bytes += tableSize;
      }
    }
    this.uploadRanges += rangeCount;
    this.uploadBytes += bytes;
    return ok({ ranges: rangeCount, bytes });
  }

  private ensureAllocation(
    record: RenderSceneSlot,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const instanceCount = Math.max(1, record.snapshot.instances?.instanceCount ?? 1);
    const drawCount = Math.max(1, record.snapshot.gpuDrivenDraws?.length ?? 0);
    const materialCount = Math.max(1, record.snapshot.materials.length);
    const existing = this.allocations.get(record.slot);
    if (
      existing?.instanceCount === instanceCount &&
      existing.drawCount === drawCount &&
      existing.materialCount === materialCount
    ) {
      return;
    }
    if (existing !== undefined) this.clearAllocation(existing, writes);
    const allocation = {
      instanceStart: this.instances.allocate(instanceCount),
      instanceCount,
      transformStart: this.transforms.allocate(instanceCount + 1),
      drawStart: this.draws.allocate(drawCount),
      drawCount,
      materialStart: this.materials.allocate(materialCount),
      materialCount,
    };
    this.allocations.set(record.slot, allocation);
  }

  private clearAllocation(
    allocation: PrimitiveAllocation,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    for (let ordinal = 0; ordinal < allocation.instanceCount; ordinal += 1) {
      const instanceIndex = allocation.instanceStart + ordinal;
      new Uint8Array(
        this.tableBytes.instance,
        instanceIndex * INSTANCE.stride,
        INSTANCE.stride,
      ).fill(0);
      writes.instance.push(instanceIndex);
    }
    for (let ordinal = 0; ordinal <= allocation.instanceCount; ordinal += 1) {
      const transformIndex = allocation.transformStart + ordinal;
      new Uint8Array(
        this.tableBytes.transform,
        transformIndex * TRANSFORM.stride,
        TRANSFORM.stride,
      ).fill(0);
      writes.transform.push(transformIndex);
    }
    for (let ordinal = 0; ordinal < allocation.drawCount; ordinal += 1) {
      const drawIndex = allocation.drawStart + ordinal;
      new Uint8Array(
        this.tableBytes.drawTemplate,
        drawIndex * DRAW_TEMPLATE.stride,
        DRAW_TEMPLATE.stride,
      ).fill(0);
      writes.drawTemplate.push(drawIndex);
    }
    for (let ordinal = 0; ordinal < allocation.materialCount; ordinal += 1) {
      const materialIndex = allocation.materialStart + ordinal;
      new Uint8Array(
        this.tableBytes.material,
        materialIndex * MATERIAL.stride,
        MATERIAL.stride,
      ).fill(0);
      writes.material.push(materialIndex);
    }
    this.instances.release(allocation.instanceStart, allocation.instanceCount);
    this.transforms.release(allocation.transformStart, allocation.instanceCount + 1);
    this.draws.release(allocation.drawStart, allocation.drawCount);
    this.materials.release(allocation.materialStart, allocation.materialCount);
  }

  private grow(requiredCapacity: number): Result<void, RhiError> {
    let nextCapacity = this.capacity;
    while (nextCapacity < requiredCapacity) nextCapacity *= 2;
    const nextBuffers = createBuffers(this.device, nextCapacity);
    if (!nextBuffers.ok) return err(nextBuffers.error);
    const nextTables = this.allocateCpuTables(nextCapacity);
    for (const name of TABLE_NAMES) {
      new Uint8Array(nextTables[name]).set(new Uint8Array(this.tableBytes[name]));
      const write = this.device.queue.writeBuffer(
        nextBuffers.value[name],
        0,
        new Uint8Array(nextTables[name]),
      );
      if (!write.ok) {
        for (const buffer of Object.values(nextBuffers.value)) this.device.destroyBuffer(buffer);
        return write;
      }
    }
    for (const buffer of Object.values(this.buffers)) this.device.destroyBuffer(buffer);
    this.buffers = nextBuffers.value;
    this.tableBytes = nextTables;
    this.capacity = nextCapacity;
    this.capacityGrows += 1;
    this.uploadRanges += TABLE_NAMES.length;
    this.uploadBytes += Object.values(nextTables).reduce(
      (total, bytes) => total + bytes.byteLength,
      0,
    );
    return ok(undefined);
  }

  private allocateCpuTables(capacity: number): Record<GpuSceneTableName, ArrayBuffer> {
    return {
      primitive: new ArrayBuffer(capacity * PRIMITIVE.stride),
      instance: new ArrayBuffer(capacity * INSTANCE.stride),
      transform: new ArrayBuffer(capacity * TRANSFORM.stride),
      drawTemplate: new ArrayBuffer(capacity * DRAW_TEMPLATE.stride),
      material: new ArrayBuffer(capacity * MATERIAL.stride),
    };
  }
}
