import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_ROOT = resolve(process.env.FORGEAX_BENCH_ROOT ?? SCRIPT_ROOT);
const LABEL = process.env.FORGEAX_BENCH_LABEL ?? 'scene';
const SAMPLE_COUNT = parsePositiveInt(process.env.FORGEAX_BENCH_SAMPLES, 31);
const WARMUP_COUNT = parsePositiveInt(process.env.FORGEAX_BENCH_WARMUP, 8);
const ENTITY_COUNT = parsePositiveInt(process.env.FORGEAX_BENCH_ENTITIES, 32);
const GPU_NULL = process.env.FORGEAX_BENCH_GPU === 'null';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

interface BenchRenderable {
  readonly authorVisible?: boolean;
  readonly entityKey: number;
  readonly worldId: number;
  readonly transform: { readonly world: Float32Array };
  readonly instances?: {
    readonly instanceCount: number;
    readonly transforms: Float32Array;
  };
  readonly material: { readonly baseColor: ArrayLike<number> };
}

interface BenchFrame {
  readonly renderables: readonly BenchRenderable[];
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(samples: readonly number[], quantile: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1);
  return ordered[index] ?? 0;
}

function matrices(count: number, x: number): Float32Array {
  const result = new Float32Array(count * 16);
  for (let index = 0; index < count; index += 1) {
    result.set(IDENTITY, index * 16);
    result[index * 16 + 12] = x + index * 0.1;
  }
  return result;
}

function material(values: Record<string, unknown>) {
  return {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values,
  };
}

function sourceFile(relativePath: string): string {
  return pathToFileURL(join(SOURCE_ROOT, relativePath)).href;
}

function sourceHead(): string | undefined {
  try {
    return execFileSync('git', ['-C', SOURCE_ROOT, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function sourceStatus(): { readonly trackedDirty: boolean; readonly entries: readonly string[] } {
  try {
    const output = execFileSync(
      'git',
      ['-C', SOURCE_ROOT, 'status', '--porcelain=v1', '--untracked-files=no'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return {
      trackedDirty: output.length > 0,
      entries: output.length === 0 ? [] : output.split('\n'),
    };
  } catch {
    return { trackedDirty: false, entries: [] };
  }
}

async function loadEngine() {
  const [ecs, projection, scene, assets, components, extract, renderScene, instances] =
    await Promise.all([
      import(sourceFile('packages/ecs/dist/index.mjs')),
      import(sourceFile('packages/ecs/dist/projection/index.mjs')),
      import(sourceFile('packages/scene/dist/index.mjs')),
      import(sourceFile('packages/assets-runtime/dist/index.mjs')),
      import(sourceFile('packages/render/src/components/index.ts')),
      import(sourceFile('packages/render/src/render-system-extract.ts')),
      import(sourceFile('packages/render/src/scene/render-scene.ts')),
      import(sourceFile('packages/render/src/instances.ts')),
    ]);
  const gpu = GPU_NULL ? await import(sourceFile('packages/rhi-null/dist/index.mjs')) : undefined;
  return {
    ecs,
    projection,
    scene,
    assets,
    components,
    extract,
    renderScene,
    gpu,
    collections: new instances.InstanceProjectionStore(),
  };
}

function createWorld(engine: Awaited<ReturnType<typeof loadEngine>>, withCamera: boolean) {
  const { World } = engine.ecs;
  const { ChildOf, Transform, registerPropagateTransforms } = engine.scene;
  const {
    Camera,
    Instances,
    MeshFilter,
    MeshRenderer,
    MotionBlur,
    Visibility,
    VisibilityStateValue,
  } = engine.components;
  const world = new World();
  registerPropagateTransforms(world);
  const values: Record<string, unknown> = {
    baseColor: [1, 0, 0, 1],
    metallic: 0,
    roughness: 0.5,
  };
  const materialHandle = world.allocSharedRef('MaterialAsset', material(values));
  const materialValue = world
    .spawn({
      component: engine.assets.RuntimeMaterialValue,
      data: { asset: materialHandle, parameter: 'baseColor', kind: 2, value: [1, 0, 0, 1] },
    })
    .unwrap();
  if (withCamera) {
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 100] } },
        { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 500 } },
        { component: MotionBlur, data: { shutterAngle: 180 } },
      )
      .unwrap();
  }
  const parentA = world
    .spawn(
      { component: Transform, data: { pos: [-1, 0, 0] } },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  const parentB = world
    .spawn(
      { component: Transform, data: { pos: [1, 0, 0] } },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  const mixed = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: ChildOf, data: { parent: parentA } },
      { component: Visibility, data: { state: VisibilityStateValue.inherited } },
      { component: MeshFilter, data: { assetHandle: engine.assets.HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
      { component: Instances, data: { transforms: matrices(2, 0) } },
    )
    .unwrap();
  const sharedConsumer = world
    .spawn(
      { component: Transform, data: { pos: [0.5, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: engine.assets.HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();
  const hiddenTarget = world
    .spawn(
      { component: Transform, data: { pos: [-0.5, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: engine.assets.HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  const ordinary = [];
  for (let index = 0; index < ENTITY_COUNT; index += 1) {
    ordinary.push(
      world
        .spawn(
          { component: Transform, data: { pos: [(index % 8) - 4, Math.floor(index / 8) - 2, 0] } },
          { component: MeshFilter, data: { assetHandle: engine.assets.HANDLE_CUBE } },
          { component: MeshRenderer, data: { materials: [materialHandle] } },
        )
        .unwrap(),
    );
  }
  world.update(0).unwrap();
  return {
    world,
    materialValue,
    mixed,
    sharedConsumer,
    hiddenTarget,
    ordinary,
    parentA,
    parentB,
  };
}

function renderableDigest(frame: BenchFrame) {
  return frame.renderables
    .filter((row) => row.authorVisible !== false)
    .map((row) => ({
      key: `${row.worldId}:${row.entityKey}`,
      world: Array.from(row.transform.world as Float32Array),
      instanceCount: row.instances?.instanceCount ?? null,
      instanceTransforms:
        row.instances === undefined ? null : Array.from(row.instances.transforms as Float32Array),
      baseColor: Array.from(row.material.baseColor as Float32Array),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function requestTouched(request: unknown): number {
  if (typeof request !== 'object' || request === null) return 0;
  const entitiesByWorld = (
    request as { readonly entitiesByWorld?: readonly (ReadonlySet<number> | undefined)[] }
  ).entitiesByWorld;
  return entitiesByWorld?.reduce((total, entities) => total + (entities?.size ?? 0), 0) ?? 0;
}

function makeNullDevice(engine: Awaited<ReturnType<typeof loadEngine>>) {
  if (engine.gpu === undefined) return undefined;
  const { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } = engine.gpu;
  class RecordingQueue extends RhiNullQueue {
    writeCalls = 0;
    writeBytes = 0;

    writeBuffer(
      buffer: unknown,
      bufferOffset: number,
      data: ArrayBufferView | ArrayBuffer,
      dataOffset?: number,
      size?: number,
    ) {
      this.writeCalls += 1;
      const sourceBytes = data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
      this.writeBytes += size ?? Math.max(0, sourceBytes - (dataOffset ?? 0));
      return super.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
    }
  }
  const queue = new RecordingQueue();
  const device = new RhiNullDevice(
    queue,
    (bookkeeper: unknown, deviceValue: unknown) =>
      new RhiNullCommandEncoder(bookkeeper, deviceValue),
  );
  return { queue, device };
}

async function run() {
  const engine = await loadEngine();
  const first = createWorld(engine, true);
  const second = createWorld(engine, false);
  const worlds = [first.world, second.world];
  const owner = { cameraOwner: 0, resourceOwner: 0 };
  const leases = [
    engine.projection.createRenderReadLease(first.world),
    engine.projection.createRenderReadLease(second.world),
  ];
  const requests: unknown[] = [];
  const nullDevice = makeNullDevice(engine);
  const scene = new engine.renderScene.PersistentRenderScene({
    instanceCollections: engine.collections,
    ...(nullDevice === undefined ? {} : { getDevice: () => nullDevice.device }),
  });
  const assets = new engine.assets.AssetRegistry({
    findMaterialArtifact: () => ({ ok: false, error: new Error('benchmark artifact miss') }),
  });
  const materialCaches = scene.materialSnapshotCacheStore();
  const build = (request: unknown) => {
    requests.push(request);
    return engine.extract.extractFrames(worlds, owner, assets, undefined, materialCaches, {
      cull: 'none',
      instanceCollections: engine.collections,
      retainHidden: true,
      renderables: request,
    });
  };
  const oracle = () =>
    engine.extract.extractFrames(worlds, owner, assets, undefined, undefined, {
      cull: 'none',
      instanceCollections: engine.collections,
      retainHidden: true,
      renderables: 'full',
    });
  const draw = () => scene.extractComposition(worlds, owner, 0, build, leases);
  const submit = (frame: BenchFrame) => {
    scene.prepareTemporalFrame(frame.renderables.filter((row) => row.authorVisible !== false));
    const committed = scene.commitTemporalFrame();
    if (!committed.ok) throw new Error(`temporal commit failed: ${committed.error.code}`);
  };

  try {
    const initial = draw();
    submit(initial);
    requests.length = 0;
    // Warmup mutates the same real ECS rows as measured samples. The full
    // extract oracle intentionally stays outside the timed section below.
    for (let sample = 0; sample < WARMUP_COUNT; sample += 1) {
      mutateWorkload(engine, first, sample);
      const frame = draw();
      verifyOracle(frame, oracle());
      submit(frame);
      requests.length = 0;
    }

    const samplesMs: number[] = [];
    const touched: number[] = [];
    const gpuWrites: number[] = [];
    const gpuBytes: number[] = [];
    let oracleChecks = 0;
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      mutateWorkload(engine, first, WARMUP_COUNT + sample);
      requests.length = 0;
      const writesBefore = nullDevice?.queue.writeCalls ?? 0;
      const bytesBefore = nullDevice?.queue.writeBytes ?? 0;
      const startedAt = performance.now();
      const frame = draw();
      const elapsed = performance.now() - startedAt;
      samplesMs.push(elapsed);
      touched.push(requests.reduce((total, request) => total + requestTouched(request), 0));
      gpuWrites.push((nullDevice?.queue.writeCalls ?? 0) - writesBefore);
      gpuBytes.push((nullDevice?.queue.writeBytes ?? 0) - bytesBefore);

      // Independent full extraction is deliberately outside the timed region.
      verifyOracle(frame, oracle());
      oracleChecks += 1;
      submit(frame);
    }

    const inspection = scene.inspect();
    const gpuInspection = inspection.gpu;
    const report = {
      schema: 'forgeax.render-scene-benchmark.v1',
      label: LABEL,
      sourceRoot: SOURCE_ROOT,
      sourceHead: sourceHead(),
      sourceStatus: sourceStatus(),
      workload: {
        worlds: worlds.length,
        ordinaryEntitiesPerWorld: ENTITY_COUNT,
        mixedFields: ['Instances', 'GlobalTransform', 'MaterialAsset', 'Visibility', 'ChildOf'],
        instanceCounts: [3, 0, 1, 2],
      },
      timing: {
        warmupCount: WARMUP_COUNT,
        sampleCount: SAMPLE_COUNT,
        medianMs: percentile(samplesMs, 0.5),
        p95Ms: percentile(samplesMs, 0.95),
        minMs: Math.min(...samplesMs),
        maxMs: Math.max(...samplesMs),
        samplesMs,
        oracleChecks,
        oracleTimed: false,
      },
      touched: {
        median: percentile(touched, 0.5),
        p95: percentile(touched, 0.95),
        samples: touched,
      },
      scene: {
        fullRebuilds: inspection.fullRebuilds,
        projectionRecords: inspection.projectionRecords,
        deltaFrames: inspection.deltaFrames,
        noChangeFrames: inspection.noChangeFrames,
        transformUpdates: inspection.transformUpdates,
      },
      gpu: {
        probe: GPU_NULL ? 'rhi-null' : 'disabled',
        status: gpuInspection.status,
        uploadCallsPerSample: gpuWrites,
        uploadBytesPerSample: gpuBytes,
        uploadCalls: nullDevice?.queue.writeCalls ?? 0,
        uploadBytes: nullDevice?.queue.writeBytes ?? 0,
        inspection: gpuInspection,
      },
    };
    console.info(JSON.stringify(report));
  } finally {
    leases[0]?.dispose();
    leases[1]?.dispose();
    scene.dispose();
  }
}

function mutateWorkload(
  engine: Awaited<ReturnType<typeof loadEngine>>,
  first: ReturnType<typeof createWorld>,
  sample: number,
): void {
  const { ChildOf, Transform } = engine.scene;
  const { Visibility, VisibilityStateValue } = engine.components;
  const count = [3, 0, 1, 2][sample % 4] ?? 2;
  const useParentB = sample % 2 === 0;
  first.world
    .set(first.mixed, engine.components.Instances, { transforms: matrices(count, -0.25) })
    .unwrap();
  first.world.set(first.mixed, Transform, { pos: [0.25 + (sample % 5) * 0.01, 0, 0] }).unwrap();
  first.world
    .set(first.mixed, ChildOf, { parent: useParentB ? first.parentB : first.parentA })
    .unwrap();
  first.world
    .set(first.parentA, Visibility, {
      state: useParentB ? VisibilityStateValue.hidden : VisibilityStateValue.visible,
    })
    .unwrap();
  first.world
    .set(first.parentB, Visibility, {
      state: useParentB ? VisibilityStateValue.visible : VisibilityStateValue.hidden,
    })
    .unwrap();
  first.world
    .set(first.hiddenTarget, Visibility, {
      state: sample % 2 === 0 ? VisibilityStateValue.hidden : VisibilityStateValue.visible,
    })
    .unwrap();
  first.world
    .set(first.materialValue, engine.assets.RuntimeMaterialValue, {
      value: sample % 2 === 0 ? [0, 1, 0, 1] : [1, 0, 0, 1],
    })
    .unwrap();
  first.world.update(0).unwrap();
}

function verifyOracle(frame: BenchFrame, oracle: BenchFrame): void {
  const actual = JSON.stringify(renderableDigest(frame));
  const expected = JSON.stringify(renderableDigest(oracle));
  if (actual !== expected) {
    throw new Error('persistent scene diverged from independent full-extract oracle');
  }
}

await run();
