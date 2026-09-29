import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createWorldContext, type EntityHandle, World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, renderComponentsPlugin } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import type { MeshAsset, SceneAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import lodMeta from '../assets/lod-scene.gltf.meta.json' with { type: 'json' };

type SubAssetEntry = { readonly guid: string; readonly kind: string };
const canvas = document.querySelector<HTMLCanvasElement>('#app');
const status = document.querySelector<HTMLPreElement>('#status');
const lodLevel = document.querySelector<HTMLElement>('#lod-level');
const lodDetail = document.querySelector<HTMLElement>('#lod-detail');
const lodGeometry = document.querySelector<HTMLElement>('#lod-geometry');
if (!canvas) throw new Error('hello-lod-occlusion: missing <canvas id="app">');

const LOD_VISUALS = [
  { label: '青色材质', cssColor: '#0ea5e9', rgba: [0.08, 0.72, 1, 1] as const },
  { label: '橙色材质', cssColor: '#f97316', rgba: [1, 0.56, 0.08, 1] as const },
  { label: '粉色材质', cssColor: '#ec4899', rgba: [0.96, 0.12, 0.48, 1] as const },
] as const;

canvas.tabIndex = 0;
canvas.style.touchAction = 'none';

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[hello-lod-occlusion] no usable backend', error);
  } else {
    console.error('[hello-lod-occlusion] bootstrap failed', error);
  }
  if (status) status.textContent = `LOD runtime failed: ${String(error)}`;
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const constructed = await constructRuntimeRendererHost(target, {}, {
    ...forgeaxBundlerAdapter(),
    importTransport: createRuntimeAssetImportTransport(runtimeBinding),
  });
  if (!constructed.ok) throw constructed.error;
  const { renderer, assets } = constructed.value;
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  const world = new World();
  const worldContext = await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
  const attachment = renderer.attach(world);
  if (!attachment.ok) throw attachment.error;
  const frameRequest = {
    leases: [attachment.value],
    camera: { lease: attachment.value },
    environment: { lease: attachment.value },
  };

  // Warm every mesh in the authored LOD chain before the scene is mounted.
  // The root MeshAsset carries the durable LOD GUID edges, but explicitly
  // loading the referenced payloads here makes the demo's first interactive
  // camera move observable instead of waiting on a lazy residency fetch.
  for (const entry of (lodMeta.subAssets as readonly SubAssetEntry[]).filter((candidate) => candidate.kind === 'mesh')) {
    const guid = AssetGuid.parse(entry.guid);
    if (!guid.ok) throw new Error(`invalid mesh GUID: ${guid.error.code}`);
    const loaded = await assets.loadByGuid(guid.value);
    if (!loaded.ok) throw new Error(`mesh load failed: ${loaded.error.code}`);
  }
  const rootMesh = await assets.loadByGuid<MeshAsset>(findGuid('mesh'));
  if (!rootMesh.ok) throw new Error(`root mesh load failed: ${rootMesh.error.code}`);
  const lodReadiness = (rootMesh.value.lods ?? []).map(
    (lod: NonNullable<MeshAsset['lods']>[number]) => assets.lookup(lod.mesh)?.kind === 'mesh',
  );
  const lodIndexCounts = [
    rootMesh.value.indices?.length ?? 0,
    ...(rootMesh.value.lods ?? []).map(
      (lod: NonNullable<MeshAsset['lods']>[number]) =>
        assets.lookup<MeshAsset>(lod.mesh)?.indices?.length ?? 0,
    ),
  ];

  const sceneGuid = findGuid('scene');
  const scene = await assets.loadByGuid<SceneAsset>(sceneGuid);
  if (!scene.ok) throw new Error(`scene load failed: ${scene.error.code}`);

  // The interactive demo uses the imported MeshAsset and its LOD GUID chain
  // with opaque Standard PBR materials, which is the production GPU-driven
  // LOD lane exercised by the Dawn smoke.
  const meshHandle = world.allocSharedRef('MeshAsset', rootMesh.value);
  const lodMaterialHandles = [
    world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: LOD_VISUALS[0].rgba, roughness: 0.5 }),
    ),
    world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: LOD_VISUALS[1].rgba, roughness: 0.5 }),
    ),
    world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: LOD_VISUALS[2].rgba, roughness: 0.5 }),
    ),
  ] as const;
  const sphereEntity = world.spawn(
    { component: Transform, data: { pos: [0, 0, 0] } },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [lodMaterialHandles[0]] } },
  ).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 12] } },
    { component: Camera, data: { fov: Math.PI / 4, aspect: target.width / target.height, near: 0.1, far: 100 } },
  ).unwrap();

  const cameraEntity = firstCamera(world);
  if (cameraEntity === undefined) throw new Error('scene has no Camera + Transform entity');
  const camera = createCameraControls(target, world, cameraEntity);
  camera.reset();

  // Imported glTF scene has no light; provide a real render component for Standard.
  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.5, -1, -0.3], intensity: 2 },
  });

  let frameCount = 0;
  let activeMaterialLevel = 0;
  const frame = async (): Promise<void> => {
    void worldContext;
    world.update().unwrap();
    const drawn = renderer.draw(frameRequest);
    if (!drawn.ok) console.error('[hello-lod-occlusion] draw failed', drawn.error);
    if (drawn.ok) {
      const observed = await renderer.observe(drawn.value, { include: [] });
      if (!observed.ok) console.error('[hello-lod-occlusion] observe failed', observed.error);
    }
    const inspection = renderer.inspect();
    const lodOcclusion = inspection.lodOcclusion;
    if (lodOcclusion !== undefined) {
      const selectedLevel = updateLodHud(lodOcclusion, camera.snapshot(), lodIndexCounts);
      if (selectedLevel !== activeMaterialLevel) {
        const nextMaterial = lodMaterialHandles[selectedLevel] ?? lodMaterialHandles[0];
        const materialUpdate = world.set(sphereEntity, MeshRenderer, { materials: [nextMaterial] });
        if (!materialUpdate.ok) console.error('[hello-lod-occlusion] LOD material update failed', materialUpdate.error);
        else activeMaterialLevel = selectedLevel;
      }
      (globalThis as { __forgeaxLodInspection?: unknown }).__forgeaxLodInspection = lodOcclusion;
      if (status) {
        status.textContent = JSON.stringify({
          asset: 'lod-scene.gltf',
          sceneGuid: sceneGuid.toString(),
          frame: frameCount,
          controls: camera.snapshot(),
          lodAssetsReady: lodReadiness,
          capabilities: inspection.capabilities,
          gpuDriven: inspection.renderScene.gpuDriven,
          lodOcclusion,
        }, null, 2);
      }
    }
    frameCount += 1;
    requestAnimationFrame(() => { void frame(); });
  };
  requestAnimationFrame(() => { void frame(); });
}

function firstCamera(world: World): EntityHandle | undefined {
  const query = world.query({ with: [Camera, Transform] }).unwrap();
  for (const row of query) return row.entity;
  return undefined;
}

function updateLodHud(
  inspection: {
    readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
    readonly count: { readonly visible: number; readonly occluded: number };
  },
  camera: { readonly distance: number; readonly yaw: number; readonly pitch: number },
  lodIndexCounts: readonly number[],
): number {
  let selectedLevel = 0;
  for (const row of inspection.lodHistogram) {
    if (row.count > 0) selectedLevel = row.level;
  }
  if (lodLevel) lodLevel.textContent = `LOD${selectedLevel}`;
  const visual = LOD_VISUALS[selectedLevel] ?? LOD_VISUALS[0];
  const triangleCount = Math.floor((lodIndexCounts[selectedLevel] ?? 0) / 3);
  if (lodGeometry) {
    lodGeometry.textContent = `${visual.label} · ${triangleCount} 个三角形`;
    lodGeometry.style.color = visual.cssColor;
  }
  if (lodDetail) {
    lodDetail.textContent = `GPU 自动选择 · ${camera.distance}m · 可见 ${inspection.count.visible} / 遮挡 ${inspection.count.occluded}`;
  }
  return selectedLevel;
}

interface CameraControls {
  readonly reset: () => void;
  readonly setDistance: (nextDistance: number) => void;
  readonly snapshot: () => { readonly distance: number; readonly yaw: number; readonly pitch: number };
}

function createCameraControls(target: HTMLCanvasElement, world: World, entity: EntityHandle): CameraControls {
  const initialDistance = 20;
  const minDistance = 2.5;
  const maxDistance = 60;
  let yaw = 0;
  let pitch = 0;
  let distance = initialDistance;
  let dragging = false;

  const apply = (): void => {
    const cosPitch = Math.cos(pitch);
    const position: [number, number, number] = [
      Math.sin(yaw) * cosPitch * distance,
      Math.sin(pitch) * distance,
      Math.cos(yaw) * cosPitch * distance,
    ];
    const rotation = quat.fromLookAt(quat.create(), position, [0, 0, 0], [0, 1, 0]);
    const result = world.set(entity, Transform, { pos: position, quat: rotation });
    if (!result.ok) console.error('[hello-lod-occlusion] camera update failed', result.error);
  };

  const reset = (): void => {
    yaw = 0;
    pitch = 0;
    distance = initialDistance;
    apply();
  };

  const setDistance = (nextDistance: number): void => {
    if (!Number.isFinite(nextDistance)) return;
    distance = Math.min(maxDistance, Math.max(minDistance, nextDistance));
    apply();
  };

  const zoom = (delta: number): void => {
    distance = Math.min(maxDistance, Math.max(minDistance, distance * Math.exp(delta * 0.0015)));
    apply();
  };

  target.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    target.focus();
    target.setPointerCapture(event.pointerId);
  });
  target.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    yaw -= event.movementX * 0.008;
    pitch = Math.max(-1.45, Math.min(1.45, pitch - event.movementY * 0.008));
    apply();
  });
  const stopDragging = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  };
  target.addEventListener('pointerup', stopDragging);
  target.addEventListener('pointercancel', stopDragging);
  target.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoom(event.deltaY);
  }, { passive: false });
  for (const button of target.ownerDocument.querySelectorAll<HTMLButtonElement>('[data-distance]')) {
    const preset = Number(button.dataset.distance);
    if (!Number.isFinite(preset)) continue;
    button.addEventListener('click', () => setDistance(preset));
  }
  target.addEventListener('keydown', (event) => {
    const presetDistance = event.key === '1' ? 5 : event.key === '2' ? 20 : event.key === '3' ? 45 : undefined;
    if (presetDistance !== undefined) {
      event.preventDefault();
      setDistance(presetDistance);
      return;
    }
    if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      reset();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoom(-120);
      return;
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoom(120);
      return;
    }
    const rotateStep = 0.08;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      yaw += event.key === 'ArrowLeft' ? rotateStep : -rotateStep;
      apply();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      pitch = Math.max(-1.45, Math.min(1.45, pitch + (event.key === 'ArrowUp' ? rotateStep : -rotateStep)));
      apply();
    }
  });

  return {
    reset,
    setDistance,
    snapshot: () => ({
      distance: Number(distance.toFixed(2)),
      yaw: Number(yaw.toFixed(2)),
      pitch: Number(pitch.toFixed(2)),
    }),
  };
}

function findGuid(kind: string): AssetGuid {
  const entry = (lodMeta.subAssets as readonly SubAssetEntry[]).find((candidate) => candidate.kind === kind);
  if (entry === undefined) throw new Error(`LOD sidecar has no ${kind} GUID`);
  const parsed = AssetGuid.parse(entry.guid);
  if (!parsed.ok) throw new Error(`invalid ${kind} GUID: ${parsed.error.code}`);
  return parsed.value;
}
