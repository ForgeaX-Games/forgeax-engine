import { createWorldContext, type EntityHandle, FixedTime, Time, World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  Atmosphere,
  BLOOM_DISABLED,
  CAMERA_EXPOSURE_MODE_MANUAL,
  Camera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  type RenderInspection,
  type RenderWorldLease,
  ShadowParticipation,
  VolumetricFog,
} from '@forgeax/engine-render';
import { propagateTransforms, scenePlugin, Transform } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import {
  createWave1RenderingRecipe,
  WAVE1_ATMOSPHERE_PRESET,
} from '../../../../scripts/dev-verify/wave1-rendering/recipe';
import { createRenderer } from '../createRenderer';

interface ScreenshotPixels {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

interface Roi {
  readonly centerX: number;
  readonly centerY: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

interface RoiStats {
  readonly finitePixels: number;
  readonly pixelCount: number;
  readonly nonBlackPixels: number;
  readonly meanLuma: number;
  readonly radialWidth: number;
}

interface FrameSample {
  readonly pixels: ScreenshotPixels;
  readonly inspection: RenderInspection;
}

const OUTPUT_WIDTH = 256;
const OUTPUT_HEIGHT = 256;
const DISC_RADIUS = 0.03;
// These are fixed screenshot-space tolerances for the 256x256 manual-exposure
// carrier. They are deliberately directional: a response that merely changes
// in the wrong direction must fail instead of being treated as calibration.
const MIN_STRENGTH_LUMA_DELTA = 0.25;
const MIN_WIDTH_RADIAL_DELTA = 0.0001;
const DAYLIGHT: readonly [number, number, number] = [0, -0.25, 1];
const LOW_SUN: readonly [number, number, number] = [0, -0.01, 1];
// This direction is deliberately outside the camera's horizontal viewport.
// DirectionalLight.direction is the outgoing vector (light -> surface), so
// the projected solar ray below uses its negation (surface -> light).
const OFFSCREEN_SUN: readonly [number, number, number] = [0.92, -0.01, 0.39];
const CAMERA_SHADOW_DISTANCE = 25;
const SKY_ROIS: Record<'daylight' | 'low-sun', Roi> = {
  daylight: { centerX: 0.5, centerY: 0.28, halfWidth: 0.28, halfHeight: 0.2 },
  'low-sun': { centerX: 0.5, centerY: 0.5, halfWidth: 0.28, halfHeight: 0.2 },
};
const HORIZON_ROIS: Record<'daylight' | 'low-sun', Roi> = {
  daylight: { centerX: 0.5, centerY: 0.7, halfWidth: 0.35, halfHeight: 0.1 },
  'low-sun': { centerX: 0.5, centerY: 0.64, halfWidth: 0.35, halfHeight: 0.1 },
};
const FOG_ROI: Roi = { centerX: 0.5, centerY: 0.5, halfWidth: 0.24, halfHeight: 0.24 };
// The successor's right-hand box projects into this interior ROI at both the
// near and far positions below. Keeping the ROI away from the box edge makes
// the foreground response a depth/composition signal instead of an edge
// coverage signal.
const TRANSPARENT_COMPOSITION_ROI: Roi = {
  centerX: 0.55,
  centerY: 0.58,
  halfWidth: 0.03,
  halfHeight: 0.08,
};
const TRANSPARENT_NEAR_POSITION: readonly [number, number, number] = [0, 0, 1];
const TRANSPARENT_FAR_POSITION: readonly [number, number, number] = [0, 0, -1];
const TRANSPARENT_OFFSCREEN_POSITION: readonly [number, number, number] = [20, 0, 1];
const TRANSPARENT_HALF_EXTENTS: readonly [number, number, number] = [0.75, 0.9, 0.25];
const TRANSPARENT_RIGHT_BOX_HALF_EXTENTS: readonly [number, number, number] = [0.325, 0.9, 0.25];
const MAX_TRANSPARENT_FROZEN_NOISE = 2;
const MIN_TRANSPARENT_FROZEN_SIGNAL = 0.25;
const TRANSPARENT_FROZEN_SAMPLES = 8;
const MAX_PAUSED_FOG_MEAN_LUMA_DELTA = 1;
const MAX_EQUAL_TIME_FOG_MEAN_LUMA_DELTA = 1;
const MAX_EQUAL_TIME_FOG_PIXEL_LUMA_DELTA = 2;
// The screenshot is rgba8-quantized; require the different-time response to
// clear the matched unchanged-time redraw noise by a visible margin.
const MIN_TIME_SENSITIVITY_FOG_PIXEL_MARGIN = 0.25;
const MAX_CONTROL_BEAM_MEAN_LUMA_DELTA = 1;
const MIN_ENABLED_BEAM_MEAN_LUMA_DELTA = 2;

const ROOF_OPEN_POSITION: readonly [number, number, number] = [20, 2.9, 0.5];
const ROOF_CASTER_POSITION: readonly [number, number, number] = [0, 2.35, 0.5];
const ROOF_MOVED_POSITION: readonly [number, number, number] = [0.75, 2.35, 0.5];
// The successor is an ordinary MeshAsset with two 0.65-wide boxes centred at
// +/-0.42. Its complete projected x extent stays left of the common beam ROI
// while the offscreen sun can still cast its shadow through that ROI.
const CASTER_HALF_EXTENTS: readonly [number, number, number] = [0.75, 0.9, 0.25];

interface CameraProjectionReceipt {
  readonly ndcX: number;
  readonly ndcY: number;
  readonly depth: number;
  readonly inViewport: boolean;
}

interface CameraProjectionConfig {
  readonly position: readonly [number, number, number];
  readonly fov: number;
  readonly near: number;
  readonly far: number;
}

interface CameraBoundsReceipt {
  readonly minNdcX: number;
  readonly maxNdcX: number;
  readonly minNdcY: number;
  readonly maxNdcY: number;
  readonly roiMinNdcY: number;
  readonly roiMaxNdcY: number;
  readonly minDepth: number;
  readonly maxDepth: number;
  readonly intersects: boolean;
  readonly containsRoi: boolean;
}

function projectCameraBounds(
  position: readonly [number, number, number],
  halfExtents: readonly [number, number, number],
  roi: Roi,
  camera: CameraProjectionConfig,
): CameraBoundsReceipt {
  const tanHalfFov = Math.tan(camera.fov / 2);
  const depths = [
    camera.position[2] - (position[2] - halfExtents[2]),
    camera.position[2] - (position[2] + halfExtents[2]),
  ];
  const minDepth = Math.min(...depths);
  const maxDepth = Math.max(...depths);
  const ndcX = [
    (position[0] - halfExtents[0] - camera.position[0]) / (minDepth * tanHalfFov),
    (position[0] + halfExtents[0] - camera.position[0]) / (minDepth * tanHalfFov),
    (position[0] - halfExtents[0] - camera.position[0]) / (maxDepth * tanHalfFov),
    (position[0] + halfExtents[0] - camera.position[0]) / (maxDepth * tanHalfFov),
  ];
  const ndcY = [
    (position[1] - halfExtents[1] - camera.position[1]) / (minDepth * tanHalfFov),
    (position[1] + halfExtents[1] - camera.position[1]) / (minDepth * tanHalfFov),
    (position[1] - halfExtents[1] - camera.position[1]) / (maxDepth * tanHalfFov),
    (position[1] + halfExtents[1] - camera.position[1]) / (maxDepth * tanHalfFov),
  ];
  const minNdcX = Math.min(...ndcX);
  const maxNdcX = Math.max(...ndcX);
  const minNdcY = Math.min(...ndcY);
  const maxNdcY = Math.max(...ndcY);
  // Screenshot Y grows downward, while camera NDC Y grows upward. Keep the
  // conversion explicit so an asymmetric ROI cannot silently use the wrong
  // interval orientation.
  const roiMinNdcY = 1 - 2 * (roi.centerY + roi.halfHeight);
  const roiMaxNdcY = 1 - 2 * (roi.centerY - roi.halfHeight);
  const roiMinNdcX = (roi.centerX - roi.halfWidth) * 2 - 1;
  const roiMaxNdcX = (roi.centerX + roi.halfWidth) * 2 - 1;
  return {
    minNdcX,
    maxNdcX,
    minNdcY,
    maxNdcY,
    roiMinNdcY,
    roiMaxNdcY,
    minDepth,
    maxDepth,
    intersects:
      maxNdcX >= roiMinNdcX &&
      minNdcX <= roiMaxNdcX &&
      maxNdcY >= roiMinNdcY &&
      minNdcY <= roiMaxNdcY,
    containsRoi:
      minNdcX <= roiMinNdcX &&
      maxNdcX >= roiMaxNdcX &&
      minNdcY <= roiMinNdcY &&
      maxNdcY >= roiMaxNdcY,
  };
}

function projectSolarDirection(
  direction: readonly [number, number, number],
  camera: CameraProjectionConfig,
): CameraProjectionReceipt {
  const incoming = [-direction[0], -direction[1], -direction[2]] as const;
  const depth = -incoming[2];
  const tanHalfFov = Math.tan(camera.fov / 2);
  const ndcX = incoming[0] / (depth * tanHalfFov);
  const ndcY = incoming[1] / (depth * tanHalfFov);
  return {
    ndcX,
    ndcY,
    depth,
    inViewport:
      depth > 0 &&
      depth >= camera.near &&
      depth <= camera.far &&
      Math.abs(ndcX) <= 1 &&
      Math.abs(ndcY) <= 1,
  };
}

function createDensity(): TextureAsset {
  const size = 16;
  const data = new Uint8Array(size * size * size);
  for (let z = 0; z < size; z += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const u = (x + 0.5) / size;
        const v = (z + 0.5) / size;
        const broad = 0.5 + 0.5 * Math.sin(u * Math.PI * 2) * Math.cos(v * Math.PI * 2);
        const detail = 0.5 + 0.5 * Math.sin((u + v) * Math.PI * 6);
        const value = 0.18 + 0.62 * (0.7 * broad + 0.3 * detail);
        data[(z * size + y) * size + x] = Math.round(value * 255);
      }
    }
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: size, height: size, depth: size } },
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data,
  };
}

function bounds(image: ScreenshotPixels, roi: Roi): readonly [number, number, number, number] {
  return [
    Math.max(0, Math.floor((roi.centerX - roi.halfWidth) * image.width)),
    Math.max(0, Math.floor((roi.centerY - roi.halfHeight) * image.height)),
    Math.min(image.width, Math.ceil((roi.centerX + roi.halfWidth) * image.width)),
    Math.min(image.height, Math.ceil((roi.centerY + roi.halfHeight) * image.height)),
  ];
}

function luma(pixels: Uint8Array, offset: number): number {
  return (
    0.2126 * (pixels[offset] ?? 0) +
    0.7152 * (pixels[offset + 1] ?? 0) +
    0.0722 * (pixels[offset + 2] ?? 0)
  );
}

function roiStats(image: ScreenshotPixels, roi: Roi, excludeInnerRadius = 0): RoiStats {
  const [x0, y0, x1, y1] = bounds(image, roi);
  const values: Array<{ readonly x: number; readonly y: number; readonly value: number }> = [];
  const edge: number[] = [];
  let finitePixels = 0;
  let nonBlackPixels = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const value = luma(image.pixels, (y * image.width + x) * 4);
      values.push({ x, y, value });
      if (x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1) edge.push(value);
      if (Number.isFinite(value)) finitePixels += 1;
      if (value > 2) nonBlackPixels += 1;
      total += value;
    }
  }
  edge.sort((left, right) => left - right);
  const baseline = edge[Math.floor(edge.length * 0.5)] ?? 0;
  let weight = 0;
  let radialMoment = 0;
  for (const sample of values) {
    const signal = Math.max(sample.value - baseline, 0);
    const dx = (sample.x + 0.5) / image.width - roi.centerX;
    const dy = (sample.y + 0.5) / image.height - roi.centerY;
    const radius = Math.hypot(dx, dy);
    // The authored disc is a separate source. Exclude its core and clipped
    // screenshot pixels so the measured width belongs to the circumsolar
    // excess rather than the disc or an LDR clamp.
    if (radius <= excludeInnerRadius || sample.value >= 254) continue;
    weight += signal;
    radialMoment += signal * (dx * dx + dy * dy);
  }
  return {
    finitePixels,
    pixelCount: values.length,
    nonBlackPixels,
    meanLuma: total / Math.max(1, values.length),
    radialWidth: weight > 0 ? Math.sqrt(radialMoment / weight) : 0,
  };
}

function pixelDelta(left: ScreenshotPixels, right: ScreenshotPixels, roi?: Roi): number {
  const [x0, y0, x1, y1] = roi === undefined ? [0, 0, left.width, left.height] : bounds(left, roi);
  let changed = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * left.width + x) * 4;
      if (
        (left.pixels[offset] ?? 0) !== (right.pixels[offset] ?? 0) ||
        (left.pixels[offset + 1] ?? 0) !== (right.pixels[offset + 1] ?? 0) ||
        (left.pixels[offset + 2] ?? 0) !== (right.pixels[offset + 2] ?? 0)
      ) {
        changed += 1;
      }
    }
  }
  return changed;
}

function roiMeanAbsoluteLumaDelta(
  left: ScreenshotPixels,
  right: ScreenshotPixels,
  roi: Roi,
): number {
  const [x0, y0, x1, y1] = bounds(left, roi);
  let total = 0;
  let samples = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * left.width + x) * 4;
      total += Math.abs(luma(left.pixels, offset) - luma(right.pixels, offset));
      samples += 1;
    }
  }
  return total / Math.max(1, samples);
}

async function screenshotPixels(
  canvas: HTMLCanvasElement,
  label: string,
): Promise<ScreenshotPixels> {
  const shot = await page.elementLocator(canvas).screenshot({
    path: `../../../../artifacts/sun-atmosphere-calibration/${label}.png`,
    base64: true,
  });
  const base64 = typeof shot === 'string' ? shot : shot.base64;
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = surface.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    bitmap.close();
    throw new Error('sun-atmosphere: screenshot pixel context unavailable');
  }
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width: image.width, height: image.height, pixels: new Uint8Array(image.data) };
}

async function submitFrame(
  world: World,
  renderer: Renderer,
  lease: RenderWorldLease,
): Promise<void> {
  propagateTransforms(world).unwrap();
  const drawn = renderer.draw({
    leases: [lease],
    camera: { lease },
    environment: { lease },
    fixedStep: world.getResource(FixedTime).tick,
  });
  if (!drawn.ok) throw drawn.error;
  const completed = await drawn.value.completed;
  if (!completed.ok) throw completed.error;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function captureFrame(
  world: World,
  renderer: Renderer,
  lease: RenderWorldLease,
  canvas: HTMLCanvasElement,
  label: string,
): Promise<FrameSample> {
  await submitFrame(world, renderer, lease);
  const pixels = await screenshotPixels(canvas, label);
  const inspection = renderer.inspect();
  return { pixels, inspection };
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_WIDTH;
  canvas.height = OUTPUT_HEIGHT;
  canvas.style.width = `${OUTPUT_WIDTH}px`;
  canvas.style.height = `${OUTPUT_HEIGHT}px`;
  document.body.append(canvas);
  return canvas;
}

function attachRenderer(renderer: Renderer, world: World): RenderWorldLease {
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  return attached.value;
}

function setAtmosphere(
  world: World,
  entity: EntityHandle,
  strength: number,
  width: number,
  sunAngularRadius = DISC_RADIUS,
): void {
  world
    .set(entity, Atmosphere, {
      ...WAVE1_ATMOSPHERE_PRESET,
      circumsolarStrength: strength,
      circumsolarWidth: width,
      sunAngularRadius,
    })
    .unwrap();
}

it('calibrates Atmosphere strength and width with fixed exposure and sun disc', async () => {
  const canvas = createCanvas();
  const rendererResult = await createRenderer(
    canvas,
    {},
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!rendererResult.ok) throw rendererResult.error;
  const renderer = rendererResult.value;
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const recipe = createWave1RenderingRecipe(world, {
    aspect: OUTPUT_WIDTH / OUTPUT_HEIGHT,
    includeAtmosphere: true,
  });
  const atmosphere = recipe.entities.atmosphere;
  if (atmosphere === undefined) throw new Error('sun-atmosphere: fixture Atmosphere missing');
  recipe.destroy(recipe.entities.wall);
  recipe.destroy(recipe.entities.floor);
  recipe.destroy(recipe.entities.screen);
  recipe.destroy(recipe.entities.roof);
  recipe.destroy(recipe.entities.skylight);
  recipe.destroy(recipe.entities.localLight);
  world
    .set(recipe.entities.camera, Camera, {
      exposureMode: CAMERA_EXPOSURE_MODE_MANUAL,
      exposure: 1,
      bloom: BLOOM_DISABLED,
      antialias: ANTIALIAS_NONE,
    })
    .unwrap();
  const lease = attachRenderer(renderer, world);
  try {
    const directions = [
      ['daylight', DAYLIGHT],
      ['low-sun', LOW_SUN],
    ] as const;
    const evidence: Record<string, unknown> = {};
    for (const [name, direction] of directions) {
      world.set(recipe.entities.sun, DirectionalLight, { direction }).unwrap();
      setAtmosphere(world, atmosphere, 0, 1);
      world.update(1 / 60).unwrap();
      const strengthZero = await captureFrame(world, renderer, lease, canvas, `${name}-strength-0`);
      setAtmosphere(world, atmosphere, 1, 1);
      world.update(1 / 60).unwrap();
      const strengthOne = await captureFrame(world, renderer, lease, canvas, `${name}-strength-1`);
      setAtmosphere(world, atmosphere, 1, 0.5);
      world.update(1 / 60).unwrap();
      const widthNarrow = await captureFrame(world, renderer, lease, canvas, `${name}-width-0.5`);
      setAtmosphere(world, atmosphere, 1, 2);
      world.update(1 / 60).unwrap();
      const widthWide = await captureFrame(world, renderer, lease, canvas, `${name}-width-2`);
      const skyRoi = SKY_ROIS[name];
      const horizonRoi = HORIZON_ROIS[name];
      const zeroStats = roiStats(strengthZero.pixels, skyRoi, DISC_RADIUS * 1.25);
      const oneStats = roiStats(strengthOne.pixels, skyRoi, DISC_RADIUS * 1.25);
      const narrowStats = roiStats(widthNarrow.pixels, skyRoi, DISC_RADIUS * 1.25);
      const wideStats = roiStats(widthWide.pixels, skyRoi, DISC_RADIUS * 1.25);
      const horizonStats = roiStats(widthWide.pixels, horizonRoi);
      const camera = world.get(recipe.entities.camera, Camera).unwrap();
      const authored = world.get(atmosphere, Atmosphere).unwrap();
      expect(camera.exposureMode).toBe(CAMERA_EXPOSURE_MODE_MANUAL);
      expect(camera.exposure).toBe(1);
      expect(camera.bloom).toBe(BLOOM_DISABLED);
      expect(authored.sunAngularRadius).toBeCloseTo(DISC_RADIUS, 6);
      for (const stats of [zeroStats, oneStats, narrowStats, wideStats, horizonStats]) {
        expect(stats.finitePixels).toBe(stats.pixelCount);
        expect(stats.nonBlackPixels).toBeGreaterThan(0);
        expect(Number.isFinite(stats.meanLuma)).toBe(true);
        expect(Number.isFinite(stats.radialWidth)).toBe(true);
      }
      expect(pixelDelta(strengthZero.pixels, strengthOne.pixels, skyRoi)).toBeGreaterThan(0);
      expect(oneStats.meanLuma).toBeGreaterThan(zeroStats.meanLuma + MIN_STRENGTH_LUMA_DELTA);
      expect(wideStats.radialWidth).toBeGreaterThan(
        narrowStats.radialWidth + MIN_WIDTH_RADIAL_DELTA,
      );
      evidence[name] = {
        direction,
        camera: {
          exposureMode: camera.exposureMode,
          exposure: camera.exposure,
          bloom: camera.bloom,
        },
        sunAngularRadius: authored.sunAngularRadius,
        skyRoi,
        horizonRoi,
        strengthDeltaPixels: pixelDelta(strengthZero.pixels, strengthOne.pixels, skyRoi),
        strengthZero: zeroStats,
        strengthOne: oneStats,
        widthNarrow: narrowStats,
        widthWide: wideStats,
        horizon: horizonStats,
        inspection: widthWide.inspection.observation,
      };
    }
    // biome-ignore lint/suspicious/noConsole: fixed calibration receipt for browser evidence.
    console.info(
      '[solar-atmosphere-calibration] calibration',
      JSON.stringify({ output: [OUTPUT_WIDTH, OUTPUT_HEIGHT], evidence }),
    );
  } finally {
    await renderer.dispose();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 180_000);

it('projects authored VolumetricFog density from World time across pause and redraw', async () => {
  const canvas = createCanvas();
  const rendererResult = await createRenderer(
    canvas,
    {},
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!rendererResult.ok) throw rendererResult.error;
  const renderer = rendererResult.value;
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const recipe = createWave1RenderingRecipe(world, { aspect: 1, includeAtmosphere: false });
  recipe.destroy(recipe.entities.screen);
  recipe.destroy(recipe.entities.localLight);
  recipe.destroy(recipe.entities.skylight);
  world
    .set(recipe.entities.camera, Camera, {
      exposureMode: CAMERA_EXPOSURE_MODE_MANUAL,
      exposure: 1,
      bloom: BLOOM_DISABLED,
      antialias: ANTIALIAS_NONE,
    })
    .unwrap();
  const authoredCamera = world.get(recipe.entities.camera, Camera).unwrap();
  const authoredTransform = world.get(recipe.entities.camera, Transform).unwrap();
  const cameraProjection: CameraProjectionConfig = {
    position: [
      authoredTransform.pos[0] ?? 0,
      authoredTransform.pos[1] ?? 0,
      authoredTransform.pos[2] ?? 0,
    ],
    fov: authoredCamera.fov,
    near: authoredCamera.near,
    far: authoredCamera.far,
  };
  const density = world.allocSharedRef('TextureAsset', createDensity());
  const fogData = {
    light: recipe.entities.sun,
    density,
    boundsMin: [-8, -4, -2] as const,
    boundsMax: [8, 4, 6] as const,
    extinction: [0.28, 0.28, 0.28] as const,
    albedo: [0.8, 0.8, 0.8] as const,
    emission: [0, 0, 0] as const,
    anisotropy: 0,
    maxDistance: 30,
  };
  const fog = world
    .spawn({
      component: VolumetricFog,
      data: fogData,
    })
    .unwrap();
  recipe.destroy(recipe.entities.roof);
  const caster = recipe.spawnSuccessor(ROOF_OPEN_POSITION);
  const lease = attachRenderer(renderer, world);
  try {
    // Keep the solar direction off-screen while the ordinary roof remains in
    // the camera frustum and inside the light's configured shadow distance.
    // This is a geometric receipt for the intended off-screen-light case; it
    // does not pretend that the camera can observe the sun disc itself.
    const solarProjection = projectSolarDirection(OFFSCREEN_SUN, cameraProjection);
    expect(solarProjection.inViewport).toBe(false);
    expect(Math.abs(solarProjection.ndcX)).toBeGreaterThan(1);
    recipe.setPosition(caster, ROOF_CASTER_POSITION);
    world.set(recipe.entities.sun, DirectionalLight, { direction: OFFSCREEN_SUN }).unwrap();
    const assertOffscreenSun = (): void => {
      const actual = world.get(recipe.entities.sun, DirectionalLight).unwrap().direction;
      for (let index = 0; index < OFFSCREEN_SUN.length; index += 1) {
        expect(actual[index]).toBeCloseTo(OFFSCREEN_SUN[index] ?? 0, 5);
      }
    };
    assertOffscreenSun();
    world.update(1 / 60).unwrap();
    const offscreenSolarFrame = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      'fog-solar-offscreen-caster-in-coverage',
    );
    expect(offscreenSolarFrame.inspection.perFramePassNames).toContain('shadowCascade0');
    expect(offscreenSolarFrame.inspection.volumetricFog?.status).toBe('available');

    assertOffscreenSun();
    world.update(1 / 60).unwrap();
    const first = await captureFrame(world, renderer, lease, canvas, 'fog-time-1');
    const firstTime = world.getResource(Time).elapsed;
    const firstTick = world.getResource(FixedTime).tick;
    const firstStats = roiStats(first.pixels, FOG_ROI);
    expect(first.inspection.volumetricFog?.status).toBe('available');
    expect(first.inspection.perFramePassNames).toContain('volume-composite');
    expect(firstStats.nonBlackPixels).toBeGreaterThan(0);

    // Redraws advance the renderer frame receipt, but World time and FixedTime
    // stay frozen until the owning World is updated. This is the production
    // proof that medium motion does not use a second wall-clock.
    const paused = await captureFrame(world, renderer, lease, canvas, 'fog-time-paused');
    // Let the production volume history settle while the simulation clock is
    // frozen; compare the final pair instead of the first jittered samples.
    let pausedAgain = paused;
    for (let sample = 0; sample < 6; sample += 1) {
      if (sample < 5) {
        await submitFrame(world, renderer, lease);
        continue;
      }
      pausedAgain = await captureFrame(
        world,
        renderer,
        lease,
        canvas,
        `fog-time-paused-settle-${sample}`,
      );
    }
    expect(world.getResource(Time).elapsed).toBe(firstTime);
    expect(world.getResource(FixedTime).tick).toBe(firstTick);
    expect(pausedAgain.inspection.frame.frameId).toBeGreaterThan(paused.inspection.frame.frameId);
    expect(paused.inspection.volumetricFog?.status).toBe('available');
    const pausedStats = roiStats(paused.pixels, FOG_ROI);
    const pausedAgainStats = roiStats(pausedAgain.pixels, FOG_ROI);
    const pausedMeanLumaDelta = Math.abs(pausedStats.meanLuma - pausedAgainStats.meanLuma);
    expect(pausedMeanLumaDelta).toBeLessThanOrEqual(MAX_PAUSED_FOG_MEAN_LUMA_DELTA);

    world.update(1 / 60).unwrap();
    const resumed = await captureFrame(world, renderer, lease, canvas, 'fog-time-resumed');
    const resumedTime = world.getResource(Time).elapsed;
    expect(resumedTime).toBeGreaterThan(firstTime);
    expect(world.getResource(FixedTime).tick).toBeGreaterThan(firstTick);
    expect(resumed.inspection.volumetricFog?.status).toBe('available');
    expect(resumed.inspection.volumetricFog?.resourceFacts).toBeDefined();
    const resumedStats = roiStats(resumed.pixels, FOG_ROI);
    expect(Number.isFinite(resumedStats.meanLuma)).toBe(true);
    expect(pixelDelta(first.pixels, resumed.pixels, FOG_ROI)).toBeGreaterThan(0);

    // Freeze the simulation clock after the resumed frame. The same ordinary
    // Mesh caster is first outside the shadow fit, then moved into the solar
    // path while the measured ROI remains free of caster pixels, and finally
    // shifted laterally. Three redraws per state bound temporal convergence
    // without introducing another wall clock or a synthetic beam primitive.
    const beamRoi: Roi = { centerX: 0.78, centerY: 0.35, halfWidth: 0.04, halfHeight: 0.04 };
    const beamBackgroundRoi: Roi = {
      centerX: 0.9,
      centerY: 0.35,
      halfWidth: 0.04,
      halfHeight: 0.04,
    };
    // Keep the existing surface/depth projection fixed. The successor caster
    // is an ordinary Mesh whose complete projected bounds are checked against
    // this common ROI, so a response cannot be explained by its own pixels.
    const casterProjection = projectCameraBounds(
      ROOF_CASTER_POSITION,
      CASTER_HALF_EXTENTS,
      beamRoi,
      cameraProjection,
    );
    const movedCasterProjection = projectCameraBounds(
      ROOF_MOVED_POSITION,
      CASTER_HALF_EXTENTS,
      beamRoi,
      cameraProjection,
    );
    expect(casterProjection.minDepth).toBeGreaterThanOrEqual(cameraProjection.near);
    expect(casterProjection.maxDepth).toBeLessThanOrEqual(CAMERA_SHADOW_DISTANCE);
    expect(casterProjection.maxNdcX).toBeGreaterThanOrEqual(-1);
    expect(casterProjection.minNdcX).toBeLessThanOrEqual(1);
    expect(casterProjection.maxNdcY).toBeGreaterThanOrEqual(-1);
    expect(casterProjection.minNdcY).toBeLessThanOrEqual(1);
    expect(casterProjection.roiMinNdcY).toBeCloseTo(
      1 - 2 * (beamRoi.centerY + beamRoi.halfHeight),
      12,
    );
    expect(casterProjection.roiMaxNdcY).toBeCloseTo(
      1 - 2 * (beamRoi.centerY - beamRoi.halfHeight),
      12,
    );
    expect(casterProjection.roiMinNdcY).toBeLessThan(casterProjection.roiMaxNdcY);
    expect(casterProjection.intersects).toBe(false);
    expect(movedCasterProjection.intersects).toBe(false);
    const frozenTime = world.getResource(Time).elapsed;
    const frozenTick = world.getResource(FixedTime).tick;
    const captureFrozen = async (prefix: string): Promise<FrameSample[]> => {
      const frames: FrameSample[] = [];
      for (let sample = 0; sample < 3; sample += 1) {
        frames.push(await captureFrame(world, renderer, lease, canvas, `${prefix}-${sample}`));
      }
      return frames;
    };
    recipe.setPosition(caster, ROOF_OPEN_POSITION);
    const beamOpen = await captureFrozen('fog-beam-open');
    assertOffscreenSun();
    recipe.setPosition(caster, ROOF_CASTER_POSITION);
    const beamClosed = await captureFrozen('fog-beam-closed');
    assertOffscreenSun();
    recipe.setPosition(caster, ROOF_MOVED_POSITION);
    const beamMoved = await captureFrozen('fog-beam-moved');
    assertOffscreenSun();
    recipe.setPosition(caster, ROOF_OPEN_POSITION);
    const beamRestored = await captureFrozen('fog-beam-restored');
    expect(world.getResource(Time).elapsed).toBe(frozenTime);
    expect(world.getResource(FixedTime).tick).toBe(frozenTick);
    const finalFrame = (frames: readonly FrameSample[]): FrameSample => {
      const frame = frames.at(-1);
      if (frame === undefined) throw new Error('frozen beam capture produced no frame');
      return frame;
    };
    const beamOpenFrame = finalFrame(beamOpen);
    const beamClosedFrame = finalFrame(beamClosed);
    const beamMovedFrame = finalFrame(beamMoved);
    const beamRestoredFrame = finalFrame(beamRestored);
    const beamOpenStats = roiStats(beamOpenFrame.pixels, beamRoi);
    const beamClosedStats = roiStats(beamClosedFrame.pixels, beamRoi);
    const beamMovedStats = roiStats(beamMovedFrame.pixels, beamRoi);
    const beamRestoredStats = roiStats(beamRestoredFrame.pixels, beamRoi);
    const backgroundOpenStats = roiStats(beamOpenFrame.pixels, beamBackgroundRoi);
    const backgroundClosedStats = roiStats(beamClosedFrame.pixels, beamBackgroundRoi);
    const backgroundMeanLumaDelta = Math.abs(
      backgroundOpenStats.meanLuma - backgroundClosedStats.meanLuma,
    );
    const openToClosedLuma = beamOpenStats.meanLuma - beamClosedStats.meanLuma;
    const movedToRestoredLuma = beamRestoredStats.meanLuma - beamMovedStats.meanLuma;
    expect(openToClosedLuma).toBeGreaterThan(MIN_ENABLED_BEAM_MEAN_LUMA_DELTA);
    expect(movedToRestoredLuma).toBeGreaterThan(MIN_ENABLED_BEAM_MEAN_LUMA_DELTA);
    expect(Math.abs(beamOpenStats.meanLuma - beamRestoredStats.meanLuma)).toBeLessThanOrEqual(
      MAX_PAUSED_FOG_MEAN_LUMA_DELTA,
    );

    const beamStateMeanLumaDelta = (frames: readonly FrameSample[], roi: Roi): number => {
      const first = frames[0];
      const last = frames.at(-1);
      if (first === undefined || last === undefined) {
        throw new Error('frozen beam settle window produced no frames');
      }
      return Math.abs(roiStats(first.pixels, roi).meanLuma - roiStats(last.pixels, roi).meanLuma);
    };
    const beamSettledMeanLumaDelta = (frames: readonly FrameSample[], roi: Roi): number => {
      const last = frames.at(-1);
      const previous = frames.at(-2);
      if (last === undefined || previous === undefined) {
        throw new Error('frozen beam settle window needs two frames');
      }
      return Math.abs(
        roiStats(previous.pixels, roi).meanLuma - roiStats(last.pixels, roi).meanLuma,
      );
    };

    // Controls use the identical fixed-time open/closed sequence. Removing
    // VolumetricFog must eliminate the beam response while preserving the
    // ordinary Mesh caster and its shadow pass.
    world.removeComponent(fog, VolumetricFog).unwrap();
    assertOffscreenSun();
    recipe.setPosition(caster, ROOF_OPEN_POSITION);
    const fogDisabledOpen = await captureFrozen('fog-beam-fog-disabled-open');
    recipe.setPosition(caster, ROOF_CASTER_POSITION);
    const fogDisabledClosed = await captureFrozen('fog-beam-fog-disabled-closed');
    const fogDisabledOpenFrame = finalFrame(fogDisabledOpen);
    const fogDisabledClosedFrame = finalFrame(fogDisabledClosed);
    const fogDisabledDelta = Math.abs(
      roiStats(fogDisabledOpenFrame.pixels, beamRoi).meanLuma -
        roiStats(fogDisabledClosedFrame.pixels, beamRoi).meanLuma,
    );
    expect(fogDisabledOpenFrame.inspection.volumetricFog?.status).toBe('off');
    expect(fogDisabledOpenFrame.inspection.perFramePassNames).not.toContain('volume-composite');
    expect(fogDisabledDelta).toBeLessThanOrEqual(MAX_CONTROL_BEAM_MEAN_LUMA_DELTA);

    // Re-add the authored medium, then disable only DirectionalLight shadows.
    // The fog stays active, but the Mesh caster can no longer occlude the
    // light transport. The control therefore removes the open/closed beam
    // contrast while keeping volume passes present.
    world
      .addComponent(fog, {
        component: VolumetricFog,
        data: fogData,
      })
      .unwrap();
    world.set(recipe.entities.sun, DirectionalLight, { castShadow: false }).unwrap();
    world.update(0).unwrap();
    assertOffscreenSun();
    recipe.setPosition(caster, ROOF_OPEN_POSITION);
    const shadowDisabledOpen = await captureFrozen('fog-beam-shadow-disabled-open');
    recipe.setPosition(caster, ROOF_CASTER_POSITION);
    const shadowDisabledClosed = await captureFrozen('fog-beam-shadow-disabled-closed');
    const shadowDisabledOpenFrame = finalFrame(shadowDisabledOpen);
    const shadowDisabledClosedFrame = finalFrame(shadowDisabledClosed);
    const shadowDisabledDelta = Math.abs(
      roiStats(shadowDisabledOpenFrame.pixels, beamRoi).meanLuma -
        roiStats(shadowDisabledClosedFrame.pixels, beamRoi).meanLuma,
    );
    expect(shadowDisabledOpenFrame.inspection.volumetricFog?.status).toBe('available');
    expect(shadowDisabledOpenFrame.inspection.perFramePassNames).not.toContain('shadowCascade0');
    expect(shadowDisabledDelta).toBeLessThanOrEqual(MAX_CONTROL_BEAM_MEAN_LUMA_DELTA);

    // Every control uses the same three-redraw frozen window. A large first
    // to last drift would make the control comparison a temporal artifact.
    for (const frames of [
      fogDisabledOpen,
      fogDisabledClosed,
      shadowDisabledOpen,
      shadowDisabledClosed,
    ]) {
      expect(beamStateMeanLumaDelta(frames, beamRoi)).toBeLessThanOrEqual(
        MAX_PAUSED_FOG_MEAN_LUMA_DELTA,
      );
      expect(beamSettledMeanLumaDelta(frames, beamRoi)).toBeLessThanOrEqual(
        MAX_PAUSED_FOG_MEAN_LUMA_DELTA,
      );
    }
    for (const frames of [beamOpen, beamClosed, beamMoved, beamRestored]) {
      expect(beamSettledMeanLumaDelta(frames, beamRoi)).toBeLessThanOrEqual(
        MAX_PAUSED_FOG_MEAN_LUMA_DELTA,
      );
    }
    expect(world.getResource(Time).elapsed).toBe(frozenTime);
    expect(world.getResource(FixedTime).tick).toBe(frozenTick);
    world.set(recipe.entities.sun, DirectionalLight, { castShadow: true }).unwrap();
    recipe.setPosition(caster, ROOF_OPEN_POSITION);
    // biome-ignore lint/suspicious/noConsole: frozen beam receipt is browser evidence.
    console.info(
      '[solar-atmosphere-calibration] frozen-beam',
      JSON.stringify({
        worldTime: frozenTime,
        fixedTick: frozenTick,
        roi: beamRoi,
        backgroundRoi: beamBackgroundRoi,
        openToClosedLuma,
        movedToRestoredLuma,
        backgroundMeanLumaDelta,
        open: beamOpenStats,
        closed: beamClosedStats,
        moved: beamMovedStats,
        restored: beamRestoredStats,
        projection: {
          solarDirection: OFFSCREEN_SUN,
          solar: solarProjection,
          caster: { position: ROOF_CASTER_POSITION, ...casterProjection },
          movedCaster: { position: ROOF_MOVED_POSITION, ...movedCasterProjection },
          shadowDistance: CAMERA_SHADOW_DISTANCE,
        },
        controls: {
          fogDisabledDelta,
          shadowDisabledDelta,
          fogDisabledSettle: beamStateMeanLumaDelta(fogDisabledOpen, beamRoi),
          shadowDisabledSettle: beamStateMeanLumaDelta(shadowDisabledOpen, beamRoi),
          fogDisabledFinalPair: beamSettledMeanLumaDelta(fogDisabledOpen, beamRoi),
          shadowDisabledFinalPair: beamSettledMeanLumaDelta(shadowDisabledOpen, beamRoi),
        },
      }),
    );

    // The entity remains an ordinary MeshFilter/MeshRenderer owner. Changing
    // its authored asset is the supported opening/closure seam; no volume
    // blocker or synthetic shadow is introduced by this carrier.
    world
      .set(recipe.entities.wall, MeshFilter, { assetHandle: recipe.assets.wallApertureHandle })
      .unwrap();
    world.update(1 / 60).unwrap();
    const opening = await captureFrame(world, renderer, lease, canvas, 'fog-opening');
    world
      .set(recipe.entities.wall, MeshFilter, { assetHandle: recipe.assets.wallClosedHandle })
      .unwrap();
    world.update(1 / 60).unwrap();
    const closure = await captureFrame(world, renderer, lease, canvas, 'fog-closure');
    expect(pixelDelta(opening.pixels, closure.pixels, FOG_ROI)).toBeGreaterThan(0);

    // Move the same ordinary Mesh occluder out of and back into the authored
    // solar ray. The renderer keeps the authored fog resource alive in both
    // states and reports its lifecycle through inspect().
    recipe.setPosition(recipe.entities.wall, [12, 0, 0]);
    world.update(1 / 60).unwrap();
    const moved = await captureFrame(world, renderer, lease, canvas, 'fog-occluder-moved');
    recipe.setPosition(recipe.entities.wall, [0, 0, 0]);
    world.update(1 / 60).unwrap();
    const restored = await captureFrame(world, renderer, lease, canvas, 'fog-occluder-restored');
    expect(pixelDelta(moved.pixels, restored.pixels, FOG_ROI)).toBeGreaterThan(0);
    // biome-ignore lint/suspicious/noConsole: deterministic World/fog browser receipt.
    console.info(
      '[solar-atmosphere-calibration] authored-fog',
      JSON.stringify({
        output: [OUTPUT_WIDTH, OUTPUT_HEIGHT],
        roi: FOG_ROI,
        worldTime: { first: firstTime, resumed: resumedTime },
        fixedTick: { first: firstTick, resumed: world.getResource(FixedTime).tick },
        frame: {
          first: first.inspection.frame,
          paused: paused.inspection.frame,
          pausedAgain: pausedAgain.inspection.frame,
          resumed: resumed.inspection.frame,
        },
        pixels: {
          first: firstStats,
          resumed: resumedStats,
          pauseMeanLumaDelta: pausedMeanLumaDelta,
          resumeDelta: pixelDelta(first.pixels, resumed.pixels, FOG_ROI),
          openingToClosure: pixelDelta(opening.pixels, closure.pixels, FOG_ROI),
          movedToRestored: pixelDelta(moved.pixels, restored.pixels, FOG_ROI),
        },
        volumetricFog: resumed.inspection.volumetricFog,
        temporal: resumed.inspection.temporal,
        resources: resumed.inspection.observation.resourceStats,
        passes: resumed.inspection.perFramePassNames,
      }),
    );
  } finally {
    await renderer.dispose();
    world.despawn(fog).unwrap();
    world.sharedRefs.release(density).unwrap();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 180_000);

it('keeps sun disc occlusion stable across ordinary Mesh pause and resume redraws', async () => {
  const canvas = createCanvas();
  const rendererResult = await createRenderer(
    canvas,
    {},
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!rendererResult.ok) throw rendererResult.error;
  const renderer = rendererResult.value;
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const recipe = createWave1RenderingRecipe(world, { aspect: 1, includeAtmosphere: true });
  const atmosphere = recipe.entities.atmosphere;
  if (atmosphere === undefined) throw new Error('sun-atmosphere: fixture Atmosphere missing');
  recipe.destroy(recipe.entities.floor);
  recipe.destroy(recipe.entities.screen);
  recipe.destroy(recipe.entities.roof);
  recipe.destroy(recipe.entities.skylight);
  recipe.destroy(recipe.entities.localLight);
  world
    .set(recipe.entities.camera, Camera, {
      exposureMode: CAMERA_EXPOSURE_MODE_MANUAL,
      exposure: 1,
      bloom: BLOOM_DISABLED,
      antialias: ANTIALIAS_TAA,
    })
    .unwrap();
  const lease = attachRenderer(renderer, world);
  try {
    const discRoi: Roi = { centerX: 0.5, centerY: 0.5, halfWidth: 0.1, halfHeight: 0.1 };
    // Keep the original wall out of the view, then use the recipe's default
    // replacement wall on the low-sun ray. Matched radius-zero/radius-nonzero
    // pairs isolate the authored disc contribution from unrelated geometry.
    recipe.destroy(recipe.entities.wall);
    world.set(recipe.entities.sun, DirectionalLight, { direction: LOW_SUN }).unwrap();
    setAtmosphere(world, atmosphere, 1, 1, 0);
    world.update(1 / 60).unwrap();
    const openNoDisc = await captureFrame(world, renderer, lease, canvas, 'occlusion-open-no-disc');
    setAtmosphere(world, atmosphere, 1, 1);
    world.update(1 / 60).unwrap();
    const openDisc = await captureFrame(world, renderer, lease, canvas, 'occlusion-open-disc');
    const occluder = recipe.spawnReplacement();
    setAtmosphere(world, atmosphere, 1, 1, 0);
    world.update(1 / 60).unwrap();
    const blockedNoDisc = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      'occlusion-blocked-no-disc',
    );
    setAtmosphere(world, atmosphere, 1, 1);
    world.update(1 / 60).unwrap();
    const blockedDisc = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      'occlusion-blocked-disc',
    );
    const openDiscContribution = pixelDelta(openNoDisc.pixels, openDisc.pixels, discRoi);
    const blockedDiscContribution = pixelDelta(blockedNoDisc.pixels, blockedDisc.pixels, discRoi);
    expect(openDiscContribution).toBeGreaterThan(0);
    expect(blockedDiscContribution).toBe(0);
    recipe.destroy(occluder);
    world.update(1 / 60).unwrap();
    const restoredDisc = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      'occlusion-restored-disc',
    );
    expect(pixelDelta(blockedDisc.pixels, restoredDisc.pixels, discRoi)).toBeGreaterThan(0);
    const beforePauseTime = world.getResource(Time).elapsed;
    const paused = await captureFrame(world, renderer, lease, canvas, 'occlusion-paused-redraw');
    expect(world.getResource(Time).elapsed).toBe(beforePauseTime);
    world.update(1 / 60).unwrap();
    const resumed = await captureFrame(world, renderer, lease, canvas, 'occlusion-resumed');
    expect(world.getResource(Time).elapsed).toBeGreaterThan(beforePauseTime);
    expect(paused.inspection.observation.resourceStats).toBeDefined();
    expect(resumed.inspection.observation.resourceStats).toBeDefined();
    expect(['available', 'stable']).toContain(resumed.inspection.temporal.status);
    // biome-ignore lint/suspicious/noConsole: temporal/resource state is the browser acceptance receipt.
    console.info(
      '[solar-atmosphere-calibration] occlusion',
      JSON.stringify({
        discRadius: DISC_RADIUS,
        pause: { worldTime: beforePauseTime, frame: paused.inspection.frame },
        resume: { worldTime: world.getResource(Time).elapsed, frame: resumed.inspection.frame },
        deltas: {
          openDiscContribution,
          blockedDiscContribution,
          blockedToRestored: pixelDelta(blockedDisc.pixels, restoredDisc.pixels, discRoi),
        },
        temporal: resumed.inspection.temporal,
        observation: resumed.inspection.observation,
        recoveryGraph: resumed.inspection.recoveryEvidence.graph,
        passes: resumed.inspection.perFramePassNames,
      }),
    );
  } finally {
    await renderer.dispose();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 180_000);

it.each([
  'forward',
  'deferred',
] as const)('keeps authored fog composed with a transparent foreground through %s TAA resize', async (renderPath) => {
  const canvas = createCanvas();
  const rendererResult = await createRenderer(
    canvas,
    {
      standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath },
    },
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!rendererResult.ok) throw rendererResult.error;
  const renderer = rendererResult.value;
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const recipe = createWave1RenderingRecipe(world, { aspect: 1, includeAtmosphere: false });
  recipe.destroy(recipe.entities.screen);
  recipe.destroy(recipe.entities.localLight);
  recipe.destroy(recipe.entities.skylight);
  recipe.destroy(recipe.entities.roof);
  world
    .set(recipe.entities.camera, Camera, {
      exposureMode: CAMERA_EXPOSURE_MODE_MANUAL,
      exposure: 1,
      bloom: BLOOM_DISABLED,
      antialias: ANTIALIAS_TAA,
    })
    .unwrap();
  const compositionDensity = createDensity();
  // The optical carriers already exercise heterogeneous density. Keep this
  // composition oracle spatially quiet so the frozen near/far signal cannot be
  // hidden by per-frame volume sampling noise. The midpoint value survives
  // the production density remap, keeping the authored medium active instead
  // of turning the fog into a bypass.
  compositionDensity.data.fill(128);
  const density = world.allocSharedRef('TextureAsset', compositionDensity);
  const fog = world
    .spawn({
      component: VolumetricFog,
      data: {
        light: recipe.entities.sun,
        density,
        boundsMin: [-8, -4, -2] as const,
        boundsMax: [8, 4, 6] as const,
        // Keep the authored volume visible enough that the foreground color
        // remains a measurable composition witness while still exercising the
        // production volume-composite path.
        extinction: [0.04, 0.04, 0.04] as const,
        albedo: [0.8, 0.8, 0.8] as const,
        emission: [0, 0, 0] as const,
        anisotropy: 0,
        maxDistance: 30,
      },
    })
    .unwrap();
  const transparentMaterial = world.allocSharedRef(
    'MaterialAsset',
    Materials.unlit([0.05, 0.95, 0.2, 0.72], {
      queue: 3000,
      renderState: {
        cullMode: 'none',
        depthWriteEnabled: false,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      },
    }),
  );
  const transparent = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 1] } },
      { component: MeshFilter, data: { assetHandle: recipe.assets.successorHandle } },
      { component: MeshRenderer, data: { materials: [transparentMaterial, transparentMaterial] } },
      { component: ShadowParticipation, data: { cast: false, receive: true } },
    )
    .unwrap();
  // The Standard pipelines expose the dedicated transparent draw lane when
  // the scene has transmission demand. Keep that demand off-screen so the
  // visible authored unlit blend exercises the production lane without
  // changing the camera fixture.
  const transmissionTriggerMaterial = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0, 0, 0, 0],
      metallic: 0,
      roughness: 1,
      transmission: 1,
    }),
  );
  const transmissionTrigger = world
    .spawn(
      { component: Transform, data: { pos: TRANSPARENT_OFFSCREEN_POSITION } },
      { component: MeshFilter, data: { assetHandle: recipe.assets.successorHandle } },
      {
        component: MeshRenderer,
        data: { materials: [transmissionTriggerMaterial, transmissionTriggerMaterial] },
      },
      { component: ShadowParticipation, data: { cast: false, receive: true } },
    )
    .unwrap();
  const authoredCamera = world.get(recipe.entities.camera, Camera).unwrap();
  const authoredTransform = world.get(recipe.entities.camera, Transform).unwrap();
  const cameraProjection: CameraProjectionConfig = {
    position: [
      authoredTransform.pos[0] ?? 0,
      authoredTransform.pos[1] ?? 0,
      authoredTransform.pos[2] ?? 0,
    ],
    fov: authoredCamera.fov,
    near: authoredCamera.near,
    far: authoredCamera.far,
  };
  const nearProjection = projectCameraBounds(
    TRANSPARENT_NEAR_POSITION,
    TRANSPARENT_HALF_EXTENTS,
    TRANSPARENT_COMPOSITION_ROI,
    cameraProjection,
  );
  const farProjection = projectCameraBounds(
    TRANSPARENT_FAR_POSITION,
    TRANSPARENT_HALF_EXTENTS,
    TRANSPARENT_COMPOSITION_ROI,
    cameraProjection,
  );
  const nearRightBoxProjection = projectCameraBounds(
    [0.42, 0, TRANSPARENT_NEAR_POSITION[2]],
    TRANSPARENT_RIGHT_BOX_HALF_EXTENTS,
    TRANSPARENT_COMPOSITION_ROI,
    cameraProjection,
  );
  const farRightBoxProjection = projectCameraBounds(
    [0.42, 0, TRANSPARENT_FAR_POSITION[2]],
    TRANSPARENT_RIGHT_BOX_HALF_EXTENTS,
    TRANSPARENT_COMPOSITION_ROI,
    cameraProjection,
  );
  expect(nearProjection.intersects).toBe(true);
  expect(farProjection.intersects).toBe(true);
  expect(nearProjection.minDepth).toBeLessThan(farProjection.minDepth);
  expect(nearRightBoxProjection.containsRoi).toBe(true);
  expect(farRightBoxProjection.containsRoi).toBe(true);
  const opaqueWallFrontDepth = cameraProjection.position[2] - 0.55 / 2;
  expect(nearProjection.minDepth).toBeLessThan(opaqueWallFrontDepth);
  expect(opaqueWallFrontDepth).toBeLessThan(farProjection.minDepth);
  const lease = attachRenderer(renderer, world);
  try {
    world.set(recipe.entities.sun, DirectionalLight, { direction: DAYLIGHT }).unwrap();
    world.update(1 / 60).unwrap();
    const initial = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      `composition-${renderPath}-initial`,
    );
    const initialVolume = initial.inspection.volumetricFog;
    expect(initialVolume?.status).toBe('available');
    expect(initialVolume?.resourceFacts?.totalBytes).toBeGreaterThan(0);
    const volumePass = initial.inspection.perFramePassNames.indexOf('volume-composite');
    // The public inspection roster names the volume composite explicitly;
    // transparent draw ownership is proved by the authored blend material
    // and the foreground on/off pixel pair below, so it does not depend on
    // an internal per-frame pass label.
    expect(volumePass).toBeGreaterThanOrEqual(0);
    expect(initial.inspection.temporal.mode).toBe('taa');
    expect(initial.inspection.standardLighting?.renderPath).toBe(renderPath);

    // Keep the world and fixed clocks frozen while the transparent box moves
    // from in front of the opaque wall to behind it. The near/far geometry
    // shares this projected ROI, so a signal above the no-op redraw noise is
    // attributable to transparent composition rather than fog time or camera
    // motion. The offscreen pair is an unchanged control for TAA redraw noise.
    // Establish the causal depth baseline with TAA disabled; the same authored
    // scene is switched back to TAA immediately afterward for the resize and
    // history assertions below.
    world.set(recipe.entities.camera, Camera, { antialias: ANTIALIAS_NONE }).unwrap();
    const noTaaWarmup = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      `composition-${renderPath}-transparent-depth-baseline`,
    );
    expect(noTaaWarmup.inspection.temporal.mode).toBe('none');
    const frozenWorldTime = world.getResource(Time).elapsed;
    const frozenFixedTick = world.getResource(FixedTime).tick;
    const captureFrozen = async (prefix: string): Promise<FrameSample[]> => {
      const frames: FrameSample[] = [];
      for (let sample = 0; sample < TRANSPARENT_FROZEN_SAMPLES; sample += 1) {
        if (sample < TRANSPARENT_FROZEN_SAMPLES - 2) {
          await submitFrame(world, renderer, lease);
        } else {
          frames.push(
            await captureFrame(
              world,
              renderer,
              lease,
              canvas,
              `composition-${renderPath}-${prefix}-${sample}`,
            ),
          );
        }
        expect(world.getResource(Time).elapsed).toBe(frozenWorldTime);
        expect(world.getResource(FixedTime).tick).toBe(frozenFixedTick);
      }
      return frames;
    };

    recipe.setPosition(transparent, TRANSPARENT_NEAR_POSITION);
    const nearFrames = await captureFrozen('foreground-near');
    recipe.setPosition(transparent, TRANSPARENT_FAR_POSITION);
    const farFrames = await captureFrozen('foreground-far');
    recipe.setPosition(transparent, TRANSPARENT_OFFSCREEN_POSITION);
    const offscreenFrames = await captureFrozen('foreground-offscreen');
    const nearFinal = nearFrames.at(-1);
    const nearPrevious = nearFrames.at(-2);
    const farFinal = farFrames.at(-1);
    const farPrevious = farFrames.at(-2);
    const offscreenFinal = offscreenFrames.at(-1);
    const offscreenPrevious = offscreenFrames.at(-2);
    if (
      nearFinal === undefined ||
      nearPrevious === undefined ||
      farFinal === undefined ||
      farPrevious === undefined ||
      offscreenFinal === undefined ||
      offscreenPrevious === undefined
    ) {
      throw new Error('sun-atmosphere: transparent frozen sample window was incomplete');
    }
    const nearNoise = roiMeanAbsoluteLumaDelta(
      nearPrevious.pixels,
      nearFinal.pixels,
      TRANSPARENT_COMPOSITION_ROI,
    );
    const farNoise = roiMeanAbsoluteLumaDelta(
      farPrevious.pixels,
      farFinal.pixels,
      TRANSPARENT_COMPOSITION_ROI,
    );
    const offscreenNoise = roiMeanAbsoluteLumaDelta(
      offscreenPrevious.pixels,
      offscreenFinal.pixels,
      TRANSPARENT_COMPOSITION_ROI,
    );
    const nearFarSignal = roiMeanAbsoluteLumaDelta(
      nearFinal.pixels,
      farFinal.pixels,
      TRANSPARENT_COMPOSITION_ROI,
    );
    const farOffscreenSignal = roiMeanAbsoluteLumaDelta(
      farFinal.pixels,
      offscreenFinal.pixels,
      TRANSPARENT_COMPOSITION_ROI,
    );
    expect(nearNoise).toBeLessThanOrEqual(MAX_TRANSPARENT_FROZEN_NOISE);
    expect(farNoise).toBeLessThanOrEqual(MAX_TRANSPARENT_FROZEN_NOISE);
    expect(offscreenNoise).toBeLessThanOrEqual(MAX_TRANSPARENT_FROZEN_NOISE);
    expect(nearFarSignal).toBeGreaterThan(
      Math.max(nearNoise, farNoise, offscreenNoise) + MIN_TRANSPARENT_FROZEN_SIGNAL,
    );
    expect(
      pixelDelta(nearFinal.pixels, farFinal.pixels, TRANSPARENT_COMPOSITION_ROI),
    ).toBeGreaterThan(0);
    expect(farOffscreenSignal).toBeLessThanOrEqual(
      MAX_TRANSPARENT_FROZEN_NOISE + MIN_TRANSPARENT_FROZEN_SIGNAL,
    );
    expect(farFinal.inspection.volumetricFog?.status).toBe('available');

    world.set(recipe.entities.camera, Camera, { antialias: ANTIALIAS_TAA }).unwrap();
    const taaRestored = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      `composition-${renderPath}-taa-restored`,
    );
    expect(taaRestored.inspection.temporal.mode).toBe('taa');

    canvas.width = 128;
    canvas.height = 192;
    canvas.style.width = '128px';
    canvas.style.height = '192px';
    world.set(recipe.entities.camera, Camera, { aspect: canvas.width / canvas.height }).unwrap();
    const resized = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      `composition-${renderPath}-resize`,
    );
    expect(resized.inspection.temporal.resetReason).toBe('resize');
    expect(resized.inspection.temporal.coverage).toEqual({ width: 128, height: 192 });
    expect(resized.inspection.volumetricFog?.status).toBe('available');
    expect(resized.inspection.volumetricFog?.resourceFacts?.totalBytes).toBeGreaterThan(0);

    recipe.setPosition(transparent, TRANSPARENT_NEAR_POSITION);
    world
      .set(recipe.entities.camera, Transform, {
        pos: [0, 0.15, 7],
        quat: [0, 0.02, 0, 0.9998],
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    const afterCut = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      `composition-${renderPath}-camera-cut`,
    );
    expect(afterCut.inspection.temporal.mode).toBe('taa');
    expect(afterCut.inspection.temporal.historyValid).toBe(true);
    expect(afterCut.inspection.volumetricFog?.status).toBe('available');
    expect(afterCut.inspection.volumetricFog?.resourceFacts?.totalBytes).toBeLessThanOrEqual(
      48 * 1024 * 1024,
    );
    for (let frame = 0; frame < 16; frame += 1) {
      world.update(1 / 60).unwrap();
      await submitFrame(world, renderer, lease);
      const settled = renderer.inspect();
      expect(settled.volumetricFog?.status).toBe('available');
      expect(settled.temporal.historyValid).toBe(true);
      expect(settled.volumetricFog?.resourceFacts?.totalBytes).toBeLessThanOrEqual(
        48 * 1024 * 1024,
      );
    }
    // biome-ignore lint/suspicious/noConsole: direct/deferred composition receipt.
    console.info(
      '[solar-atmosphere-calibration] transparent-composition',
      JSON.stringify({
        renderPath,
        initialFrame: initial.inspection.frame,
        transparentFrozen: {
          roi: TRANSPARENT_COMPOSITION_ROI,
          nearDepth: nearProjection,
          farDepth: farProjection,
          nearRightBox: nearRightBoxProjection,
          farRightBox: farRightBoxProjection,
          opaqueWallFrontDepth,
          nearNoise,
          farNoise,
          offscreenNoise,
          nearFarSignal,
          farOffscreenSignal,
        },
        resize: resized.inspection.temporal,
        afterCut: afterCut.inspection.temporal,
        volumetricFog: afterCut.inspection.volumetricFog,
        passes: afterCut.inspection.perFramePassNames,
      }),
    );
  } finally {
    await renderer.dispose();
    world.despawn(transparent).unwrap();
    world.sharedRefs.release(transparentMaterial).unwrap();
    world.despawn(transmissionTrigger).unwrap();
    world.sharedRefs.release(transmissionTriggerMaterial).unwrap();
    world.despawn(fog).unwrap();
    world.sharedRefs.release(density).unwrap();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 240_000);

it('replays volumetric output at equal World time across render schedules', async () => {
  const denseCanvas = createCanvas();
  const sparseCanvas = createCanvas();
  const createFixture = async (canvas: HTMLCanvasElement) => {
    const rendererResult = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    if (!rendererResult.ok) throw rendererResult.error;
    const renderer = rendererResult.value;
    const world = new World();
    const scene = await createWorldContext(world, [scenePlugin()]);
    const recipe = createWave1RenderingRecipe(world, { aspect: 1, includeAtmosphere: false });
    recipe.destroy(recipe.entities.screen);
    recipe.destroy(recipe.entities.localLight);
    recipe.destroy(recipe.entities.skylight);
    recipe.destroy(recipe.entities.roof);
    world
      .set(recipe.entities.camera, Camera, {
        exposureMode: CAMERA_EXPOSURE_MODE_MANUAL,
        exposure: 1,
        bloom: BLOOM_DISABLED,
        antialias: ANTIALIAS_NONE,
      })
      .unwrap();
    world.set(recipe.entities.sun, DirectionalLight, { direction: DAYLIGHT }).unwrap();
    const density = world.allocSharedRef('TextureAsset', createDensity());
    const fog = world
      .spawn({
        component: VolumetricFog,
        data: {
          light: recipe.entities.sun,
          density,
          boundsMin: [-8, -4, -2] as const,
          boundsMax: [8, 4, 6] as const,
          extinction: [0.28, 0.28, 0.28] as const,
          albedo: [0.8, 0.8, 0.8] as const,
          emission: [0, 0, 0] as const,
          anisotropy: 0,
          maxDistance: 30,
        },
      })
      .unwrap();
    const lease = attachRenderer(renderer, world);
    return { canvas, density, fog, lease, recipe, renderer, scene, world };
  };

  const dense = await createFixture(denseCanvas);
  const sparse = await createFixture(sparseCanvas);
  try {
    const replay = async (
      fixture: Awaited<ReturnType<typeof createFixture>>,
      steps: readonly (number | undefined)[],
      label: string,
    ): Promise<{ readonly final: FrameSample; readonly previous: FrameSample }> => {
      for (let index = 0; index < steps.length; index += 1) {
        const delta = steps[index];
        if (delta !== undefined) fixture.world.update(delta).unwrap();
        await submitFrame(fixture.world, fixture.renderer, fixture.lease);
      }
      let previous: FrameSample | undefined;
      let settled: FrameSample | undefined;
      for (let index = 0; index < 8; index += 1) {
        if (index < 6) {
          await submitFrame(fixture.world, fixture.renderer, fixture.lease);
          continue;
        }
        previous = settled;
        settled = await captureFrame(
          fixture.world,
          fixture.renderer,
          fixture.lease,
          fixture.canvas,
          `${label}-settle-${index}`,
        );
      }
      if (settled === undefined || previous === undefined) {
        throw new Error('equal-time replay produced no settled frame pair');
      }
      return { final: settled, previous };
    };

    const denseReplay = await replay(
      dense,
      [1 / 60, 1 / 60, 1 / 60, 1 / 60, 1 / 60, 1 / 60],
      'equal-time-dense',
    );
    const sparseReplay = await replay(
      sparse,
      [1 / 30, undefined, 1 / 30, undefined, 1 / 30, undefined],
      'equal-time-sparse',
    );
    const denseFinal = denseReplay.final;
    const sparseFinal = sparseReplay.final;
    const denseTime = dense.world.getResource(Time).elapsed;
    const sparseTime = sparse.world.getResource(Time).elapsed;
    expect(denseTime).toBeCloseTo(sparseTime, 8);
    expect(denseFinal.inspection.volumetricFog?.status).toBe('available');
    expect(sparseFinal.inspection.volumetricFog?.status).toBe('available');
    const denseStats = roiStats(denseFinal.pixels, FOG_ROI);
    const sparseStats = roiStats(sparseFinal.pixels, FOG_ROI);
    const meanLumaDelta = Math.abs(denseStats.meanLuma - sparseStats.meanLuma);
    const pixelLumaDelta = roiMeanAbsoluteLumaDelta(denseFinal.pixels, sparseFinal.pixels, FOG_ROI);
    const denseSettleDelta = roiMeanAbsoluteLumaDelta(
      denseReplay.previous.pixels,
      denseFinal.pixels,
      FOG_ROI,
    );
    const sparseSettleDelta = roiMeanAbsoluteLumaDelta(
      sparseReplay.previous.pixels,
      sparseFinal.pixels,
      FOG_ROI,
    );
    expect(denseStats.finitePixels).toBe(denseStats.pixelCount);
    expect(sparseStats.finitePixels).toBe(sparseStats.pixelCount);
    expect(meanLumaDelta).toBeLessThanOrEqual(MAX_EQUAL_TIME_FOG_MEAN_LUMA_DELTA);
    expect(pixelLumaDelta).toBeLessThanOrEqual(MAX_EQUAL_TIME_FOG_PIXEL_LUMA_DELTA);
    expect(denseSettleDelta).toBeLessThanOrEqual(MAX_PAUSED_FOG_MEAN_LUMA_DELTA);
    expect(sparseSettleDelta).toBeLessThanOrEqual(MAX_PAUSED_FOG_MEAN_LUMA_DELTA);

    const laterReplay = await replay(
      dense,
      Array.from({ length: 30 }, () => 1 / 60),
      'equal-time-dense-different-time',
    );
    const sameTimeReplay = await replay(
      sparse,
      Array.from({ length: 30 }, () => undefined),
      'equal-time-sparse-same-time-control',
    );
    const laterFinal = laterReplay.final;
    const sameTimeFinal = sameTimeReplay.final;
    const laterTime = dense.world.getResource(Time).elapsed;
    const sameTime = sparse.world.getResource(Time).elapsed;
    const sameTimeNoise = roiMeanAbsoluteLumaDelta(
      sparseFinal.pixels,
      sameTimeFinal.pixels,
      FOG_ROI,
    );
    const timeSensitivity = roiMeanAbsoluteLumaDelta(
      laterFinal.pixels,
      sameTimeFinal.pixels,
      FOG_ROI,
    );
    const timeSensitivityPixels = pixelDelta(laterFinal.pixels, sameTimeFinal.pixels, FOG_ROI);
    const laterSettleDelta = roiMeanAbsoluteLumaDelta(
      laterReplay.previous.pixels,
      laterFinal.pixels,
      FOG_ROI,
    );
    const sameTimeSettleDelta = roiMeanAbsoluteLumaDelta(
      sameTimeReplay.previous.pixels,
      sameTimeFinal.pixels,
      FOG_ROI,
    );
    expect(laterTime).toBeGreaterThan(denseTime);
    expect(sameTime).toBeCloseTo(sparseTime, 8);
    expect(sameTimeNoise).toBeLessThanOrEqual(MAX_EQUAL_TIME_FOG_PIXEL_LUMA_DELTA);
    expect(timeSensitivity).toBeGreaterThan(sameTimeNoise + MIN_TIME_SENSITIVITY_FOG_PIXEL_MARGIN);
    expect(timeSensitivityPixels).toBeGreaterThan(0);
    expect(laterSettleDelta).toBeLessThanOrEqual(MAX_PAUSED_FOG_MEAN_LUMA_DELTA);
    expect(sameTimeSettleDelta).toBeLessThanOrEqual(MAX_PAUSED_FOG_MEAN_LUMA_DELTA);
    // biome-ignore lint/suspicious/noConsole: equal-World-time replay receipt for browser evidence.
    console.info(
      '[solar-atmosphere-calibration] equal-time-replay',
      JSON.stringify({
        denseTime,
        sparseTime,
        denseFrames: denseFinal.inspection.frame,
        sparseFrames: sparseFinal.inspection.frame,
        dense: denseStats,
        sparse: sparseStats,
        meanLumaDelta,
        pixelLumaDelta,
        denseSettleDelta,
        sparseSettleDelta,
        differentTime: {
          laterTime,
          sameTime,
          sameTimeNoise,
          timeSensitivity,
          timeSensitivityPixels,
          laterSettleDelta,
          sameTimeSettleDelta,
        },
      }),
    );
  } finally {
    for (const fixture of [dense, sparse]) {
      await fixture.renderer.dispose();
      fixture.world.despawn(fixture.fog).unwrap();
      fixture.world.sharedRefs.release(fixture.density).unwrap();
      fixture.recipe.dispose();
      await fixture.scene.fiber.dispose();
    }
    denseCanvas.remove();
    sparseCanvas.remove();
  }
}, 240_000);
