import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  measureSnapshotCost,
  type SnapshotCost,
  verifyFramebufferSnapshot,
  verifyPublicationSnapshot,
} from './framebuffer-snapshot.fixture';
import { encodeRgbaPng } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { gbufferReplayIdentity, renderValue } from './standard-gbuffer-replay.fixture';

const evidence = resolve(
  import.meta.dirname,
  '../../../../artifacts/pr-evidence/framebuffer-snapshot',
);

function stubCanvas(size: number) {
  let texture: GPUTexture | undefined;
  const canvas = {
    width: size,
    height: size,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        texture?.destroy();
        texture = config.device.createTexture({
          size: [canvas.width, canvas.height],
          format: config.format,
          usage: 0x11,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      getCurrentTexture: () => texture,
      unconfigure() {},
    }),
  };
  return { canvas, destroy: () => texture?.destroy() };
}

async function host(size: number, publicationSource?: { source: string; epoch: number }) {
  const recorder = attachRecorder(webgpu).unwrap();
  const surface = stubCanvas(size);
  const built = renderValue(
    await constructRuntimeRendererHost(
      surface.canvas,
      {
        rhi: recorder.backend.rhi,
        ssrIdentity: gbufferReplayIdentity,
        ...(publicationSource === undefined ? {} : { publicationSource }),
      },
      { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    ),
  );
  return {
    ...built,
    recorder,
    async dispose() {
      renderValue(await built.renderer.dispose());
      surface.destroy();
      (await recorder.dispose()).unwrap();
    },
  };
}

/** GPU time of `copies` isolated rgba16float copies, net of an empty submit, per copy. */
async function isolatedCopyGpuMs(size: number, copies = 32): Promise<number> {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('dawn-node adapter unavailable');
  const device = await adapter.requestDevice();
  const texture = (usage: number) =>
    device.createTexture({ size: [size, size], format: 'rgba16float', usage });
  const source = texture(GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT);
  const destination = texture(GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING);
  const run = async (count: number) => {
    const encoder = device.createCommandEncoder();
    for (let i = 0; i < count; i++)
      encoder.copyTextureToTexture({ texture: source }, { texture: destination }, [size, size]);
    const start = performance.now();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    return performance.now() - start;
  };
  try {
    await run(copies);
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) samples.push(((await run(copies)) - (await run(0))) / copies);
    return samples.sort((a, b) => a - b)[2] ?? 0;
  } finally {
    source.destroy();
    destination.destroy();
    device.destroy();
  }
}

it('retains a frame-N scene-color region across 60 changed frames and replays the copy on Dawn', {
  timeout: 240_000,
}, async () => {
  mkdirSync(evidence, { recursive: true });
  const local = await host(128);
  let result: Awaited<ReturnType<typeof verifyFramebufferSnapshot>>;
  try {
    result = await verifyFramebufferSnapshot({
      renderer: local.renderer,
      recorder: local.recorder,
      save: (name, bytes, size) => {
        if (size === undefined) {
          if (!name.endsWith('.rhitape')) writeFileSync(join(evidence, name), bytes);
          return;
        }
        const png = encodeRgbaPng(bytes, size, size < 64 ? 4 : 2);
        expect(png.byteLength).toBeLessThan(200_000);
        writeFileSync(join(evidence, `dawn-${name.replace(/\.rgba$/, '.png')}`), png);
      },
    });
  } finally {
    await local.dispose();
  }

  const identity = { source: 'framebuffer-snapshot', epoch: 1 };
  const published = await host(128, identity);
  let publication: Awaited<ReturnType<typeof verifyPublicationSnapshot>>;
  try {
    publication = await verifyPublicationSnapshot({
      renderer: published.renderer,
      assets: published.assets,
      identity,
    });
  } finally {
    await published.dispose();
  }

  // Cost sampling asserts nothing and dominates the gate's runtime; it is opt-in evidence.
  const perf: (SnapshotCost & { readonly isolatedCopyGpuMs: number })[] = [];
  if (process.env.FORGEAX_SNAPSHOT_PERF === '1') {
    const timed = await host(1024);
    try {
      for (const size of [256, 1024])
        perf.push({
          ...(await measureSnapshotCost(timed.renderer, size)),
          isolatedCopyGpuMs: await isolatedCopyGpuMs(size),
        });
    } finally {
      await timed.dispose();
    }
  }
  writeFileSync(
    join(evidence, 'summary.dawn.json'),
    `${JSON.stringify(
      {
        backend: 'dawn-node',
        colorDomain: 'linear-hdr rgba16float scene color before post/tonemap',
        ...result,
        publication,
        perf,
      },
      null,
      2,
    )}\n`,
  );
});
