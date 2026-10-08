import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import {
  CARD_LOOKUP_STRIDE,
  CardLookupStatus,
  createSdfCardLookup,
} from '../../raytracing/card-lookup';
import { createSdfQuery } from '../../raytracing/sdf-query';
import {
  CARD_PLANES,
  createSurfaceCapture,
  type SurfaceCardSource,
  surfaceCardKey,
} from '../../raytracing/surface-cards';
import { readBuffer } from './path-tracer.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { half, readCardPlanes, sdfCubeInstance } from './sdf-cards.fixture';

/** Whole-mesh geometry and per-section material draws must share card depth and identity. */
export async function verifyMultiMaterialCards(fixture: SdfCardsFixture) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = webgpu._internal_getRawDevice(
    (device as typeof device & { _realDevice: typeof device })._realDevice,
  );
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const compile = recorder.backend.createShaderModule;
  const material = (id: number, color: number[]) => ({
    id,
    ...fixture.card,
    asset: { ...fixture.card.asset, values: { ...fixture.card.asset.values, baseColor: color } },
  });
  const red = material(10, [1, 0, 0, 1]),
    blue = material(20, [0, 0, 1, 1]);
  const source: SurfaceCardSource = {
    instance: { ...sdfCubeInstance, ...fixture.layers.geometry, uvSets: [] },
    layout: fixture.layers.layout,
    sections: [
      { indexOffset: 0, indexCount: 6, material: red },
      { indexOffset: 6, indexCount: 6, material: blue },
    ],
  };
  const evidence: {
    tape: Uint8Array;
    planes: Uint8Array[];
    works: number;
    rasterWorks: number;
    colors: number[][];
    buffers: { work: number; binding: number; bytes: Uint8Array }[];
  }[] = [];
  try {
    // Near red first, far blue second: a broken shared depth path would incorrectly turn blue.
    // A zero-mask section is not an omission mechanism: actual source geometry removal recooks.
    for (const current of [
      source,
      {
        ...source,
        instance: { ...source.instance, indices: fixture.layers.geometry.indices.slice(6) },
        layout: fixture.layers.backLayout,
        sections: [{ indexOffset: 0, indexCount: 6, material: blue }],
      },
    ]) {
      const cards = (await createSurfaceCapture(device, compile, [current])).unwrap();
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const encoder = device.createCommandEncoder({}).unwrap();
      cards.record(encoder).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      (await recorder.frameBoundary()).unwrap();
      const tape = (await pending).unwrap().bytes,
        planes = await readCardPlanes(device, cards);
      const albedo = planes[0],
        validity = planes[3];
      assert(albedo && validity);
      const expected = current === source ? [1, 0, 0] : [0, 0, 1];
      for (let pixel = 0; pixel < cards.width * cards.height; pixel++) {
        for (let c = 0; c < 3; c++) expect(half(albedo, pixel * 8 + c * 2)).toBe(expected[c]);
        expect(half(validity, pixel * 8 + 6)).toBe(1);
      }
      cards.dispose();
      const model = buildFrameModel(decodeTape(tape).unwrap());
      expect(model.works).toHaveLength(current.sections.length);
      expect(model.unseededResources).toEqual([]);
      evidence.push({
        tape,
        planes,
        works: model.works.length,
        rasterWorks: model.works.length,
        colors: [],
        buffers: [],
      });
    }
    // Six differently assigned face ranges enclose one field. Material does not own SDF identity.
    const cube: SurfaceCardSource = {
      instance: sdfCubeInstance,
      layout: fixture.layout,
      sections: Array.from({ length: 6 }, (_, face) => ({
        indexOffset: face * 6,
        indexCount: 6,
        material: face % 2 ? red : blue,
      })),
    };
    const query = (
      await createSdfQuery(
        device,
        compile,
        [
          {
            ...sdfCubeInstance,
            field: {
              ...fixture.field,
              bricks: Uint32Array.from(fixture.field.bricks),
              values: Float32Array.from(fixture.field.values),
            },
          },
        ],
        [{ origin: [0, 0, 3], direction: [0, 0, -1], tMin: 0, tMax: 20, mask: 255 }],
      )
    ).unwrap();
    const cards = (await createSurfaceCapture(device, compile, [cube])).unwrap();
    expect(cards.entries).toHaveLength(1);
    expect(cards.entries[0]?.geometryKey).toBe(query.sources[0]?.key);
    const changed: SurfaceCardSource = {
      ...cube,
      sections: cube.sections.map((s) => ({
        ...s,
        material: material(s.material.id, [0, 1, 0, 1]),
      })),
    };
    expect(surfaceCardKey(changed)).not.toBe(surfaceCardKey(cube));
    const lookup = (await createSdfCardLookup(device, compile, query, cards, [cube])).unwrap();
    const stale = (await createSdfCardLookup(device, compile, query, cards, [changed])).unwrap();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    cards.record(encoder).unwrap();
    query.record(encoder).unwrap();
    lookup.record(encoder).unwrap();
    stale.record(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    const tape = (await pending).unwrap().bytes;
    const hits = await readBuffer(device, query.buffers.hits, 64),
      mapped = await readBuffer(device, lookup.buffer, CARD_LOOKUP_STRIDE),
      rejected = await readBuffer(device, stale.buffer, CARD_LOOKUP_STRIDE),
      planes = await readCardPlanes(device, cards);
    expect(Array.from(new Uint32Array(hits.buffer).slice(0, 4))).toEqual([1, 7, 9, 0xffffffff]);
    expect(new Uint32Array(mapped.buffer)[0]).toBe(CardLookupStatus.mapped);
    expect(Array.from(new Float32Array(mapped.buffer).slice(4, 7))).toEqual([1, 0, 0]);
    expect(new Uint32Array(rejected.buffer)[0]).toBe(CardLookupStatus.stale);
    const model = buildFrameModel(decodeTape(tape).unwrap());
    expect(model.works).toHaveLength(39);
    expect(model.unseededResources).toEqual([]);
    evidence.push({
      tape,
      planes,
      works: 39,
      rasterWorks: 36,
      colors: [],
      buffers: [
        { work: 36, binding: 3, bytes: hits },
        { work: 37, binding: 2, bytes: mapped },
        { work: 38, binding: 2, bytes: rejected },
      ],
    });
    stale.dispose();
    lookup.dispose();
    query.dispose();
    cards.dispose();
    (await recorder.dispose()).unwrap();
    for (const capture of evidence) {
      const tape = decodeTape(capture.tape).unwrap(),
        model = buildFrameModel(tape);
      const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const freshRaw = webgpu._internal_getRawDevice(fresh);
      assert(freshRaw);
      freshRaw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const replay = (
        await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      try {
        for (const work of capture.buffers.length ? [] : model.works) {
          const color = work.attachments?.colorViewHandleIds[0];
          assert(color);
          const bytes = (await replay.readResourceAtWork(color, work.workIndex)).unwrap().bytes;
          capture.colors.push([half(bytes, 0), half(bytes, 2), half(bytes, 4)]);
          expect(bytes).toEqual(capture.planes[0]);
        }
        for (const i of CARD_PLANES.keys()) {
          const resource = model.works[capture.rasterWorks - 1]?.attachments?.colorViewHandleIds[i];
          assert(resource);
          expect(
            (await replay.readResourceAtWork(resource, capture.rasterWorks - 1)).unwrap().bytes,
          ).toEqual(capture.planes[i]);
        }
        for (const read of capture.buffers) {
          const resource = model.works[read.work]?.bindings.find(
            (b) => b.binding === read.binding,
          )?.resourceId;
          assert(resource);
          expect((await replay.readResourceAtWork(resource, read.work)).unwrap().bytes).toEqual(
            read.bytes,
          );
        }
      } finally {
        (await replay.dispose()).unwrap();
        freshRaw.destroy();
      }
    }
    expect(errors).toEqual([]);
    return evidence;
  } finally {
    raw.destroy();
  }
}
