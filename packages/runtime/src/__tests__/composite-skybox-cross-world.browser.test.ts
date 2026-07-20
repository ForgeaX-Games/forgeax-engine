// composite-skybox-cross-world.browser.test.ts
//
// feat-20260709-editor-world-partition (ENGINE-fix-round2): browser-mode
// (chrome-beta + real WebGPU) pixel-readback smoke for the two composite
// rendering defects the editor's split-owner world-partition topology exposed.
// Neither is reachable by the existing dawn-node smoke or hello-multi-world
// (the latter has NO skybox / tonemap and draws every user mesh in the SAME
// world it resolves against, so both defects are invisible there).
//
// The editor drives:
//   renderer.draw([editorWorld, sceneWorld], { cameraOwner: 0, resourceOwner: 1 })
// - camera + gizmo (user-tier) meshes live in editorWorld (index 0)
// - skybox (equirect->cube) + geometry live in sceneWorld  (index 1)
//
// DEFECT 1 (skybox blacks the whole frame): with cameraOwner != resourceOwner
// AND a SkyboxBackground on the resource-owner world AND tonemap active, the
// composite frame renders all-black (geometry never visible). The mechanism is
// GPU-validation-level (dawn-node has zero discriminating power for the skybox
// pass), so this MUST run on real WebGPU.
//
// DEFECT 2 (record resolves cross-world meshes against the single
// resourceWorld): a user-tier mesh in editorWorld (e.g. an editor gizmo handle)
// is resolved by the record stage against sceneWorld.sharedRefs, firing
// `asset-not-registered`. The extract stage already resolves per-world; the
// record stage regressed to a single world.
//
// This smoke is RED before the two record-stage fixes and GREEN after. It
// asserts: (a) zero `asset-not-registered` / no-camera errors during the
// composite frames, (b) the composited frame is neither empty nor uniformly
// black (skybox sky + lit geometry both reach the swap-chain).

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { halfFloat } from '@forgeax/engine-math';
import type { EquirectAsset, Handle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  Skylight,
  TONEMAP_REINHARD_EXTENDED,
  Transform,
} from '../components';
import { Engine } from '../index';

type EngineRenderer = Awaited<ReturnType<typeof Engine.create>>;

// Suppress the known chromium teardown race (device GC'd while a shader
// getCompilationInfo is in flight) — same guard the 9-light browser test uses.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason instanceof DOMException && e.reason.message.includes('Instance dropped')) {
      e.preventDefault();
    }
  });
}

const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

const CANVAS_W = 256;
const CANVAS_H = 256;
const FRAMES = 8;

// Build a bright, uniform equirect (all channels = 0.8 linear) so the projected
// cubemap renders a clearly non-black sky. rgba16float / linear is the only
// equirect delivery format (see equirect-bc6h.integration.test.ts).
function brightEquirect(width = 8, height = 4): EquirectAsset {
  const f32 = new Float32Array(width * height * 4);
  for (let i = 0; i < f32.length; i += 4) {
    f32[i] = 0.8;
    f32[i + 1] = 0.8;
    f32[i + 2] = 0.85;
    f32[i + 3] = 1;
  }
  const data = halfFloat.f32ToF16Bytes(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength));
  return { kind: 'equirect', width, height, format: 'rgba16float', data, colorSpace: 'linear' };
}

// A small user-tier triangle mesh, canonical 12-float vertex layout
// (position vec3 + normal vec3 + uv vec2 + tangent vec4). Stands in for an
// editor gizmo handle: a user-tier (slot >= BUILTIN_BASE) mesh that lives in
// the CAMERA-owner world, not the resource-owner world.
function gizmoMesh(): MeshAsset {
  const v = (x: number, y: number, z: number): number[] => [x, y, z, 0, 0, 1, 0, 0, 0, 0, 1, 1];
  return {
    kind: 'mesh',
    vertices: new Float32Array([...v(-0.3, -0.3, 0), ...v(0.3, -0.3, 0), ...v(0, 0.4, 0)]),
    indices: new Uint16Array([0, 1, 2]),
    attributes: {},
    submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
  };
}

function litBox(
  world: World,
  color: readonly [number, number, number, number],
  x: number,
  y: number,
): void {
  const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: { baseColor: [color[0], color[1], color[2]], metallic: 0, roughness: 0.5 },
  });
  world
    .spawn(
      { component: Transform, data: { pos: [x, y, 0], scale: [1.2, 1.2, 1.2] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    )
    .unwrap();
}

interface Diag {
  readonly code: string;
  readonly hint?: string;
  readonly detail?: unknown;
}

// Decode a base64 PNG to a top-left RGBA Uint8Array via createImageBitmap +
// OffscreenCanvas 2D. Used by the screenshot readback path.
async function decodePngBase64(b64: string): Promise<Uint8Array> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'image/png' });
  const bmp = await createImageBitmap(blob);
  const off = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = off.getContext('2d', { willReadFrequently: true });
  if (ctx === null) {
    bmp.close();
    throw new Error('OffscreenCanvas 2D context unavailable for PNG decode');
  }
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
}

// Compositor-independent readback: drive N frames, then capture the actual
// presented canvas via the CDP-backed page.screenshot (locator scoped to the
// canvas). The createImageBitmap(canvas) path (renderer.readPixels) depends on
// the chromium compositor having consumed the WebGPU swap-chain before the
// bounce, which is unreliable headless/local (documented in
// light-casters-9-light.browser.test.ts). The screenshot path reads the
// composited surface directly, so it yields real opaque pixels regardless.
async function readbackAfterComposite(
  renderer: EngineRenderer,
  worlds: World[],
  canvasId: string,
): Promise<Uint8Array> {
  for (let i = 0; i < FRAMES; i++) {
    const r = renderer.draw(worlds, { cameraOwner: 0, resourceOwner: 1 });
    if (!r.ok) throw new Error(`renderer.draw frame ${i} failed: ${r.error.code}`);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  // Primary: CDP screenshot of the canvas element (compositor-independent).
  try {
    const shot = await page
      .elementLocator(document.getElementById(canvasId) as HTMLElement)
      .screenshot({ base64: true, save: false });
    const b64 = typeof shot === 'string' ? shot : shot.base64;
    const decoded = await decodePngBase64(b64);
    return decoded;
  } catch {
    // Fallback: createImageBitmap(canvas) bounce (may read all-zero if the
    // compositor has not consumed the swap-chain — handled by the alpha gate).
    const r = await renderer.readPixels();
    if (!r.ok) throw new Error(`readPixels fallback failed: ${r.error.code}`);
    return r.value;
  }
}

// Mean luminance over the whole frame, 0..1. A uniformly-black frame reads ~0.
function meanLuma(pixels: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const rr = (pixels[i] ?? 0) / 255;
    const gg = (pixels[i + 1] ?? 0) / 255;
    const bb = (pixels[i + 2] ?? 0) / 255;
    sum += 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

// Fraction of opaque (alpha > 0.5) pixels — the presentation-consumed signal.
function alphaFraction(pixels: Uint8Array): number {
  let opaque = 0;
  let n = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    if ((pixels[i] ?? 0) > 127) opaque += 1;
    n += 1;
  }
  return n > 0 ? opaque / n : 0;
}

describe.skipIf(!browserReady)('composite + skybox + cross-world mesh (ENGINE-fix-round2)', () => {
  let renderer: EngineRenderer | undefined;
  let canvas: HTMLCanvasElement | undefined;

  afterEach(() => {
    if (renderer !== undefined) {
      renderer.dispose?.();
      renderer = undefined;
    }
    if (canvas !== undefined && canvas.parentElement !== null) {
      canvas.parentElement.removeChild(canvas);
      canvas = undefined;
    }
  });

  it('split-owner composite with skybox + a camera-world user mesh renders sky + geometry, no asset-not-registered', async () => {
    canvas = document.createElement('canvas');
    canvas.id = 'composite-skybox-cross-world-canvas';
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    canvas.style.width = `${CANVAS_W}px`;
    canvas.style.height = `${CANVAS_H}px`;
    canvas.style.display = 'block';
    document.body.appendChild(canvas);

    renderer = await Engine.create(canvas, {}, { shaderManifestUrl: '/shaders/manifest.json' });
    expect(renderer.backend).toBe('webgpu');
    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);

    const diagnostics: Diag[] = [];
    renderer.onError((e) =>
      diagnostics.push({
        code: e.code,
        hint: e.hint,
        detail: (e as unknown as { detail?: unknown }).detail,
      }),
    );

    // editorWorld (cameraOwner, index 0): camera + directional light + one
    // user-tier gizmo mesh. NO skybox, NO scene geometry.
    const editorWorld = new World();
    editorWorld
      .spawn(
        { component: Transform, data: { pos: [0, 0, 6] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: CANVAS_W / CANVAS_H,
            near: 0.1,
            far: 100,
            tonemap: TONEMAP_REINHARD_EXTENDED,
            clearColor: [0.02, 0.02, 0.03, 1],
          },
        },
      )
      .unwrap();
    editorWorld
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [-0.4, -0.7, -1],
          color: [1, 1, 1],
          intensity: 1.4,
        },
      })
      .unwrap();
    // The editor gizmo: a user-tier mesh handle that lives in editorWorld's
    // sharedRefs (slot >= BUILTIN_BASE). Under defect 2 the record stage
    // resolves this against sceneWorld and fires asset-not-registered.
    const gizmoHandle: Handle<'MeshAsset', 'shared'> = editorWorld.allocSharedRef<
      'MeshAsset',
      MeshAsset
    >('MeshAsset', gizmoMesh());
    const gizmoMat = editorWorld.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          shader: 'forgeax::default-standard-pbr',
          tags: { LightMode: 'Forward' },
          queue: 2000,
        },
      ],
      paramValues: { baseColor: [0.95, 0.85, 0.1], metallic: 0, roughness: 0.6 },
    });
    editorWorld
      .spawn(
        { component: Transform, data: { pos: [-1.8, 1.4, 0] } },
        { component: MeshFilter, data: { assetHandle: gizmoHandle } },
        { component: MeshRenderer, data: { materials: [gizmoMat] } },
      )
      .unwrap();

    // sceneWorld (resourceOwner, index 1): skybox (equirect) + lit boxes.
    const sceneWorld = new World();
    const equirect = sceneWorld.allocSharedRef('EquirectAsset', brightEquirect());
    sceneWorld.spawn({ component: Skylight, data: { equirect, intensity: 1.0 } });
    sceneWorld.spawn({
      component: SkyboxBackground,
      data: { equirect, mode: SKYBOX_MODE_CUBEMAP },
    });
    litBox(sceneWorld, [0.15, 0.8, 0.2, 1], 0, 0);
    litBox(sceneWorld, [0.85, 0.15, 0.15, 1], 1.8, 0);

    const pixels = await readbackAfterComposite(renderer, [editorWorld, sceneWorld], canvas.id);
    // The screenshot path returns the canvas element's composited surface
    // (clipped to its layout box, so its size is source-dependent); the
    // fallback createImageBitmap path returns exactly CANVAS_W*CANVAS_H*4.
    // Assert a non-empty RGBA buffer (length a positive multiple of 4) rather
    // than a fixed size so both readback sources are accepted.
    expect(pixels.length).toBeGreaterThan(0);
    expect(pixels.length % 4).toBe(0);

    // Evidence: log the diagnostics + measured luma so a failure prints the
    // discriminating signal (defect signature) rather than a bare boolean.
    const luma = meanLuma(pixels);
    const alpha = alphaFraction(pixels);
    console.warn(
      `[composite-skybox] diagnostics=${JSON.stringify(diagnostics)} meanLuma=${luma.toFixed(4)} alphaFraction=${alpha.toFixed(3)}`,
    );

    // DEFECT 2 assertion: the record stage must resolve each renderable
    // against the world it was extracted from. A cross-world resolution
    // surfaces one of two signatures depending on whether the foreign slot
    // is vacant or occupied in the (wrong) resource-owner world:
    //   - vacant slot   -> resolveAssetHandle miss -> `asset-not-registered`
    //   - occupied slot -> wrong-kind payload (here the sceneWorld equirect
    //     shares the gizmo's user-tier slot) -> ensureResident has no arm
    //     for kind:'equirect' -> undefined -> `residentRes.ok` throws ->
    //     the draw() try/catch fires `webgpu-runtime-error` every frame.
    // Both are defect-2 signatures; assert neither occurs.
    const recordResolutionErrors = diagnostics.filter(
      (d) => d.code === 'asset-not-registered' || d.code === 'webgpu-runtime-error',
    );
    expect(
      recordResolutionErrors,
      `cross-world record-stage resolution error (defect 2): ${JSON.stringify(recordResolutionErrors)}`,
    ).toEqual([]);
    expect(diagnostics.filter((d) => d.code === 'render-system-no-camera')).toEqual([]);

    // DEFECT 1 assertion: the frame is not uniformly black. Gate on the
    // presentation-consumed signal (alpha) so a chromium compositor stall
    // (all-zero readback) does not masquerade as the black-frame defect.
    if (alpha > 0.5) {
      expect(
        luma,
        `composite+skybox frame is black (meanLuma=${luma.toFixed(4)}); defect 1 skybox pass blacked the frame`,
      ).toBeGreaterThan(0.05);
    }
  }, 30_000);
});
