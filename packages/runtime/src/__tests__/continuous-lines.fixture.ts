import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { Camera, Lines, Materials, MeshFilter, MeshRenderer, Points } from '@forgeax/engine-render';
import {
  addTypedOutputTransformPass,
  addTypedScenePass,
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipeline,
} from '@forgeax/engine-render/authoring';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
  replayDeviceRequest,
  tapeDigest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { type MeshAsset, ok } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import threePixels from './continuous-lines-three.json';
import { renderValue } from './standard-gbuffer-replay.fixture';

/** The real retained -> prepare -> Standard scene draw, with no application shader. */
export async function verifyContinuousLines(options: {
  shaderManifestUrl: string;
  save(name: string, bytes: Uint8Array): void | Promise<void>;
}) {
  const errors: unknown[] = [];
  const width = 320;
  let height = 192;
  let surface: GPUTexture | undefined;
  let rawDevice: GPUDevice | undefined;
  const canvas = {
    width,
    height,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        rawDevice = config.device;
        rawDevice.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        surface?.destroy();
        surface = rawDevice.createTexture({
          size: [canvas.width, canvas.height],
          format: config.format,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          usage: 0x11,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => surface,
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const copies: Array<{ buffer: Buffer; device: RhiDevice }> = [];
  let observe = false;
  const stride = Math.ceil((width * 4) / 256) * 256;
  const pipeline: RenderPipeline = {
    build({ graph }, topology) {
      const color = createRenderPipelineTarget(graph, 'continuous-lines-color', {
        format: 'rgba8unorm',
        size: 'surface',
        usage: 0x15,
      }).unwrap();
      const depth = createRenderPipelineTarget(graph, 'continuous-lines-depth', {
        format: 'depth32float-stencil8',
        size: 'surface',
      }).unwrap();
      const scene = addTypedScenePass(graph, {
        name: 'continuous-lines',
        color,
        depth,
        selector: { LightMode: ['Forward'] },
        colorClearValues: [[0, 0, 0, 1]],
      });
      if (!scene.ok) return scene;
      const copied = graph.addCopyPass('continuous-lines-readback', {
        accesses: [{ resource: color.view, usage: 'copy-src' }],
        encode({ encoder, frame, resources }) {
          if (!observe) return;
          const buffer = frame.runtime.device
            .createBuffer({ size: stride * height, usage: 9 })
            .unwrap();
          encoder.copyTextureToBuffer(
            { texture: resources.texture(color.texture).unwrap() },
            { buffer, bytesPerRow: stride, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 },
          );
          copies.push({ buffer, device: frame.runtime.device });
        },
      });
      if (!copied.ok) return copied;
      const display = importRenderPipelineSurface(graph, topology).unwrap();
      return addTypedOutputTransformPass(graph, color, display.storage, {
        outputOnly: true,
        dither: false,
      });
    },
  };
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        pipeline,
        rhi: recorder.backend.rhi,
        rhiInstrumentation: {
          resolveSurfaceDevice: (device) =>
            ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
        },
      },
      { shaderManifestUrl: options.shaderManifestUrl },
    ),
  );
  const { renderer } = host;
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World();
  try {
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: {
            projection: 1,
            left: 0,
            right: width,
            bottom: 0,
            top: height,
            near: 0.1,
            far: 10,
            antialias: 0,
            bloom: 0,
            tonemap: 0,
          },
        },
      )
      .unwrap();
    const entities: EntityHandle[] = [];
    const spawn = (
      positions: number[],
      topology: 'line-list' | 'line-strip' | 'point-list',
      color: readonly [number, number, number, number],
      style: { widthPx?: number; dashSize?: number; gapSize?: number; dashOffset?: number } = {},
      indices?: number[],
    ) => {
      const vertices = new Float32Array(positions);
      const mesh: MeshAsset = {
        kind: 'mesh',
        vertices,
        attributes: { position: vertices },
        ...(indices ? { indices: new Uint16Array(indices) } : {}),
        submeshes: [
          {
            topology,
            vertexCount: positions.length / 3,
            indexOffset: 0,
            indexCount: indices?.length ?? 0,
            materialSlot: 0,
          },
        ],
        materialSlots: [{ slotName: 'default' }],
      };
      const entity = world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', mesh) } },
          {
            component: MeshRenderer,
            data: {
              materials: [world.allocSharedRef('MaterialAsset', Materials.unlit(color))],
            },
          },
        )
        .unwrap();
      if (topology === 'point-list')
        world.addComponent(entity, { component: Points, data: { sizePx: 10, shape: 1 } }).unwrap();
      else
        world.addComponent(entity, { component: Lines, data: { widthPx: 8, ...style } }).unwrap();
      entities.push(entity);
      return entity;
    };
    // Red path: a right-angle join and a diagonal in a non-square viewport.
    spawn([20, 160, 0, 80, 160, 0, 80, 120, 0, 120, 100, 0], 'line-strip', [1, 0, 0, 1]);
    // Green path: a 27-unit first segment ensures phase cannot reset at its corner.
    const dashed = spawn([20, 80, 0, 47, 80, 0, 47, 20, 0], 'line-strip', [0, 1, 0, 1], {
      dashSize: 12,
      gapSize: 8,
    });
    // Closed indexed blue boundary; closure uses the same join as interior vertices.
    spawn(
      [170, 140, 0, 260, 140, 0, 260, 60, 0, 170, 60, 0],
      'line-strip',
      [0, 0, 1, 1],
      {},
      [0, 1, 2, 3, 0],
    );
    // Existing line-list and points remain visible with the canonical vertex stride.
    spawn([140, 30, 0, 200, 30, 0, 220, 30, 0, 280, 30, 0], 'line-list', [1, 1, 0, 1], {
      widthPx: 4,
      dashSize: 10,
      gapSize: 10,
    });
    spawn([295, 165, 0], 'point-list', [1, 0, 1, 1]);
    // A path entering from behind the camera still joins at its visible corner.
    spawn([280, 80, 4, 280, 110, 0, 300, 110, 0], 'line-strip', [1, 1, 1, 1]);
    const lease = renderValue(renderer.attach(world));
    let frames = 0;
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const receipt = renderValue(
        renderer.draw({
          leases: [lease],
          camera: { lease },
          environment: { lease },
          geometryLane: 'direct',
        }),
      );
      renderValue(await receipt.completed);
      frames++;
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    for (let i = 0; i < 60; i++) {
      await draw();
    }
    let perspective = false;
    const capture = async (name: string, phase: number, solid = false) => {
      observe = true;
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      await draw();
      (await recorder.frameBoundary()).unwrap();
      const encoded = (await pending).unwrap();
      observe = false;
      await options.save(`${name}.rhitape`, encoded.bytes);
      const tape = decodeTape(encoded.bytes).unwrap();
      const model = buildFrameModel(tape);
      const works = model.works.filter((work) => work.kind === 'drawIndexed');
      expect(works).toHaveLength(perspective ? 1 : 6);
      const work = works.at(-1);
      if (!work?.attachments) throw new Error('line draw attachments absent');
      const colorId = work.attachments.colorViewHandleIds[0];
      if (colorId === undefined) throw new Error('line color absent');
      const copy = copies.shift();
      if (!copy) throw new Error('live readback absent');
      const mapped = (await copy.buffer.mapAsync(1)).unwrap();
      const bytes = new Uint8Array(mapped.getMappedRange().unwrap());
      const live = new Uint8Array(width * height * 4);
      for (let row = 0; row < height; row++)
        live.set(bytes.subarray(row * stride, row * stride + width * 4), row * width * 4);
      mapped.unmap();
      copy.device.destroyBuffer(copy.buffer).unwrap();
      await options.save(`${name}.rgba`, live);
      const pixel = (x: number, y: number) => [
        ...live.slice(((height - 1 - y) * width + x) * 4, ((height - 1 - y) * width + x) * 4 + 3),
      ];
      if (perspective) {
        // Project a local segment whose endpoints have camera distances 2 and 4.
        // The inverse is analytical and independent of the shader's interpolation.
        const focal = height / (2 * Math.tan(Math.PI / 8));
        for (let x = 30; x < 230; x += 3) {
          const rayX = (x + 0.5 - width / 2) / focal;
          const localT = (1 + 2 * rayX) / (2 - 2 * rayX);
          const distance = Math.sqrt(8) * localT;
          const phase = ((distance % 0.5) + 0.5) % 0.5;
          if (Math.min(phase, Math.abs(phase - 0.25), 0.5 - phase) < 0.015) continue;
          for (const y of [125, 128, 130])
            expect(pixel(x, y), `perspective dash at ${x},${y}`).toEqual(
              phase < 0.25 ? [0, 255, 0] : [0, 0, 0],
            );
          expect(pixel(x, 133)).toEqual([0, 0, 0]);
        }
      } else {
        expect(pixel(40, 160)).toEqual([255, 0, 0]);
        expect(pixel(82, 162)).toEqual([255, 0, 0]);
        expect(pixel(80, 135)).toEqual([255, 0, 0]);
        expect(pixel(100, 110)).toEqual([255, 0, 0]);
        expect(pixel(100, 113)).toEqual([255, 0, 0]);
        expect(pixel(100, 115)).toEqual([0, 0, 0]);
        expect(pixel(167, 143)).toEqual([0, 0, 255]);
        expect(pixel(263, 143)).toEqual([0, 0, 255]);
        expect(pixel(295, 165)).toEqual([255, 0, 255]);
        expect(pixel(290, 160)).toEqual([0, 0, 0]);
        expect(pixel(277, 113)).toEqual([255, 255, 255]);
        expect(pixel(280, 100)).toEqual([255, 255, 255]);
        expect(pixel(280, 85)).toEqual([0, 0, 0]);
        expect(pixel(144, 30)).toEqual([255, 255, 0]);
        expect(pixel(154, 30)).toEqual([0, 0, 0]);
        // Sample interior pixels, away from joins/caps; every segment shares arc length.
        for (const y of [67, 57, 47, 37]) {
          const distance = 27 + 80 - (y + 0.5) + phase;
          const on = solid || ((distance % 20) + 20) % 20 < 12;
          for (const x of [44, 47, 49])
            expect(pixel(x, y), `dash at x=${x}, y=${y}, phase=${phase}`).toEqual(
              on ? [0, 255, 0] : [0, 0, 0],
            );
        }
        if (phase === 0 && !solid)
          for (const sample of threePixels.samples)
            expect(pixel(sample.x, sample.y)).toEqual(sample.rgb);
        if (solid) expect(pixel(52, 50)).toEqual([0, 255, 0]);
      }
      for (const falsify of [false, true]) {
        const replayTape = falsify
          ? decodeTape(
              encodeTape({
                ...tape,
                events: tape.events.map((event) =>
                  event.kind === 'drawIndexed' ? { ...event, indexCount: 0 } : event,
                ),
              }).unwrap(),
            ).unwrap()
          : tape;
        const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
        const device = (
          await adapter.requestDevice(
            replayDeviceRequest(replayTape, adapter.features, adapter.limits),
          )
        ).unwrap();
        const replay = (
          await openReplay(replayTape, { device, createShaderModule: webgpu.createShaderModule })
        ).unwrap();
        try {
          if (!falsify) {
            for (const selected of works) {
              const inspection = (
                await replay.inspectWork(selected.workIndex, ['pipeline', 'bindings'])
              ).unwrap();
              await options.save(
                `${name}-work-${selected.workIndex}.json`,
                new TextEncoder().encode(JSON.stringify(inspection, null, 2)),
              );
            }
          }
          const pixels = (await replay.readResourceAtWork(colorId, work.workIndex)).unwrap();
          if (falsify) expect(pixels.bytes.some((value, i) => value !== live[i])).toBe(true);
          else expect(pixels.bytes).toEqual(live);
        } finally {
          (await replay.dispose()).unwrap();
        }
      }
      await options.save(
        `${name}.json`,
        new TextEncoder().encode(
          JSON.stringify(
            {
              digest: tapeDigest(encoded.bytes),
              workIndex: work.workIndex,
              eventIndex: work.eventIndex,
              unseededResources: model.unseededResources,
              width,
              height,
              frames,
              liveReplayEqual: true,
              missingDrawFalsifier: true,
              errors,
            },
            null,
            2,
          ),
        ),
      );
    };
    await capture('solid-dashed', 0);
    world.set(dashed, Lines, { dashOffset: -7 }).unwrap();
    await draw();
    await capture('offset-negative', -7);
    height = 256;
    canvas.height = height;
    world.set(camera, Camera, { top: height }).unwrap();
    world.set(dashed, Lines, { widthPx: 12, gapSize: 0 }).unwrap();
    for (let i = 0; i < 3; i++) await draw();
    await capture('solid-resized', -7, true);
    for (const entity of entities) world.despawn(entity).unwrap();
    world.set(camera, Camera, { projection: 0, fov: Math.PI / 4, aspect: width / height }).unwrap();
    spawn([-1, 0, 1, 1, 0, -1], 'line-strip', [0, 1, 0, 1], {
      widthPx: 8,
      dashSize: 0.25,
      gapSize: 0.25,
    });
    perspective = true;
    await draw();
    await capture('perspective', 0);
    expect(errors).toEqual([]);
  } catch (error) {
    await options.save(
      'failure.json',
      new TextEncoder().encode(
        JSON.stringify(
          { error, errors },
          (_key, value) => (value instanceof Error ? { ...value, message: value.message } : value),
          2,
        ),
      ),
    );
    throw error;
  } finally {
    for (const copy of copies) copy.device.destroyBuffer(copy.buffer).unwrap();
    renderValue(await renderer.dispose());
    surface?.destroy();
    (await recorder.dispose()).unwrap();
    rawDevice?.destroy();
  }
}
