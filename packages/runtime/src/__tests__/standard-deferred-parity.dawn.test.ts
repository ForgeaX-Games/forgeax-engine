import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder, buildFrameModel } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { verifyStandardDeferredParity } from './standard-deferred-parity.fixture';

const manifest = await buildEngineShaderManifest();
const manifestUrl = shaderManifestUrl(manifest);

it.each([
  false,
  true,
])('resolves Standard lighting from G-buffer with Forward pixel parity on Dawn (skin=%s)', {
  timeout: 120_000,
}, async (skinned) => {
  let texture: GPUTexture | undefined;
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      configure: (options: GPUCanvasConfiguration) => {
        texture?.destroy();
        texture = options.device.createTexture({
          size: [64, 64],
          format: options.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure: () => {},
      getCurrentTexture: () => texture,
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const host = await constructRuntimeRendererHost(
    canvas,
    { rhi: recorder.backend.rhi },
    { shaderManifestUrl: manifestUrl },
  );
  expect(host.ok, JSON.stringify(host.ok ? {} : host.error)).toBe(true);
  if (!host.ok) throw host.error;
  try {
    const evidence = await verifyStandardDeferredParity(host.value.renderer, {
      skinned,
      recorder,
      image(name, bytes, bytesPerRow) {
        const directory = `artifacts/standard-deferred/${skinned ? 'skin' : 'rigid'}`;
        mkdirSync(directory, { recursive: true });
        writeFileSync(`${directory}/${name}.rgba16f`, bytes);
        writeFileSync(
          `${directory}/${name}.json`,
          JSON.stringify({ width: 64, height: 64, bytesPerRow }),
        );
      },
      capture(tape, path) {
        const model = buildFrameModel(tape.tape);
        const lighting = model.works.filter((work) =>
          work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_standard_deferred'),
        );
        const geometry = model.works.filter((work) =>
          work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_gbuffer'),
        );
        if (path === 'deferred') {
          // Early G-buffer draws last frame's visible set; `g-buffer-late`
          // appends instances the HZB test newly finds visible.
          expect(geometry).toHaveLength(2);
          expect(geometry[0]?.passIndex).not.toBe(geometry[1]?.passIndex);
          expect(geometry[1]?.attachments?.colorViewHandleIds).toEqual(
            geometry[0]?.attachments?.colorViewHandleIds,
          );
          // The geometry and lighting passes target the same SceneColor.
          // Emissive has no separate texture or lighting sampler anymore.
          expect(geometry[0]?.attachments?.colorViewHandleIds[0]).toBe(
            lighting[0]?.attachments?.colorViewHandleIds[0],
          );
          expect(geometry[0]?.pipeline.descriptor).toMatchObject({
            desc: {
              fragment: {
                targets: [
                  { format: 'rgba16float' },
                  { format: 'r32uint' },
                  { format: 'r32uint' },
                  { format: 'r32uint' },
                  { format: 'r32uint' },
                ],
              },
            },
          });
          expect(lighting[0]?.pipeline.descriptor).toMatchObject({
            desc: {
              fragment: {
                targets: [
                  {
                    blend: {
                      color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
                      alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
                    },
                  },
                ],
              },
            },
          });
          expect(
            model.resources.some((resource) =>
              JSON.stringify(resource).includes('gbuffer-emissive-opacity'),
            ),
          ).toBe(false);
          for (const work of geometry)
            expect(work.drawCall).toMatchObject({ kind: 'drawIndexedIndirect' });
          expect(lighting).toHaveLength(1);
          expect(lighting[0]?.vertexBuffers).toEqual([]);
          expect(lighting[0]?.indexBuffer).toBeNull();
          expect(lighting[0]?.attachments?.depthStencilViewHandleId).toBeNull();
          expect(lighting[0]?.drawCall).toMatchObject({ kind: 'draw', vertexCount: 3 });
          expect(
            model.works.filter(
              (work) =>
                work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_main') &&
                (work.vertexBuffers.length > 0 || work.indexBuffer !== null),
            ),
          ).toHaveLength(0);
        } else {
          expect(lighting).toHaveLength(0);
          expect(geometry).toHaveLength(0);
        }
        const directory = `artifacts/standard-deferred/${path}`;
        mkdirSync(directory, { recursive: true });
        for (const work of model.works) {
          for (const shader of work.pipeline.shaders) {
            if (shader.source !== null && shader.stage === 'fragment')
              writeFileSync(
                `${directory}/${skinned ? 'skin' : 'rigid'}-${work.workIndex}-${shader.entryPoint}.wgsl`,
                shader.source,
              );
          }
        }
        writeFileSync(`${directory}/${skinned ? 'skin' : 'rigid'}.rhitape`, tape.bytes);
        writeFileSync(
          `${directory}/${skinned ? 'skin' : 'rigid'}-topology.json`,
          JSON.stringify(
            {
              digest: tape.digest,
              works: model.works.map((work) => ({
                draw: work.drawCall,
                shaders: work.pipeline.shaders.map((shader) => ({
                  stage: shader.stage,
                  entry: shader.entryPoint,
                })),
              })),
            },
            null,
            2,
          ),
        );
      },
    });
    writeFileSync(
      `artifacts/standard-deferred/${skinned ? 'skin' : 'rigid'}-parity.json`,
      JSON.stringify({ backend: 'dawn', skinned, evidence }, null, 2),
    );
  } finally {
    host.value.renderer.dispose();
    texture?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
