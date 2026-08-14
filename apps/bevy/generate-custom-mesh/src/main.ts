import { createApp } from '@forgeax/engine-app';
import { Update } from '@forgeax/engine-ecs';
import { FRAME_START_SCAN_SYSTEM_NAME, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { unwrapHandle } from '@forgeax/engine-types';
import { buildCustomMeshWorld, makeCustomMeshTexture, stepCustomMesh, type MeshGpuStore } from './generate-custom-mesh.js';

type EvidenceGlobal = typeof globalThis & {
  __bevyGenerateCustomMeshReady?: boolean;
  __bevyGenerateCustomMeshState?: ReturnType<typeof buildCustomMeshWorld>;
  __prepareGenerateCustomMeshCapture?: () => Promise<void>;
};

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[generate-custom-mesh] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const texture = makeCustomMeshTexture();
  const textureHandle = app.world.allocSharedRef('TextureAsset', texture);
  const upload = await app.renderer.store.uploadTexture(textureHandle, texture, {
    bytes: texture.data,
    width: texture.width,
    height: texture.height,
    mime: 'image/png',
    colorSpace: 'srgb',
    mipmap: false,
  });
  if (!upload.ok) {
    console.error('[generate-custom-mesh] texture upload failed:', upload.error.code, upload.error.hint);
    return;
  }
  const state = buildCustomMeshWorld(app.world, unwrapHandle(textureHandle));
  app.world.addSystem(Update, {
    name: 'bevy-generate-custom-mesh-input',
    after: [FRAME_START_SCAN_SYSTEM_NAME],
    queries: [],
    fn: (world) => stepCustomMesh(
      world,
      state,
      app.renderer.store as MeshGpuStore,
      world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY),
    ),
  });
  const started = app.start();
  if (!started.ok) console.error('[generate-custom-mesh] app.start() failed:', started.error);
  const evidenceGlobal = globalThis as EvidenceGlobal;
  evidenceGlobal.__prepareGenerateCustomMeshCapture = async () => {
    const updated = app.world.update(1 / 60);
    if (!updated.ok) throw updated.error;
    const drawn = app.renderer.draw([app.world], { cameraOwner: 0, resourceOwner: 0 });
    if (!drawn.ok) throw drawn.error;
  };
  Object.assign(evidenceGlobal, { __bevyGenerateCustomMeshReady: true, __bevyGenerateCustomMeshState: state });
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('<canvas id="app"> not found');
bootstrap(canvas);
