// hello-topology -- the focused public Points/Lines carrier.
//
// The query-free URL remains the legacy line-list topology oracle. The two
// focused URLs use the same public MeshAsset and Materials.unlit authoring
// with Points and Lines attached; evidenceLane selects only the carrier URL.

import { createApp } from '@forgeax/engine-app';
import type { CanvasAppError } from '@forgeax/engine-app';
import { buildMeshAttributeMapForUvSets } from '@forgeax/engine-geometry';
import {
  Camera,
  Lines,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointShapeValue,
  Points,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import type { Handle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const FLOATS_PER_VERTEX = 12;
const FOCUSED_ROUTES = ['?evidenceLane=webgpu', '?evidenceLane=wgpu-webgl2'] as const;

/** Build the legacy vertex-only line-list wireframe retained by this carrier. */
export function buildWireframeBoxLineList(half = 0.8): MeshAsset {
  const corners: readonly (readonly [number, number, number])[] = [
    [-half, -half, -half], [half, -half, -half], [half, half, -half], [-half, half, -half],
    [-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half],
  ];
  const edges: readonly (readonly [number, number])[] = [
    [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const vertices = new Float32Array(edges.length * 2 * FLOATS_PER_VERTEX);
  const position = new Float32Array(edges.length * 2 * 3);
  let vertex = 0;
  for (const [first, second] of edges) {
    for (const cornerIndex of [first, second]) {
      const corner = corners[cornerIndex] as readonly [number, number, number];
      const vertexOffset = vertex * FLOATS_PER_VERTEX;
      vertices.set(corner, vertexOffset);
      position.set(corner, vertex * 3);
      vertex += 1;
    }
  }
  return meshAsset('line-list', vertices, position, vertex);
}

function meshAsset(
  topology: 'point-list' | 'line-list',
  vertices: Float32Array,
  position: Float32Array,
  vertexCount: number,
): MeshAsset {
  return {
    kind: 'mesh',
    vertices,
    attributes: { ...buildMeshAttributeMapForUvSets(1), position },
    submeshes: [{
      indexOffset: 0,
      indexCount: 0,
      vertexCount,
      topology,
      materialSlot: 0,
    }],
    materialSlots: [{ slotName: 'focused-points-lines' }],
  };
}

function createFocusedMesh(topology: 'point-list' | 'line-list'): MeshAsset {
  const positions = topology === 'point-list'
    ? [[-0.65, 0.25, 0], [-0.2, 0.55, 0], [0.25, 0.2, 0], [0.65, 0.5, 0]]
    : [[-0.8, -0.45, 0], [0.8, -0.45, 0], [-0.8, -0.1, 0], [0.8, -0.1, 0], [-0.8, 0.25, 0], [0.8, 0.25, 0]];
  const vertices = new Float32Array(positions.length * FLOATS_PER_VERTEX);
  const position = new Float32Array(positions.length * 3);
  positions.forEach((value, index) => {
    vertices.set(value, index * FLOATS_PER_VERTEX);
    position.set(value, index * 3);
  });
  return meshAsset(topology, vertices, position, positions.length);
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) throw new Error('[topology] missing <canvas id="app"> in index.html');

const query = new URLSearchParams(window.location.search);
const evidenceLane = query.get('evidenceLane');
const falsify = query.get('falsify');
const authoringSandbox = query.get('authoringSandbox') === '1';
void (evidenceLane === 'webgpu' || evidenceLane === 'wgpu-webgl2'
  ? bootstrapFocused(canvas, evidenceLane, falsify, authoringSandbox)
  : bootstrapLegacy(canvas));

async function bootstrapFocused(
  target: HTMLCanvasElement,
  lane: 'webgpu' | 'wgpu-webgl2',
  falsify: string | null,
  authoringSandbox: boolean,
): Promise<void> {
  const appOptions = lane === 'wgpu-webgl2' ? await loadWebGl2Options() : {};
  const appResult = await createApp(target, appOptions, forgeaxBundlerAdapter());
  if (!appResult.ok) return reportAppError(appResult.error);
  const app = appResult.value;
  const world = app.world;
  const material = Materials.unlit([0.1, 0.9, 1, falsify === 'alpha' ? 0.4 : 1], {
    castShadow: false,
    renderState: {
      ...(falsify === 'depth-sort' || falsify === 'alpha'
        ? { depthWriteEnabled: false }
        : {}),
      ...(falsify === 'alpha'
        ? {
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          }
        : {}),
    },
    queue: falsify === 'sort' ? 3001 : 3000,
  });
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', material);
  const pointMeshHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', createFocusedMesh('point-list'));
  const lineMeshHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', createFocusedMesh('line-list'));

  world.spawn(
    { component: Transform, data: { pos: [falsify === 'frustum' ? 0.85 : 0, 0, -2], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: pointMeshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
    {
      component: Points,
      data: {
        sizePx: 16,
        shape: falsify === 'point-square' ? PointShapeValue.square : PointShapeValue.circle,
      },
    },
  ).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, -2], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: lineMeshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
    { component: Lines, data: { widthPx: falsify === 'line-width' ? 1 : 4 } },
  ).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 2], quat: [0, 0, 0, 1] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) } },
  ).unwrap();

  const start = app.start();
  if (!start.ok) return reportAppError(start.error);
  const backend = app.renderer.inspect().capabilities.backendKind;
  const hud = document.querySelector<HTMLDivElement>('#topology-hud');
  if (hud !== null) hud.textContent = `evidenceLane=${lane} backend=${backend} points-lines`;
  const host = window as typeof window & {
    __pointsLinesEvidence?: {
      readonly evidenceLane: typeof lane;
      readonly routes: readonly string[];
      readonly backend: typeof backend;
      readonly backendKind: typeof backend;
      readonly authoringSandbox: boolean;
      readonly validationErrors: number;
      readonly falsify: string | null;
      readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number };
      readonly authoring: {
        readonly pointSizePx: number;
        readonly pointShape: string;
        readonly lineWidthPx: number;
        readonly depthWriteEnabled: boolean;
        readonly alpha: number;
        readonly sortQueue: number;
        readonly frustumMarginPx: number;
      };
      readonly inspect: () => unknown;
      readonly capture: () => string;
    };
  };
  host.__pointsLinesEvidence = {
    evidenceLane: lane,
    routes: FOCUSED_ROUTES,
    backend,
    backendKind: backend,
    authoringSandbox,
    validationErrors: 0,
    falsify,
    get viewport() {
      return { width: target.width, height: target.height, dpr: globalThis.devicePixelRatio || 1 };
    },
    authoring: {
      pointSizePx: 16,
      pointShape: falsify === 'point-square' ? 'square' : 'circle',
      lineWidthPx: falsify === 'line-width' ? 1 : 4,
      depthWriteEnabled: falsify !== 'depth-sort',
      alpha: falsify === 'alpha' ? 0.4 : 1,
      sortQueue: falsify === 'sort' ? 3001 : 3000,
      frustumMarginPx: falsify === 'frustum' ? 8 : 0,
    },
    inspect: () => app.renderer.inspect().renderScene.pointsLines,
    capture: () => target.toDataURL('image/png'),
  };
  console.warn(`[topology] evidenceLane=${lane} backend=${backend}`);
}

async function loadWebGl2Options(): Promise<{
  readonly rhi: import('@forgeax/engine-rhi').RhiInstance;
}> {
  const backend = await import('@forgeax/engine-rhi-wgpu');
  await backend.ensureReady();
  return { rhi: backend.rhi };
}

async function bootstrapLegacy(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return reportAppError(appResult.error);
  const app = appResult.value;
  const assets = app.assets;
  if (assets === null) {
    console.error('[topology] AssetRegistry is null (renderer construction failed)');
    return;
  }
  const world = app.world;
  const meshHandle: Handle<'MeshAsset', 'shared'> = world.allocSharedRef('MeshAsset', buildWireframeBoxLineList());
  const materialHandle: Handle<'MaterialAsset', 'shared'> = world.allocSharedRef(
    'MaterialAsset',
    Materials.unlit([0.1, 0.9, 1, 1], { castShadow: false }),
  );
  world.spawn(
    { component: Transform, data: { quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [1.6, 1.4, 3.2], quat: [-0.1804578, 0.22576895, 0.04260031, 0.9563726] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) } },
  ).unwrap();
  const start = app.start();
  if (!start.ok) return reportAppError(start.error);
  console.warn(`[topology] legacy backend=${app.renderer.inspect().capabilities.backendKind}`);
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[topology] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[topology] ${err.code}: ${err.hint}`);
}
