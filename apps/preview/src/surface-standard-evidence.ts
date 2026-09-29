import type { App } from '@forgeax/engine-app';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import {
  assetGuid,
  PACKAGE_IDS,
  RUSTED_IRON_MATERIAL_GUID,
} from '../../../templates/game-3d/assets/shared/asset-refs';
import { surfaceEvidenceGuid } from './surface-standard-evidence-identity';

const DEFAULT_PHYSICAL_SOURCE_KEY = 'material/painted-evidence';
const CUSTOM_PHYSICAL_SOURCE_KEY = 'material/rusted-iron-custom-physical';
const DEFAULT_BASE_GUID = AssetGuid.format(assetGuid(PACKAGE_IDS.materials, 'material/ground'));
const CUSTOM_BASE_GUID = AssetGuid.format(RUSTED_IRON_MATERIAL_GUID);

const CELLS = [
  {
    id: 'default-base',
    guid: DEFAULT_BASE_GUID,
    sourceKey: 'material/ground',
    pass: 'deferred',
    rootPlan: 'base-deferred',
  },
  {
    id: 'custom-base',
    guid: CUSTOM_BASE_GUID,
    sourceKey: 'material/rusted-iron',
    pass: 'deferred',
    rootPlan: 'base-deferred',
  },
  {
    id: 'default-physical',
    guid: surfaceEvidenceGuid(DEFAULT_PHYSICAL_SOURCE_KEY),
    sourceKey: 'apps/preview/assets/surface-standard-evidence.pack.ts#material/painted-evidence',
    pass: 'forward',
    rootPlan: 'physical-forward',
  },
  {
    id: 'custom-physical',
    guid: surfaceEvidenceGuid(CUSTOM_PHYSICAL_SOURCE_KEY),
    sourceKey:
      'apps/preview/assets/surface-standard-evidence.pack.ts#material/rusted-iron-custom-physical',
    pass: 'forward',
    rootPlan: 'physical-forward',
  },
] as const;

const EVIDENCE_SOURCE_SHA =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_FORGEAX_EVIDENCE_SOURCE_SHA ?? 'unavailable';
const EVIDENCE_BUILD_ID =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_FORGEAX_EVIDENCE_BUILD_ID ?? 'unavailable';
const SURFACE_WIDTH = 960;
const SURFACE_HEIGHT = 540;

function sampleWebgl2Cell(
  pixels: Uint8Array,
  width: number,
  height: number,
  index: number,
): { sample: number[]; signalPixels: number; x: number; y: number } {
  const startX = Math.floor((index * width) / CELLS.length);
  const endX = Math.max(startX + 1, Math.floor(((index + 1) * width) / CELLS.length));
  const candidates: Array<{ sample: number[]; x: number; y: number }> = [];
  for (let y = 0; y < height; y += 4) {
    for (let x = startX; x < endX; x += 4) {
      const offset = (y * width + x) * 4;
      const sample = [...pixels.slice(offset, offset + 4)];
      if ((sample[0] ?? 0) + (sample[1] ?? 0) + (sample[2] ?? 0) > 0) {
        candidates.push({ sample, x, y });
      }
    }
  }
  candidates.sort(
    (left, right) =>
      (left.sample[0] ?? 0) +
      (left.sample[1] ?? 0) +
      (left.sample[2] ?? 0) -
      ((right.sample[0] ?? 0) + (right.sample[1] ?? 0) + (right.sample[2] ?? 0)),
  );
  const selected = candidates[Math.floor(candidates.length / 2)];
  if (selected !== undefined) return { ...selected, signalPixels: candidates.length };
  const x = Math.min(width - 1, Math.max(0, Math.floor(((index + 0.5) * width) / CELLS.length)));
  const y = Math.floor(height / 2);
  const offset = (y * width + x) * 4;
  return { sample: [...pixels.slice(offset, offset + 4)], signalPixels: 0, x, y };
}

function sourceClosureFor(cell: (typeof CELLS)[number]): readonly string[] {
  if (cell.id === 'custom-base') {
    return [
      'templates/game-3d/assets/materials.pack.ts',
      'templates/game-3d/assets/shaders/rusted-iron.wgsl',
    ];
  }
  if (cell.id === 'custom-physical') {
    return [
      'apps/preview/assets/surface-standard-evidence.pack.ts',
      'templates/game-3d/assets/shaders/rusted-iron.wgsl',
    ];
  }
  if (cell.id === 'default-physical') {
    return ['apps/preview/assets/surface-standard-evidence.pack.ts'];
  }
  return ['templates/game-3d/assets/materials.pack.ts'];
}

export interface SurfaceStandardEvidenceOptions {
  /** Keep the normal Preview frame loop paused while this isolated lane owns the renderer. */
  readonly resumeApp?: boolean;
}

export async function captureSurfaceStandardEvidence(
  app: App,
  options: SurfaceStandardEvidenceOptions = {},
): Promise<Record<string, unknown>> {
  const resumeApp = options.resumeApp ?? true;
  const assets = app.assets;
  if (assets === undefined) {
    return {
      status: 'unavailable',
      blocker: { code: 'asset-registry-unavailable', stage: 'load' },
      cells: [],
    };
  }
  const guidOwners = new Map<string, string[]>();
  for (const cell of CELLS) {
    const owners = guidOwners.get(cell.guid) ?? [];
    owners.push(cell.id);
    guidOwners.set(cell.guid, owners);
  }
  const identityCollision = [...guidOwners.entries()].find(([, owners]) => owners.length > 1);
  if (identityCollision !== undefined) {
    return {
      status: 'unavailable',
      blocker: {
        code: 'surface-publication-identity-collision',
        stage: 'publication',
        detail: {
          guid: identityCollision[0],
          cells: identityCollision[1],
          expected:
            'each root contract has a unique GUID or an observed publication generation from Catalog',
          observed:
            'custom-physical reuses the custom-base GUID and no Catalog publication generation is exposed',
          sourceSha: EVIDENCE_SOURCE_SHA,
          buildId: EVIDENCE_BUILD_ID,
        },
      },
      cells: [],
    };
  }
  const catalog = assets.listCatalog() as readonly {
    guid: string;
    sourceKey?: string;
    packageUrl: string;
    publication?: { generation?: number };
  }[];
  const publicationRows = await Promise.all(
    CELLS.map(async (cell) => {
      const row = catalog.find((entry) => entry.guid.toLowerCase() === cell.guid);
      if (row === undefined || row.packageUrl.length === 0) return { cell, row };
      const response = await fetch(row.packageUrl);
      if (!response.ok) return { cell, row };
      const pack = (await response.json()) as { generation?: unknown; digest?: unknown };
      return {
        cell,
        row,
        publicationGeneration:
          typeof pack.generation === 'number' && Number.isSafeInteger(pack.generation)
            ? pack.generation
            : undefined,
        publicationDigest: typeof pack.digest === 'string' ? pack.digest : undefined,
      };
    }),
  );
  const missingPublication = publicationRows.find(
    ({ row, publicationGeneration }) =>
      row?.sourceKey === undefined || publicationGeneration === undefined,
  );
  if (missingPublication !== undefined) {
    return {
      status: 'unavailable',
      blocker: {
        code: 'surface-publication-tuple-unavailable',
        stage: 'publication',
        detail: {
          cell: missingPublication.cell.id,
          guid: missingPublication.cell.guid,
          sourceKey: missingPublication.row?.sourceKey,
          publicationGeneration: missingPublication.publicationGeneration,
          expected:
            'Catalog to expose the published sourceKey and publication generation for every cooked root',
          observed: 'the Preview runtime catalog row does not expose a complete publication tuple',
          sourceSha: EVIDENCE_SOURCE_SHA,
          buildId: EVIDENCE_BUILD_ID,
        },
      },
      cells: [],
    };
  }
  const loaded = await Promise.all(
    CELLS.map(async (cell) => ({
      cell,
      result: await assets.loadByGuid(assets.parseGuid(cell.guid)),
    })),
  );
  const missing = loaded.find((entry) => !entry.result.ok);
  if (missing !== undefined) {
    return {
      status: 'unavailable',
      blocker: { code: 'surface-pack-load-failed', stage: 'load', detail: missing.cell.id },
      cells: [],
    };
  }
  const world = new World();
  const stopped = resumeApp ? app.stop() : undefined;
  if (stopped !== undefined && !stopped.ok) {
    return {
      status: 'unavailable',
      blocker: { code: 'surface-preview-stop-failed', stage: 'setup' },
      cells: [],
    };
  }
  const attached = app.renderer.attach(world);
  if (!attached.ok) {
    if (resumeApp) app.start();
    return {
      status: 'unavailable',
      blocker: {
        code: 'surface-renderer-attach-failed',
        stage: 'attach',
        detail: attached.error.code,
      },
      cells: [],
    };
  }
  const renderErrors: unknown[] = [];
  const unsubscribeRenderErrors = app.renderer.subscribe((event) => {
    if (event.kind !== 'error') return;
    renderErrors.push({
      code: event.error.code,
      expected: event.error.expected,
      hint: event.error.hint,
      ...('detail' in event.error ? { detail: event.error.detail } : {}),
    });
  });
  const lease = attached.value;
  try {
    const plane = createPlaneGeometry(1.3, 1.3);
    if (!plane.ok)
      return {
        status: 'unavailable',
        blocker: { code: 'surface-geometry-failed', stage: 'setup' },
        cells: [],
      };
    const mesh = world.allocSharedRef('MeshAsset', plane.value);
    for (let index = 0; index < loaded.length; index += 1) {
      const entry = loaded[index];
      if (entry === undefined || !entry.result.ok) continue;
      const x = (index - 1.5) * 1.45;
      const material = world.allocSharedRef('MaterialAsset', entry.result.value);
      world
        .spawn(
          { component: Transform, data: { pos: [x, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    }
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            ...perspective({
              fov: Math.PI / 4,
              aspect: SURFACE_WIDTH / SURFACE_HEIGHT,
              near: 0.1,
              far: 20,
            }),
            clearColor: [0, 0, 0, 1],
          },
        },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
      })
      .unwrap();
    // Authored Surface PSOs are compiled lazily on first use. Submit the same
    // world through the real Renderer until those immutable pipelines are
    // ready, matching the Browser/Dawn evidence lanes instead of treating a
    // first-touch skip-draw as a backend failure.
    for (let frame = 0; frame < 6; frame += 1) {
      world.update(1 / 60).unwrap();
      const draw = app.renderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
      });
      if (!draw.ok)
        return {
          status: 'unavailable',
          blocker: { code: 'surface-render-failed', stage: 'draw', detail: draw.error.code },
          cells: [],
        };
      const completion = await draw.value.completed;
      if (!completion.ok)
        return {
          status: 'unavailable',
          blocker: {
            code: 'surface-render-completion-failed',
            stage: 'draw',
            detail: completion.error.code,
          },
          cells: [],
        };
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const canvas = document.querySelector<HTMLCanvasElement>('#app');
    const gl = canvas?.getContext('webgl2');
    const inspection = app.renderer.inspect();
    if (
      gl === null ||
      gl === undefined ||
      canvas === null ||
      inspection.capabilities.backendKind !== 'wgpu-webgl2'
    ) {
      return {
        status: 'unavailable',
        blocker: {
          code: 'surface-webgl2-readback-unavailable',
          stage: 'readback',
          detail: inspection.capabilities.backendKind,
        },
        cells: [],
      };
    }
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const cellReadbacks = CELLS.map((_, index) =>
      sampleWebgl2Cell(pixels, canvas.width, canvas.height, index),
    );
    if (renderErrors.length > 0) {
      return {
        status: 'unavailable',
        blocker: {
          code: 'surface-render-errors',
          stage: 'draw',
          detail: { errors: renderErrors },
        },
        cells: [],
      };
    }
    const missingSignal = cellReadbacks.findIndex((cell) => cell.signalPixels === 0);
    if (missingSignal >= 0) {
      return {
        status: 'unavailable',
        blocker: {
          code: 'surface-webgl2-readback-empty',
          stage: 'readback',
          detail: {
            expected: 'every Surface cell has non-clear RGB after the custom Renderer draw',
            observed: `cell ${CELLS[missingSignal]?.id ?? missingSignal} has no non-clear samples`,
            readbackKind: 'webgl2-readPixels',
            readbackFormat: 'rgba8unorm',
            readbackWidth: canvas.width,
            readbackHeight: canvas.height,
            signalPixels: cellReadbacks.map((cell) => cell.signalPixels),
          },
        },
        cells: [],
      };
    }
    const cells = CELLS.map((cell, index) => {
      const publication = publicationRows.find(({ cell: candidate }) => candidate.id === cell.id);
      const loadedEntry = loaded.find(({ cell: candidate }) => candidate.id === cell.id);
      const program =
        loadedEntry?.result.ok && loadedEntry.result.value.kind === 'material'
          ? loadedEntry.result.value.passes?.[0]?.program
          : undefined;
      const actualPasses =
        loadedEntry?.result.ok && loadedEntry.result.value.kind === 'material'
          ? loadedEntry.result.value.passes?.map((entry) => entry.name)
          : [];
      const readback = cellReadbacks[index];
      const sample = readback?.sample ?? [0, 0, 0, 0];
      return {
        id: cell.id,
        record: {
          backend: 'chromium-webgl2',
          adapter: 'wgpu-webgl2',
          lane: 'direct',
          status: 'pass',
          pass: cell.pass,
          actualPasses,
          materialGuid: cell.guid,
          sourceKey: publication?.row?.sourceKey ?? cell.sourceKey,
          publicationGeneration: publication?.publicationGeneration,
          publicationDigest: publication?.publicationDigest,
          closure: 'forgeax_material::surface_v1',
          cookIdentity: publication?.publicationDigest,
          programIdentity: program?.module ?? 'unavailable',
          pipelineIdentity: `${cell.pass}:${cell.rootPlan}:${program?.module ?? 'unavailable'}`,
          sourceClosure: sourceClosureFor(cell),
          rootPlan: cell.rootPlan,
          samples: sample,
          signalPixels: readback?.signalPixels ?? 0,
          observed: `rgba8unorm readback ${sample.join(',')}`,
          verdict: 'pixel',
          confidence: 1,
          provenance: {
            sourceSha: EVIDENCE_SOURCE_SHA,
            buildId: EVIDENCE_BUILD_ID,
            frameId: inspection.frame.frameId,
            artifact: `${publication?.row?.packageUrl ?? 'catalog-unavailable'}#${cell.guid}`,
            sourceClosure: sourceClosureFor(cell),
            readbackKind: 'webgl2-readPixels',
            readbackFormat: 'rgba8unorm',
            readbackWidth: canvas.width,
            readbackHeight: canvas.height,
            readbackOrigin: 'bottom-left',
            readbackSample: { x: readback?.x ?? 0, y: readback?.y ?? 0 },
            clearColor: [0, 0, 0, 1],
            actualPasses,
            cookIdentity: publication?.publicationDigest,
            programIdentity: program?.module ?? 'unavailable',
            pipelineIdentity: `${cell.pass}:${cell.rootPlan}:${program?.module ?? 'unavailable'}`,
          },
        },
      };
    });
    return { status: 'pass', backend: 'chromium-webgl2', cells };
  } finally {
    lease.dispose();
    unsubscribeRenderErrors();
    if (resumeApp) app.start();
  }
}
