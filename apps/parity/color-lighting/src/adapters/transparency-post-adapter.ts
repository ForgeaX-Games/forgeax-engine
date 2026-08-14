import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  tonemapToU32,
} from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import type { SceneCase } from '../contracts/types';
import type { ForgeaxCaptureOutput } from './forgeax-adapter';
import { threeToneMappingId, type ThreeCaptureOutput } from './three-adapter';
import { WebGPURenderer } from 'three/webgpu';
import {
  Color,
  DirectionalLight as ThreeDirectionalLight,
  DoubleSide,
  LinearSRGBColorSpace,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';

const blend = {
  color: { srcFactor: 'src-alpha' as const, dstFactor: 'one-minus-src-alpha' as const, operation: 'add' as const },
  alpha: { srcFactor: 'one' as const, dstFactor: 'one-minus-src-alpha' as const, operation: 'add' as const },
};

function makeMaterial(world: World): void {
  const plane = createPlaneGeometry(2.8, 2.8);
  if (!plane.ok) throw new Error(`transparent plane creation failed: ${plane.error.code}`);
  const meshHandle = world.allocSharedRef('MeshAsset', plane.value);
  const materialHandle = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.8, 0.28, 0.12, 0.5],
    colorSpace: 'linear',
    metallic: 0,
    roughness: 1,
    castShadow: false,
    queue: 3000,
    renderState: { cullMode: 'none', depthWriteEnabled: false, blend },
  }));
  world.spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();
}

export function makeTransparencyWorld(sceneCase: SceneCase): World {
  const world = new World();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1] } },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: sceneCase.scene.width / sceneCase.scene.height }),
        clearColor: sceneCase.scene.background,
        ...(sceneCase.colorDomain === 'linearHdr' ? { tonemap: tonemapToU32('reinhard') } : {}),
      },
    },
  ).unwrap();
  makeMaterial(world);
  world.spawn({
    component: DirectionalLight,
    data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
  }).unwrap();
  return world;
}

async function readCanvasPixels(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(canvas);
  const offscreen = new OffscreenCanvas(canvas.width, canvas.height);
  const context = offscreen.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    bitmap.close();
    throw new Error('transparent canvas RGBA8 readback unavailable');
  }
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength);
}

function configFor(sceneCase: SceneCase) {
  return {
    width: sceneCase.scene.width,
    height: sceneCase.scene.height,
    colorDomain: sceneCase.colorDomain,
    background: sceneCase.scene.background,
    ...(sceneCase.pipeline === undefined ? {} : { pipeline: sceneCase.pipeline.identity }),
  } as const;
}

async function waitForAnimationFrameOrTimeout(): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timeout = setTimeout(finish, 250);
    requestAnimationFrame(() => {
      clearTimeout(timeout);
      finish();
    });
  });
}

async function settleWebglRenderer(renderer: Awaited<ReturnType<typeof createRenderer>>): Promise<void> {
  await waitForAnimationFrameOrTimeout();
  await waitForAnimationFrameOrTimeout();
  renderer.dispose();
}

export async function captureTransparencyForgeaxBrowser(
  sceneCase: SceneCase,
  rendererKind: 'webgpu' | 'webgl' = 'webgpu',
): Promise<ForgeaxCaptureOutput> {
  const { forgeaxBundlerAdapter } = await import('virtual:forgeax/bundler');
  const canvas = document.createElement('canvas');
  canvas.width = sceneCase.scene.width;
  canvas.height = sceneCase.scene.height;
  const renderer = await createRenderer(canvas, {}, forgeaxBundlerAdapter() as never);
  try {
    const ready = await renderer.ready;
    if (!ready.ok) throw new Error(`transparent renderer unavailable: ${ready.error.code}`);
    const renderErrors: string[] = [];
    const removeRenderErrorListener = renderer.onError((error) => {
      renderErrors.push(`${error.code}: ${error.hint}`);
    });
    if (sceneCase.pipeline?.identity === 'hdrp') {
      const installed = renderer.installPipeline({
        kind: 'render-pipeline',
        pipelineId: 'forgeax::hdrp',
        config: { clusterGrid: { x: 16, y: 9, z: 24 } },
      });
      if (!installed.ok) throw new Error(`transparent HDRP install failed: ${installed.error.code}`);
    }
    const world = makeTransparencyWorld(sceneCase);
    const worldAttachment1 = renderer.attachWorld(world);
    if (!worldAttachment1.ok) throw worldAttachment1.error;
    world.update().unwrap();
    const drawn = renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
    if (!drawn.ok) throw new Error(`transparent ForgeaX draw failed: ${drawn.error.code}`);
    if (rendererKind === 'webgl') await waitForAnimationFrameOrTimeout();
    else await renderer.device.queue.onSubmittedWorkDone();
    world.update().unwrap();
    const warmed = renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
    if (!warmed.ok) throw new Error(`transparent ForgeaX warmed draw failed: ${warmed.error.code}`);
    if (rendererKind === 'webgl') await waitForAnimationFrameOrTimeout();
    else await renderer.device.queue.onSubmittedWorkDone();
    removeRenderErrorListener();
    if (renderErrors.length > 0) throw new Error(`transparent ForgeaX render errors: ${renderErrors.join(' | ')}`);
    const pixels = await readCanvasPixels(canvas);
    return { linear: [], final: Array.from(pixels), config: configFor(sceneCase) };
  } finally {
    if (rendererKind === 'webgpu') renderer.dispose();
    else await settleWebglRenderer(renderer);
  }
}

export async function captureTransparencyThreeBrowser(
  sceneCase: SceneCase,
  rendererKind: 'webgpu' | 'webgl' = 'webgpu',
): Promise<ThreeCaptureOutput> {
  const canvas = document.createElement('canvas');
  canvas.width = sceneCase.scene.width;
  canvas.height = sceneCase.scene.height;
  const renderer = rendererKind === 'webgpu'
    ? new WebGPURenderer({ canvas, antialias: false, forceWebGL: false })
    : new WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  if (rendererKind === 'webgpu') {
    await renderer.init();
    if (renderer.backend?.isWebGPUBackend !== true) throw new Error('Three WebGPU primary unavailable');
  } else {
    renderer.setSize(sceneCase.scene.width, sceneCase.scene.height, false);
  }
  renderer.toneMapping = sceneCase.colorDomain === 'linearHdr'
    ? threeToneMappingId('reinhard')
    : threeToneMappingId('linear');
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(
    new Color().setRGB(
      sceneCase.scene.background[0],
      sceneCase.scene.background[1],
      sceneCase.scene.background[2],
      LinearSRGBColorSpace,
    ),
    sceneCase.scene.background[3],
  );
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, sceneCase.scene.width / sceneCase.scene.height, 0.1, 10);
  camera.position.z = 3;
  const material = new MeshStandardMaterial({
    color: new Color().setRGB(0.8, 0.28, 0.12, LinearSRGBColorSpace),
    opacity: 0.5,
    transparent: true,
    depthWrite: false,
    toneMapped: sceneCase.colorDomain === 'linearHdr',
    side: DoubleSide,
    roughness: 1,
    metalness: 0,
  });
  scene.add(new Mesh(new PlaneGeometry(2.8, 2.8), material));
  const light = new ThreeDirectionalLight(0xffffff, 1);
  light.position.set(0, 0, 3);
  light.target.position.set(0, 0, 0);
  scene.add(light, light.target);
  if (rendererKind === 'webgpu') await renderer.renderAsync(scene, camera);
  else renderer.render(scene, camera);
  if (rendererKind === 'webgl') await waitForAnimationFrameOrTimeout();
  const pixels = await readCanvasPixels(canvas);
  renderer.dispose();
  return { linear: [], final: Array.from(pixels), config: configFor(sceneCase) };
}
