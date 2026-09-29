import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  Outline,
  type Renderer,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  encodeTape,
  halfToFloat,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';

type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;
function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}
function counts(pixels: readonly number[]) {
  let visible = 0;
  let hidden = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i] ?? 0) > 0.8 && (pixels[i + 1] ?? 0) < 0.1) visible++;
    if ((pixels[i + 1] ?? 0) > 0.8 && (pixels[i] ?? 0) < 0.1) hidden++;
  }
  return { visible, hidden };
}
export async function verifyOutline(renderer: Renderer, recorder: RecorderAttachment, save: Save) {
  const world = new World();
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const material = world.allocSharedRef('MaterialAsset', Materials.unlit([0.15, 0.15, 0.15, 1]));
  const box = (x: number, z: number, scale: readonly [number, number, number]) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, z], scale } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  const selected = box(0, 0, [1.4, 1.4, 0.3]);
  const other = box(-1.3, 0, [0.3, 0.3, 0.3]);
  const occluder = box(0.6, 0.7, [1.1, 2, 0.3]);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          aspect: 1,
          fov: Math.PI / 3,
          near: 0.1,
          far: 30,
          antialias: 0,
          tonemap: 0,
          clearColor: [0.02, 0.02, 0.02, 1],
        },
      },
      {
        component: Outline,
        data: {
          entities: [selected],
          visibleColor: [1, 0, 0],
          hiddenColor: [0, 1, 0],
          width: 2,
          occlusion: 2,
        },
      },
    )
    .unwrap();
  const lease = value(renderer.attach(world));
  const draw = async () => {
    propagateTransforms(world);
    world.update(1 / 60).unwrap();
    const receipt = value(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    value(await receipt.completed);
    return receipt;
  };
  const observe = async (name: string) => {
    if (renderer.requestObservation === undefined) throw new Error('observation unavailable');
    const include = ['final-srgb', 'linear-ldr'] as const;
    value(renderer.requestObservation(include));
    const receipt = await draw();
    const observations = value(await renderer.observe(receipt, { include })).observations;
    const observation = observations?.find((item) => item.domain === 'final-srgb');
    const linear = observations?.find((item) => item.domain === 'linear-ldr');
    if (observation === undefined) throw new Error('missing final-srgb observation');
    const { width, height, bytesPerRow, format } = observation.metadata;
    const pixels: number[] = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * bytesPerRow + x * 4;
        const p = Array.from(observation.bytes.subarray(i, i + 4), (n) => n / 255);
        if (format.startsWith('bgra')) [p[0], p[2]] = [p[2] ?? 0, p[0] ?? 0];
        pixels.push(...p);
      }
    await save(
      `${name}.rgba`,
      Uint8Array.from(pixels, (n) => Math.round(n * 255)),
    );
    const linearPixels: number[] = [];
    if (linear !== undefined) {
      const view = new DataView(
        linear.bytes.buffer,
        linear.bytes.byteOffset,
        linear.bytes.byteLength,
      );
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width * 4; x++)
          linearPixels.push(
            halfToFloat(view.getUint16(y * linear.metadata.bytesPerRow + x * 2, true)),
          );
    }
    return { pixels, linearPixels, counts: counts(pixels) };
  };
  const reports: unknown[] = [];
  try {
    for (let i = 0; i < 3; i++) await draw();
    const both = await observe('all');
    expect(both.counts.visible).toBeGreaterThan(30);
    expect(both.counts.hidden).toBeGreaterThan(30);
    world.set(camera, Outline, { entities: [selected, occluder] }).unwrap();
    const union = await observe('union');
    expect(union.counts.visible).toBeGreaterThan(30);
    expect(union.counts.hidden).toBe(0);
    const interior: number[] = [];
    for (let y = 50; y < 75; y++)
      for (let x = 60; x < 85; x++)
        interior.push(...union.pixels.slice((y * 128 + x) * 4, (y * 128 + x + 1) * 4));
    expect(counts(interior)).toEqual({ visible: 0, hidden: 0 });
    world.set(camera, Outline, { entities: [selected] }).unwrap();
    world.set(camera, Outline, { visibleColor: [0, 1, 0], hiddenColor: [1, 0, 0] }).unwrap();
    expect((await observe('colors-swapped')).counts).toEqual({
      visible: both.counts.hidden,
      hidden: both.counts.visible,
    });
    world.set(camera, Outline, { visibleColor: [1, 0, 0], hiddenColor: [0, 1, 0] }).unwrap();
    world.set(camera, Outline, { occlusion: 0 }).unwrap();
    const visible = await observe('visible');
    expect(visible.counts.visible).toBe(both.counts.visible);
    expect(visible.counts.hidden).toBe(0);
    world.set(camera, Outline, { occlusion: 1 }).unwrap();
    const hidden = await observe('hidden');
    expect(hidden.counts.visible).toBe(0);
    expect(hidden.counts.hidden).toBeGreaterThan(30);
    world.set(camera, Outline, { occlusion: 2, width: 4 }).unwrap();
    const wide = await observe('wide');
    expect(wide.counts.visible + wide.counts.hidden).toBeGreaterThan(
      (both.counts.visible + both.counts.hidden) * 1.5,
    );
    world.set(camera, Outline, { entities: [other] }).unwrap();
    const switched = await observe('switched');
    expect(switched.counts.visible).toBeGreaterThan(0);
    expect(switched.counts.hidden).toBe(0);
    const cutout = world.allocSharedRef(
      'MaterialAsset',
      Materials.unlit([0.15, 0.15, 0.15, 0], { alphaCutoff: 0.5 }),
    );
    world.set(other, MeshRenderer, { materials: [cutout] }).unwrap();
    await draw();
    expect((await observe('cutout')).counts).toEqual({ visible: 0, hidden: 0 });
    const pbr = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [0.15, 0.15, 0.15, 1] }),
    );
    world.set(other, MeshRenderer, { materials: [pbr] }).unwrap();
    await draw();
    expect((await observe('pbr')).counts.visible).toBeGreaterThan(0);
    world.set(other, MeshRenderer, { materials: [material] }).unwrap();
    world.set(camera, Outline, { entities: [] }).unwrap();
    const off = await observe('off');
    expect(off.counts).toEqual({ visible: 0, hidden: 0 });
    expect(
      renderer.inspect().perFramePassNames.filter((name) => name.startsWith('outline-')),
    ).toEqual([]);
    world.set(camera, Outline, { entities: [selected, other], width: 2 }).unwrap();
    const restoreCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const restored = await observe('restored');
    (await recorder.frameBoundary()).unwrap();
    await save('restored.rhitape', (await restoreCapture).unwrap().bytes);
    expect(restored.counts.visible).toBeGreaterThan(20);
    for (const aa of [0, 1, 2, 3]) {
      world.set(camera, Camera, { antialias: aa }).unwrap();
      for (let i = 0; i < 60; i++) await draw();
      const actual = await observe(`aa-${aa}`);
      expect(actual.counts.visible).toBeGreaterThan(20);
      expect(actual.counts.hidden).toBeGreaterThan(20);
      reports.push({ aa, ...actual.counts });
    }
    world.set(camera, Camera, { antialias: 0 }).unwrap();
    await draw();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const live = await observe('captured');
    (await recorder.frameBoundary()).unwrap();
    const capture = (await pending).unwrap();
    await save('outline.rhitape', capture.bytes);
    const tape = decodeTape(capture.bytes).unwrap();
    const model = buildFrameModel(tape);
    await save('frame-model.json', new TextEncoder().encode(JSON.stringify(model, null, 2)));
    const work = model.works.find((work) =>
      work.pipeline.shaders.some((shader) => shader.source?.includes('var expanded: texture_2d')),
    );
    if (work === undefined) throw new Error('missing outline composite work');
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      for (const [stage, marker] of [
        ['depth', 'let bits = bitcast<u32>(z)'],
        ['classify', 'let selected = bitcast<f32>'],
        ['horizontal', 'p + vec2<i32>(x, 0)'],
      ] as const) {
        const stageWork = model.works.find((item) =>
          item.pipeline.shaders.some((shader) => shader.source?.includes(marker)),
        );
        if (stageWork === undefined) throw new Error(`missing Outline ${stage} work`);
        const inspected = (
          await replay.inspectWork(stageWork.workIndex, ['pipeline', 'bindings', 'pixels'])
        ).unwrap();
        if (inspected.attachment === undefined) throw new Error(`missing ${stage} attachment`);
        const bytes = inspected.attachment.bytes;
        const values = Array.from(
          new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
          halfToFloat,
        );
        if (stage === 'depth')
          expect(values.filter((_, i) => i % 4 === 0).some((z) => z > 0)).toBe(true);
        else {
          expect(counts(values).visible).toBeGreaterThan(0);
          expect(counts(values).hidden).toBeGreaterThan(0);
        }
        await save(`${stage}.rgba16float`, bytes);
        reports.push({
          stage,
          workIndex: stageWork.workIndex,
          eventIndex: stageWork.eventIndex,
          bindings: inspected.bindings,
        });
      }
      const inspection = (
        await replay.inspectWork(work.workIndex, ['pipeline', 'bindings', 'pixels'])
      ).unwrap();
      const attachment = inspection.attachment;
      if (attachment === undefined) throw new Error('missing outline replay pixels');
      expect(attachment.format).toBe('rgba16float');
      const pixels = Array.from(
        new Uint16Array(
          attachment.bytes.buffer,
          attachment.bytes.byteOffset,
          attachment.bytes.byteLength / 2,
        ),
        halfToFloat,
      );
      expect(counts(pixels)).toEqual(live.counts);
      expect(pixels.length).toBe(live.linearPixels.length);
      const maxLiveError = pixels.reduce(
        (max, p, i) => Math.max(max, Math.abs(p - (live.linearPixels[i] ?? NaN))),
        0,
      );
      expect(maxLiveError).toBeLessThanOrEqual(0.002);
      reports.push({ maxLiveError });
      await save('composite.rgba16float', attachment.bytes);
      reports.push({
        digest: capture.digest,
        workIndex: work.workIndex,
        eventIndex: work.eventIndex,
        unseededResources: model.unseededResources,
        replay: counts(pixels),
      });
    } finally {
      (await replay.dispose()).unwrap();
    }
    // Removing the actual composite draw must remove the outline from the replay result.
    const missing = encodeTape({
      ...tape,
      events: tape.events.map((event, index) =>
        index === work.eventIndex && event.kind === 'draw' ? { ...event, vertexCount: 0 } : event,
      ),
    }).unwrap();
    const falsifier = (
      await openReplay(decodeTape(missing).unwrap(), {
        device,
        createShaderModule: webgpu.createShaderModule,
      })
    ).unwrap();
    try {
      const inspect = (await falsifier.inspectWork(work.workIndex, ['pixels'])).unwrap();
      if (inspect.attachment === undefined) throw new Error('missing falsifier pixels');
      const bytes = inspect.attachment.bytes;
      expect(
        counts(
          Array.from(
            new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
            halfToFloat,
          ),
        ),
      ).toEqual({ visible: 0, hidden: 0 });
    } finally {
      (await falsifier.dispose()).unwrap();
    }
    webgpu._internal_getRawDevice(device)?.destroy();
    expect(errors, JSON.stringify(errors)).toEqual([]);
    await save(
      'report.json',
      new TextEncoder().encode(JSON.stringify({ reports, errors }, null, 2)),
    );
  } catch (error) {
    await save(
      'failure.json',
      new TextEncoder().encode(
        JSON.stringify({ error: String(error), errors, inspection: renderer.inspect() }, null, 2),
      ),
    );
    throw error;
  } finally {
    unsubscribe();
    lease.dispose();
  }
}
