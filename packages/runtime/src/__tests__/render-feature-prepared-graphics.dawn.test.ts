import type { Renderer } from '@forgeax/engine-render';
import { afterEach, describe, expect, it } from 'vitest';
import {
  frameRequest,
  preparedFeature,
  preparedWorld,
} from './render-feature-prepared-graphics.fixture';
import { requireRenderer } from './renderer-test-utils';
import { shaderManifestUrl as createShaderManifestUrl } from './shader-manifest-url.fixture';

const WIDTH = 64;
const HEIGHT = 64;
const manifestUrl = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  const manifest = await buildEngineShaderManifest();
  return createShaderManifestUrl(manifest);
})();

function canvas(): HTMLCanvasElement {
  let target: GPUTexture | undefined;
  return {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(descriptor: { device: GPUDevice; format?: GPUTextureFormat }) {
          target = descriptor.device.createTexture({
            size: { width: WIDTH, height: HEIGHT },
            format: descriptor.format ?? 'rgba8unorm',
            viewFormats: ['rgba8unorm-srgb'],
            usage: 0x10 | 0x04,
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          if (target === undefined) throw new Error('Dawn target was not configured');
          return target;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
}

describe('prepared graphics Dawn contract', () => {
  let renderer: Renderer | undefined;

  afterEach(() => {
    renderer?.dispose();
    renderer = undefined;
  });

  it('isolates a missing particle shader while preserving the Standard frame', async () => {
    renderer = await requireRenderer(
      canvas(),
      {
        features: [preparedFeature('missing.particle.material', 'missing-material')],
      },
      { shaderManifestUrl: manifestUrl },
    );
    const errors: unknown[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    const world = preparedWorld();
    const lease = renderer.attach(world).unwrap();
    world.update(1 / 60).unwrap();
    const frame = renderer.draw(frameRequest(lease));
    expect(frame.ok).toBe(true);
    if (!frame.ok) throw frame.error;
    (await frame.value.completed).unwrap();
    expect(renderer.inspect().featureDiagnostics).toContainEqual(
      expect.objectContaining({ identity: 'missing.particle.material', status: 'failed' }),
    );
    expect(renderer.inspect().perFramePassNames).toContain('main');
    expect(
      renderer
        .inspect()
        .perFramePassNames.some((name) => name.includes('missing.particle.material')),
    ).toBe(false);
    expect(JSON.stringify(errors)).toContain('material-shader-not-found');
    expect(JSON.stringify(errors)).toContain('test::missing-particle-material');
  }, 30_000);

  it('records a prepared operation through the real Dawn submit boundary', async () => {
    if (typeof navigator?.gpu?.requestAdapter !== 'function') {
      throw new Error('Dawn navigator.gpu is unavailable');
    }
    renderer = await requireRenderer(
      canvas(),
      { features: [preparedFeature('synthetic.dawn.prepared')] },
      { shaderManifestUrl: manifestUrl },
    );
    const errors: Array<{ code: string; causeCode?: string }> = [];
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      errors.push({
        code: event.error.code,
        ...(event.error.code === 'device-operation-failed'
          ? { causeCode: event.error.detail.cause.code }
          : {}),
      });
    });
    const world = preparedWorld();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update(1 / 60).ok).toBe(true);
    const frame = renderer.draw(frameRequest(attached.value));
    expect(frame.ok).toBe(true);
    if (frame.ok)
      expect((await renderer.observe(frame.value, { include: ['draws'] })).ok).toBe(true);
    expect(errors).not.toContain('render-feature-prepared-state-mismatch');
  });

  it('rejects a generation mismatch through the structured error channel', async () => {
    if (typeof navigator?.gpu?.requestAdapter !== 'function') {
      throw new Error('Dawn navigator.gpu is unavailable');
    }
    renderer = await requireRenderer(
      canvas(),
      { features: [preparedFeature('synthetic.dawn.mismatch', 'mismatch')] },
      { shaderManifestUrl: manifestUrl },
    );
    const errors: Array<{ code: string; causeCode?: string }> = [];
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      errors.push({
        code: event.error.code,
        ...(event.error.code === 'device-operation-failed'
          ? { causeCode: event.error.detail.cause.code }
          : {}),
      });
    });
    const world = preparedWorld();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update(1 / 60).ok).toBe(true);
    expect(renderer.draw(frameRequest(attached.value)).ok).toBe(true);
    expect(errors).toContainEqual({
      code: 'device-operation-failed',
      causeCode: 'render-feature-stage-failed',
    });
  });
});
