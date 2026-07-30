import { HANDLE_TRIANGLE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_FXAA,
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../index';

const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;
const CLEAR_COLOR: readonly [number, number, number] = [0.06, 0.06, 0.08];

function distanceFromClear(pixels: Uint8Array): number {
  let maximum = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const red = (pixels[i] ?? 0) / 255;
    const green = (pixels[i + 1] ?? 0) / 255;
    const blue = (pixels[i + 2] ?? 0) / 255;
    const distance = Math.hypot(
      red - CLEAR_COLOR[0],
      green - CLEAR_COLOR[1],
      blue - CLEAR_COLOR[2],
    );
    maximum = Math.max(maximum, distance);
  }
  return maximum;
}

function makeBaselineWorld(): World {
  const world = new World();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          tonemap: TONEMAP_REINHARD_EXTENDED,
          antialias: ANTIALIAS_FXAA,
        },
      },
    )
    .unwrap();
  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 1 },
  });
  return world;
}

describe.skipIf(!browserReady)('zero-feature browser render baseline', () => {
  let renderer: Awaited<ReturnType<typeof Engine.create>> | undefined;
  let canvas: HTMLCanvasElement | undefined;

  afterEach(() => {
    renderer?.dispose();
    if (canvas?.parentNode !== null) canvas?.parentNode?.removeChild(canvas);
    renderer = undefined;
    canvas = undefined;
  });

  it('keeps the triangle visible with no registered render features', async () => {
    canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 150;
    document.body.appendChild(canvas);

    renderer = await Engine.create(canvas, {}, { shaderManifestUrl: '/shaders/manifest.json' });
    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);

    const errors: Array<{ code: string; hint: string }> = [];
    renderer.onError((error) => errors.push({ code: error.code, hint: error.hint }));
    const world = makeBaselineWorld();
    for (let frame = 0; frame < 8; frame += 1) {
      expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    // Browser test isolation may retire a device after this renderer's frame
    // work completes. That intentional teardown is already distinguished by
    // the renderer's structured hint; every SUT-attributable error remains a
    // hard failure here.
    expect(
      errors.filter(
        (error) => !(error.code === 'device-lost' && error.hint.includes('reason: destroyed')),
      ),
    ).toEqual([]);
    expect(renderer.renderFeatureDiagnostics()).toEqual([]);
    expect(renderer.perFramePassNames).toEqual([
      'shadowCascade0',
      'shadowCascade1',
      'shadowCascade2',
      'shadowCascade3',
      'point-shadow',
      'spot-shadow',
      'skybox',
      'main',
      'bloom-bright',
      'bloom-blur-h',
      'bloom-blur-v',
      'bloom-composite',
      'tonemap',
      'fxaa',
      'debug-overlay',
    ]);

    const pixels = await renderer.readPixels();
    expect(pixels.ok).toBe(true);
    if (pixels.ok) expect(distanceFromClear(pixels.value)).toBeGreaterThan(0.05);
  });
});
