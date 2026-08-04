/// <reference types="@webgpu/types" />

import type { RhiDevice, RhiInstance } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { readbackTexturePixels } from '../readback';
import { wrap } from '../recorder';
import { createReplay } from '../replayer';
import { deserializeTape, serializeTape } from '../tape-format';

interface DawnPack {
  readonly rhi: RhiInstance;
}

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';

async function loadDawnRhi(): Promise<DawnPack | undefined> {
  try {
    return (await import('@forgeax/engine-rhi-webgpu')) as unknown as DawnPack;
  } catch {
    return undefined;
  }
}

async function requestBcDevice(
  rhi: RhiInstance,
  requiredFeatures: GPUFeatureName[],
): Promise<RhiDevice | undefined> {
  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) return undefined;
  const features = adapterResult.value.features as ReadonlySet<GPUFeatureName>;
  if (!features.has('texture-compression-bc')) return undefined;
  const deviceResult = await adapterResult.value.requestDevice({
    requiredFeatures,
  });
  if (!deviceResult.ok) return undefined;
  return deviceResult.value;
}

describe.skipIf(SKIP_DAWN)('rhi-debug compressed texture replay', () => {
  it('captures and replays one BC7 block with its initialData seed', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;

    const debugInst = wrap(pack.rhi);
    const adapterResult = await debugInst.requestAdapter();
    if (!adapterResult.ok) return;
    const adapterFeatures = adapterResult.value.features as ReadonlySet<GPUFeatureName>;
    if (!adapterFeatures.has('texture-compression-bc')) return;

    const requestedFeatures: GPUFeatureName[] = ['texture-compression-bc'];
    const wrappedDeviceResult = await adapterResult.value.requestDevice({
      requiredFeatures: requestedFeatures,
    });
    if (!wrappedDeviceResult.ok) return;
    const wrappedDevice = wrappedDeviceResult.value;

    const block = new Uint8Array([
      0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
      0x88,
    ]);
    const textureResult = wrappedDevice.createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 1 },
      format: 'bc7-rgba-unorm' as GPUTextureFormat,
      usage: 0x06,
    });
    if (!textureResult.ok) throw new Error(`createTexture: ${textureResult.error.code}`);
    const texture = textureResult.value;
    const writeResult = wrappedDevice.queue.writeTexture(
      { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } } as never,
      block.buffer,
      { offset: 0, bytesPerRow: 16, rowsPerImage: 1 } as never,
      { width: 4, height: 4, depthOrArrayLayers: 1 },
    );
    if (!writeResult.ok) throw new Error(`writeTexture: ${writeResult.error.code}`);
    await wrappedDevice.queue.onSubmittedWorkDone();

    const armResult = debugInst.arm(1);
    if (!armResult.ok) throw new Error(`arm: ${armResult.error.code}`);
    const snapshotResult = await debugInst.snapshotAllLiveResources();
    if (!snapshotResult.ok) throw new Error(`snapshot: ${snapshotResult.error.code}`);
    debugInst.onFrameEnd();

    const tape = debugInst.getTape();
    if (!tape || 'code' in tape) throw new Error('capture did not produce a tape');
    const textureEvent = tape.events.find(
      (event) => event.kind === 'createTexture' && event.desc.format === 'bc7-rgba-unorm',
    );
    if (textureEvent === undefined || textureEvent.kind !== 'createTexture') {
      throw new Error('BC7 texture create event missing');
    }
    const textureHandleId = textureEvent.handleId;
    expect(tape.events).toContainEqual(
      expect.objectContaining({ kind: 'initialData', handleId: textureHandleId }),
    );

    const serialized = serializeTape(tape);
    const deserialized = deserializeTape(serialized.json, serialized.blob);
    if (!deserialized.ok) throw new Error(`deserialize: ${deserialized.error.code}`);

    const replayDevice = await requestBcDevice(pack.rhi, requestedFeatures);
    if (!replayDevice) return;
    const replayResult = createReplay(deserialized.value, replayDevice);
    if (!replayResult.ok) throw new Error(`createReplay: ${replayResult.error.code}`);
    const replay = replayResult.value;
    const stepResult = await replay.stepTo(deserialized.value.events.length - 1);
    if (!stepResult.ok) throw new Error(`stepTo: ${stepResult.error.code}`);

    const replayTexture = replay._resolveHandle(textureHandleId);
    const replayBytes = await readbackTexturePixels(replayDevice, replayTexture, 4, 4, {
      bytesPerBlock: 16,
      blockWidth: 4,
      blockHeight: 4,
    });
    expect(Array.from(replayBytes)).toEqual(Array.from(block));

    replay.dispose();
    (replayDevice as RhiDevice & { destroy?: () => void }).destroy?.();
  }, 60_000);
});
