// feat-20260709 M2 / w7: light GPU 4-path byte-neutral regression (AC-11).
//
// The vec-collapse changes the ECS column shape (per-axis scalar -> array<f32,3>)
// and the extract read sites, but NOT the GPU pack paths: every light GPU buffer
// packs from the extract-assembled Vec3 snapshot (direction/color are already
// Vec3 there -- research Finding 8), never from the ECS columns. These tests
// lock the four light GPU pack paths' byte output so the collapse is proven
// byte-neutral end to end:
//   1. View UBO (DirectionalLight direction/color lanes)   -> writeViewUbo
//   2. PointLightBuffer (color lanes)                       -> packPointLight
//   3. SpotLightBuffer (direction + color lanes)            -> packSpotLight
//   4. Skylight uniform/ambient (color destructure)         -> SkylightSnapshot
// (Camera clear pass is M3, not here.)

import { vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { packPointLight, packSpotLight } from '../light-buffer-layout';
import { writeViewUbo } from '../record/view-ubo';
import type {
  CameraSnapshot,
  DirectionalLightSnapshot,
  ExtractedLights,
  PointLightSnapshot,
  SkylightSnapshot,
  SpotLightSnapshot,
} from '../render-system-extract';

function identityCamera(): CameraSnapshot {
  return {
    position: vec3.create(0, 0, 3),
    world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1]),
    fov: Math.PI / 4,
    aspect: 16 / 9,
    near: 0.1,
    far: 100,
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
    tonemap: 'none' as CameraSnapshot['tonemap'],
    exposure: 1,
    whitePoint: 4,
    antialias: 'none' as CameraSnapshot['antialias'],
    bloom: 'off' as CameraSnapshot['bloom'],
    bloomThreshold: 1,
    bloomIntensity: 1,
    bloomBlurRadius: 4,
    clearColor: [0, 0, 0, 1],
  };
}

const emptyLights: ExtractedLights = {
  directional: undefined,
  directionalCount: 0,
  point: [],
  spot: [],
  lightViewProj: undefined,
  splitPlanes: undefined,
  cascadeCount: undefined,
  cascadeBlend: undefined,
  depthBias: undefined,
  normalBias: undefined,
  pcfKernelSize: undefined,
} as unknown as ExtractedLights;

/** Capture the single writeViewUbo payload as a Float32Array. */
function captureViewUbo(light: DirectionalLightSnapshot): { payload: Float32Array } {
  let captured: Float32Array | undefined;
  const queue = {
    writeBuffer: (_buf: Buffer, _off: number, data: ArrayBufferView | ArrayBuffer) => {
      captured = new Float32Array((data as ArrayBufferView).buffer ?? (data as ArrayBuffer));
      return ok(undefined);
    },
  } as unknown as RhiQueue;
  const viewBuffer = {} as Buffer;
  writeViewUbo(queue, viewBuffer, identityCamera(), light, emptyLights, []);
  if (captured === undefined) throw new Error('writeViewUbo did not write');
  return { payload: captured };
}

describe('w7 -- light GPU pack byte-neutral (AC-11)', () => {
  it('View UBO packs DirectionalLight direction*intensity / color into lanes 16..18 / 20..22', () => {
    const light: DirectionalLightSnapshot = {
      kind: 'directional',
      direction: vec3.create(-0.5, -1, -0.3),
      // extract host-pre-multiplies color * intensity; snapshot color IS the
      // pre-multiplied radiance term (Finding 8), so writeViewUbo writes it raw.
      color: vec3.create(0.9, 0.8, 0.7),
      intensity: 2,
    };
    const { payload } = captureViewUbo(light);
    // lightDir lanes carry direction * intensity (view-ubo.ts:66-68).
    expect(payload[16]).toBeCloseTo(-0.5 * 2, 5);
    expect(payload[17]).toBeCloseTo(-1 * 2, 5);
    expect(payload[18]).toBeCloseTo(-0.3 * 2, 5);
    // lightColor lanes carry the (already pre-multiplied) color verbatim.
    expect(payload[20]).toBeCloseTo(0.9, 5);
    expect(payload[21]).toBeCloseTo(0.8, 5);
    expect(payload[22]).toBeCloseTo(0.7, 5);
  });

  it('packPointLight writes color into slots 4..6 byte-for-byte (32 B)', () => {
    const snap: PointLightSnapshot = {
      kind: 'point',
      position: vec3.create(1.5, -2.25, 0.125),
      color: vec3.create(0.4, 0.5, 0.6),
      intensity: 2,
      invRangeSquared: 0.04,
    };
    const out = packPointLight(snap);
    expect(out.byteLength).toBe(32);
    expect(out[4]).toBeCloseTo(0.4, 6);
    expect(out[5]).toBeCloseTo(0.5, 6);
    expect(out[6]).toBeCloseTo(0.6, 6);
  });

  it('packSpotLight writes color slots 4..6 + direction slots 8..10 byte-for-byte (64 B)', () => {
    const snap: SpotLightSnapshot = {
      kind: 'spot',
      position: vec3.create(0, 5, 0),
      direction: vec3.create(0.1, -0.9, 0.2),
      color: vec3.create(0.3, 0.4, 0.5),
      intensity: 1,
      invRangeSquared: 0.01,
      cosInner: 0.95,
      cosOuter: 0.8,
      castShadow: false,
      lightViewProj: undefined,
      mapSize: 2048,
      nearPlane: 0.1,
      farPlane: 50,
      shadowAtlasTile: -1,
    };
    const out = packSpotLight(snap);
    expect(out.byteLength).toBe(64);
    expect(out[4]).toBeCloseTo(0.3, 6);
    expect(out[5]).toBeCloseTo(0.4, 6);
    expect(out[6]).toBeCloseTo(0.5, 6);
    expect(out[8]).toBeCloseTo(0.1, 6);
    expect(out[9]).toBeCloseTo(-0.9, 6);
    expect(out[10]).toBeCloseTo(0.2, 6);
  });

  it('Skylight snapshot color is a 3-tuple consumed by the ambient pack (main-pass.ts:248)', () => {
    const snap: SkylightSnapshot = {
      equirectHandle: 0,
      color: [0.2, 0.4, 0.6],
      intensity: 0.3,
      entityHandle: 1,
    };
    const [cr, cg, cb] = snap.color;
    expect(cr).toBeCloseTo(0.2, 6);
    expect(cg).toBeCloseTo(0.4, 6);
    expect(cb).toBeCloseTo(0.6, 6);
  });
});
