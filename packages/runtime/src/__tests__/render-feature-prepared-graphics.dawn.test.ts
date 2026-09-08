import type { Renderer } from '@forgeax/engine-render';
import { afterEach, describe, expect, it } from 'vitest';
import {
  frameRequest,
  preparedFeature,
  preparedWorld,
} from './render-feature-prepared-graphics.fixture';
import { requireRenderer } from './renderer-test-utils';

const WIDTH = 64;
const HEIGHT = 64;
const manifestUrl = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  const manifest = await buildEngineShaderManifest();
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
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
