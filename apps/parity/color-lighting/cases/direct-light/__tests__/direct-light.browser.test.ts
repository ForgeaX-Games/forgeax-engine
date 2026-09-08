import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LightSlotKind,
  packLightSlot,
  type SpotLightSnapshot,
} from '../../../../../../packages/render/src/light-buffer-layout';
import directionalCase from '../cases/directional-urp.json' with { type: 'json' };
import { createForgeaxCaptureSession } from '../../../src/main';
import type { SceneCase } from '../../../src/contracts/types';
import {
  asSceneCase,
  measureSpotShadowDelta,
  SPOT_SHADOW_SCENES,
  type SpotShadowReceiverVariant,
} from '../spot-shadow-fixture';

const sceneCase = directionalCase as unknown as SceneCase;
const browserSpotSnapshot = {
  kind: 'spot',
  entity: 7,
  position: [-1.2, 1.1, 2.4],
  direction: [0.35, -0.35, -1],
  color: [12, 9.6, 7.2],
  intensity: 12,
  invRangeSquared: 1 / 64,
  cosInner: Math.cos((18 * Math.PI) / 180),
  cosOuter: Math.cos((32 * Math.PI) / 180),
  castShadow: true,
  lightViewProj: undefined,
  mapSize: 1024,
  nearPlane: 0.1,
  farPlane: 8,
  shadowAtlasTile: 3,
} as unknown as SpotLightSnapshot;

describe('direct-light URP browser producer evidence', () => {
  let captureSession: Awaited<ReturnType<typeof createForgeaxCaptureSession>>;

  beforeAll(async () => {
    document.body.innerHTML = '<canvas id="forgeax"></canvas>';
    captureSession = await createForgeaxCaptureSession(sceneCase);
  });

  afterAll(async () => {
    await captureSession.dispose();
  });

  it('captures linear HDR from the current producer attachment', async () => {
    const capture = await captureSession.capture(sceneCase);
    const observation = capture.observations?.linearHdr;

    expect(observation?.status).toBe('ready');
    expect(observation?.format).toBe('rgba16float');
    expect(observation?.bytes?.byteLength).toBeGreaterThan(0);
    expect(observation?.rawHash).toMatch(/^[0-9a-f]{8,}$/);
    expect(observation?.frameId).toBeTypeOf('number');
    expect(observation?.pipelineId).toBe('forgeax::urp');
    expect(observation?.backendId).toBeTypeOf('string');
    expect(capture.config.readback?.linearReadback).toBe(true);
    expect(capture.config.readback?.namedAttachment).toBe(true);
  });

  it('keeps the 64B LightSlot raw kind/tile bits through the browser pack transport', () => {
    const packed = packLightSlot(browserSpotSnapshot);
    const transported = structuredClone(packed);
    const storageBytes = new Uint8Array(packLightSlot(browserSpotSnapshot).buffer);
    const uniformBytes = new Uint8Array(packLightSlot(browserSpotSnapshot).buffer);
    const rawU32 = new Uint32Array(transported.buffer);
    const rawI32 = new Int32Array(transported.buffer);

    expect(transported).toBeInstanceOf(Float32Array);
    expect(transported.byteLength).toBe(64);
    expect(storageBytes).toEqual(uniformBytes);
    expect(rawU32[12]).toBe(LightSlotKind.SPOT);
    expect(rawI32[13]).toBe(3);
    expect(transported[14]).toBe(0);
    expect(transported[15]).toBe(0);
  });

  it('uses the same fixed spot-shadow scene authority and exposes the baseline RED', async () => {
    const scene = SPOT_SHADOW_SCENES.urp;
    const capture = await captureSession.capture(asSceneCase(scene, 'urp'));
    const observation = capture.observations?.linearHdr;
    expect(observation?.status).toBe('ready');
    if (!(observation?.bytes instanceof Uint8Array)) {
      throw new Error('spot-shadow browser linear HDR bytes are unavailable');
    }
    const metrics = measureSpotShadowDelta(observation.bytes, scene);
    expect(observation.pipelineId).toBe('forgeax::urp');
    expect(metrics.lit).toBeGreaterThan(0);
    expect(metrics.delta).toBeGreaterThan(scene.threshold.shadowDelta);
  }, 120_000);

  it('captures the fixed HDRP spot-shadow scene through the browser producer', async () => {
    const scene = SPOT_SHADOW_SCENES.hdrp;
    const capture = await captureSession.capture(asSceneCase(scene, 'hdrp'));
    const observation = capture.observations?.linearHdr;
    expect(observation?.status).toBe('ready');
    if (!(observation?.bytes instanceof Uint8Array)) {
      throw new Error('spot-shadow HDRP browser linear HDR bytes are unavailable');
    }
    const metrics = measureSpotShadowDelta(observation.bytes, scene);
    expect(observation.pipelineId).toBe('forgeax::hdrp');
    expect(metrics.lit).toBeGreaterThan(0);
    expect(metrics.delta).toBeGreaterThan(scene.threshold.shadowDelta);
  }, 120_000);

  it('compares base and clearcoat spot-shadow ROIs across live URP and HDRP producers', async () => {
    for (const receiver of ['base', 'clearcoat'] as const satisfies readonly SpotShadowReceiverVariant[]) {
      const urpScene = SPOT_SHADOW_SCENES.urp;
      const hdrpScene = SPOT_SHADOW_SCENES.hdrp;
      const urpCapture = await captureSession.capture(asSceneCase(urpScene, 'urp'), undefined, receiver);
      const hdrpCapture = await captureSession.capture(asSceneCase(hdrpScene, 'hdrp'), undefined, receiver);
      const urpObservation = urpCapture.observations?.linearHdr;
      const hdrpObservation = hdrpCapture.observations?.linearHdr;
      expect(urpObservation?.pipelineId).toBe('forgeax::urp');
      expect(hdrpObservation?.pipelineId).toBe('forgeax::hdrp');
      if (!(urpObservation?.bytes instanceof Uint8Array) || !(hdrpObservation?.bytes instanceof Uint8Array)) {
        throw new Error(`spot-shadow ${receiver} browser linear HDR bytes are unavailable`);
      }
      const urpMetrics = measureSpotShadowDelta(urpObservation.bytes, urpScene);
      const hdrpMetrics = measureSpotShadowDelta(hdrpObservation.bytes, hdrpScene);
      expect(urpMetrics.delta, `${receiver} URP metrics`).toBeGreaterThan(hdrpScene.threshold.shadowDelta);
      expect(hdrpMetrics.delta, `${receiver} HDRP metrics`).toBeGreaterThan(hdrpScene.threshold.shadowDelta);
      expect(Math.abs(urpMetrics.delta - hdrpMetrics.delta), `${receiver} cross-pipeline metrics`).toBeLessThanOrEqual(
        hdrpScene.threshold.pipelineEpsilon,
      );
    }
  }, 120_000);
});
