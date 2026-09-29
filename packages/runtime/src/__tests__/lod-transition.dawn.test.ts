import { mkdirSync, writeFileSync } from 'node:fs';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  encodeTape,
  halfToFloat,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { LOD_SIZE, value, verifyLodTransition } from './lod-transition.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
it.each([
  false,
  true,
])('proves LOD color, shadow and fresh-device RHI replay at 60 frames (TAA=%s)', {
  timeout: 180_000,
}, async (taa) => {
  let target: GPUTexture | undefined;
  const canvas = {
    width: LOD_SIZE,
    height: LOD_SIZE,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        target?.destroy();
        target = options.device.createTexture({
          size: [LOD_SIZE, LOD_SIZE],
          format: options.format,
          usage: 0x11,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const host = value(
    await constructRuntimeRendererHost(
      canvas,
      { rhi: recorder.backend.rhi },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  const directory = taa ? 'artifacts/lod-transition/dawn-taa' : 'artifacts/lod-transition/dawn';
  mkdirSync(directory, { recursive: true });
  try {
    await verifyLodTransition(host, {
      recorder,
      taa,
      masked: taa,
      save: (name, bytes) => writeFileSync(`${directory}/${name}`, bytes),
      async captured(encoded, live, covered) {
        const tape = decodeTape(encoded.bytes).unwrap();
        const model = buildFrameModel(tape);
        const color = model.works.filter(
          (work) =>
            work.vertexBuffers.length > 0 &&
            work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_main'),
        );
        const shadows = model.works.filter((work) =>
          work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_shadow'),
        );
        const temporal = model.works.filter((work) =>
          work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_temporal'),
        );
        expect(temporal).toHaveLength(taa ? 2 : 0);
        // Two-phase GPU occlusion records both LOD draws in the early pass and
        // again in the late pass, which appends newly visible instances.
        const colorPasses = new Map<number, number>();
        for (const work of color)
          colorPasses.set(work.passIndex, (colorPasses.get(work.passIndex) ?? 0) + 1);
        expect([...colorPasses.values()]).toEqual([2, 2]);
        expect(shadows).toHaveLength(2);
        for (const work of [...color, ...shadows, ...temporal])
          expect(
            work.pipeline.shaders.some((shader) => shader.source?.includes('applyLodCoverage')),
          ).toBe(true);
        const last = color.at(-1);
        if (!last) throw new Error('Missing LOD color work');
        const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
        const device = (
          await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
        ).unwrap();
        const replay = (
          await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
        ).unwrap();
        try {
          if (!covered) {
            const work = temporal.at(-1);
            if (!work) throw new Error('Missing masked temporal work');
            const attachment = (await replay.inspectWork(work.workIndex, ['pixels'])).unwrap()
              .attachment;
            if (!attachment) throw new Error('Missing masked temporal readback');
            writeFileSync(`${directory}/alpha-clipped-temporal.rgba16f`, attachment.bytes);
            const data = new DataView(
              attachment.bytes.buffer,
              attachment.bytes.byteOffset,
              attachment.bytes.byteLength,
            );
            for (let y = 54; y < 74; y++)
              for (let x = 54; x < 74; x++)
                expect(
                  halfToFloat(data.getUint16((y * LOD_SIZE + x) * 8 + 4, true)),
                  `alpha-clipped temporal coverage ${x},${y}`,
                ).toBe(-1); // standard-scene-data's untouched background marker.
            return;
          }
          const inspection = (
            await replay.inspectWork(last.workIndex, ['pipeline', 'bindings', 'pixels'])
          ).unwrap();
          const attachment = inspection.attachment;
          if (!attachment) throw new Error('Missing replay attachment');
          expect(attachment.format).toBe('rgba16float');
          writeFileSync(`${directory}/replay.rgba16f`, attachment.bytes);
          const data = new DataView(
            attachment.bytes.buffer,
            attachment.bytes.byteOffset,
            attachment.bytes.byteLength,
          );
          let index = 0;
          for (let y = 54; y < 74; y++)
            for (let x = 54; x < 74; x++) {
              expect(halfToFloat(data.getUint16((y * LOD_SIZE + x) * 8, true))).toBeCloseTo(
                live[index++] ?? NaN,
                4,
              );
              expect(halfToFloat(data.getUint16((y * LOD_SIZE + x) * 8 + 2, true))).toBeCloseTo(
                live[index++] ?? NaN,
                4,
              );
            }
          if (taa) {
            const temporalWork = temporal.at(-1);
            if (!temporalWork) throw new Error('Missing temporal work');
            const temporalPixels = (
              await replay.inspectWork(temporalWork.workIndex, ['pixels'])
            ).unwrap().attachment;
            if (!temporalPixels) throw new Error('Missing temporal readback');
            writeFileSync(`${directory}/temporal.rgba16f`, temporalPixels.bytes);
            const motion = new DataView(
              temporalPixels.bytes.buffer,
              temporalPixels.bytes.byteOffset,
              temporalPixels.bytes.byteLength,
            );
            // Includes the silhouette where only one LOD has geometry. Temporal
            // coverage must match the dithered visible surface, not the root mesh.
            for (let y = 32; y < 96; y++)
              for (let x = 32; x < 96; x++) {
                const at = (y * LOD_SIZE + x) * 8;
                const covered =
                  halfToFloat(data.getUint16(at, true)) +
                    halfToFloat(data.getUint16(at + 2, true)) >
                  0.05;
                expect(
                  halfToFloat(motion.getUint16(at + 4, true)) > 0,
                  `temporal coverage ${x},${y}`,
                ).toBe(covered);
              }
          }
          const depth = (
            await replay.readResourceAtWork(
              last.attachments?.depthStencilViewHandleId ?? '',
              last.workIndex,
              { mipLevel: 0, arrayLayer: 0, aspect: 'depth-only' },
            )
          ).unwrap();
          const depths = new DataView(
            depth.bytes.buffer,
            depth.bytes.byteOffset,
            depth.bytes.byteLength,
          );
          writeFileSync(`${directory}/color-depth.f32`, depth.bytes);
          for (let y = 54; y < 74; y++)
            for (let x = 54; x < 74; x++) {
              const z = depths.getFloat32((y * LOD_SIZE + x) * 4, true);
              expect(z).toBeGreaterThan(0);
              expect(z).toBeLessThan(1);
            }
          const shadow = shadows.at(-1);
          if (!shadow) throw new Error('Missing shadow work');
          const shadowDepth = (
            await replay.readResourceAtWork(
              shadow.attachments?.depthStencilViewHandleId ?? '',
              shadow.workIndex,
              { mipLevel: 0, arrayLayer: 0, aspect: 'depth-only' },
            )
          ).unwrap();
          writeFileSync(`${directory}/shadow-depth.f32`, shadowDepth.bytes);
          const shadowValues = new Float32Array(shadowDepth.bytes.slice().buffer);
          const shadowFirst = shadows[0];
          if (!shadowFirst) throw new Error('Missing outgoing shadow work');
          const outgoing = (
            await replay.readResourceAtWork(
              shadowFirst.attachments?.depthStencilViewHandleId ?? '',
              shadowFirst.workIndex,
              { mipLevel: 0, arrayLayer: 0, aspect: 'depth-only' },
            )
          ).unwrap();
          const outgoingValues = new Float32Array(outgoing.bytes.slice().buffer);
          const firstCoverage = [...outgoingValues].filter(
            (depth) => depth < 0.999 && depth > 0,
          ).length;
          const pairCoverage = [...shadowValues].filter(
            (depth) => depth < 0.999 && depth > 0,
          ).length;
          // Shadow views rank LOD from the light matrix (M4), so the main
          // view's crossfade pair need not be a shadow pair; the rows the
          // light selects must still cast a shadow.
          expect(pairCoverage).toBeGreaterThan(10);
          expect(pairCoverage).toBeGreaterThanOrEqual(firstCoverage);
          writeFileSync(
            `${directory}/inspection.json`,
            JSON.stringify(
              {
                digest: encoded.digest,
                colorWorks: color.map((work) => work.workIndex),
                shadowWorks: shadows.map((work) => work.workIndex),
                pipeline: inspection.pipeline,
                bindings: inspection.bindings,
              },
              null,
              2,
            ),
          );
        } finally {
          (await replay.dispose()).unwrap();
        }
        // A legal no-op draw must destroy complementary coverage. This proves
        // the pixel gate observes both levels, not merely two recorded commands.
        const omitted = color[0];
        if (!omitted) throw new Error('Missing falsifier draw');
        const brokenBytes = encodeTape({
          ...tape,
          events: tape.events.map((event, index) =>
            index === omitted.eventIndex && event.kind === 'drawIndexedIndirect'
              ? {
                  kind: 'drawIndexed' as const,
                  passHandleId: event.passHandleId,
                  indexCount: 0,
                  instanceCount: 0,
                  firstIndex: 0,
                  baseVertex: 0,
                  firstInstance: 0,
                }
              : event,
          ),
        }).unwrap();
        writeFileSync(`${directory}/missing-level-falsifier.rhitape`, brokenBytes);
        const brokenTape = decodeTape(brokenBytes).unwrap();
        const freshAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
        const freshDevice = (
          await freshAdapter.requestDevice(
            replayDeviceRequest(brokenTape, freshAdapter.features, freshAdapter.limits),
          )
        ).unwrap();
        const broken = (
          await openReplay(brokenTape, {
            device: freshDevice,
            createShaderModule: webgpu.createShaderModule,
          })
        ).unwrap();
        try {
          const attachment = (await broken.inspectWork(last.workIndex, ['pixels'])).unwrap()
            .attachment;
          if (!attachment) throw new Error('Missing falsifier pixels');
          writeFileSync(`${directory}/missing-level.rgba16f`, attachment.bytes);
          const pixels = new DataView(
            attachment.bytes.buffer,
            attachment.bytes.byteOffset,
            attachment.bytes.byteLength,
          );
          let holes = 0;
          for (let y = 54; y < 74; y++)
            for (let x = 54; x < 74; x++) {
              const at = (y * LOD_SIZE + x) * 8;
              if (
                halfToFloat(pixels.getUint16(at, true)) +
                  halfToFloat(pixels.getUint16(at + 2, true)) <
                0.05
              )
                holes++;
            }
          expect(holes).toBeGreaterThan(150);
          expect(holes).toBeLessThan(250);
          writeFileSync(
            `${directory}/falsifier.json`,
            JSON.stringify({ omittedWork: omitted.workIndex, holes, samples: 400 }),
          );
        } finally {
          (await broken.dispose()).unwrap();
        }
      },
    });
  } finally {
    host.renderer.dispose();
    (await recorder.dispose()).unwrap();
    target?.destroy();
  }
});
