/** Bounded runtime generation/storage measurements; no hardware FPS claim. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  AssetRegistry,
  captureAssetPublication,
  validateAssetPublication,
} from '../../packages/assets-runtime/dist/index.mjs';
import { World } from '../../packages/ecs/dist/index.mjs';
import {
  createFixedRuntimePackSnapshot,
  RuntimePackProducer,
} from '../../packages/import/dist/browser.mjs';
import { preparePackProgram } from '../../packages/pack/dist/runtime.mjs';
import { AssetGuid, definePackageId } from '../../packages/pack/dist/scriptable-pack.mjs';

const report = resolve(process.env.FORGEAX_EVIDENCE_FILE ?? 'artifacts/runtime-pack/overhead.json');
const parent = '01900000-0000-7000-8000-000000005001';
const instanceId = (width) => `01900000-0000-7000-8000-${String(5100 + width).padStart(12, '0')}`;
const content = {
  source: {
    schemaVersion: '2.0.0',
    kind: 'scriptable-pack-source',
    packageId: parent,
    source: 'runtime/measurement',
    program: 'build',
    runtime: { dependencies: [] },
    parameters: [{ name: 'width', type: 'f32', default: 1, minimum: 1, maximum: 64 }],
  },
  programs: {
    build: {
      artifact: preparePackProgram({
        entry: 'build.js',
        export: 'build',
        imports: { geometry: 'measurement-engine' },
        modules: {
          'build.js':
            "import { createBoxGeometry } from 'geometry'; export function build({ values }) { return { ok: true, value: { box: createBoxGeometry(values.width, 2, 3).unwrap() } }; }",
        },
      }).unwrap(),
    },
  },
};
const makeProducer = () => {
  const producer = new RuntimePackProducer({
    scopeId: 'overhead-proof',
    imports: {
      geometry: {
        identity: 'measurement-engine',
        url: new URL('../../packages/geometry/dist/index.mjs', import.meta.url).href,
      },
    },
    validate: (state, fetcher, dependencies) =>
      validateAssetPublication(
        state.rows,
        fetcher,
        { catalog: producer.catalog, fetcher: producer.fetch },
        { dependencies },
      ),
  });
  return producer;
};
const producer = makeProducer();
const registry = new AssetRegistry({});
registry.setCatalogSource(producer.catalog, producer.fetch);
const world = new World();
const guidFor = (width) =>
  AssetGuid.format(AssetGuid.derive(definePackageId(instanceId(width)), 'box'));
const timings = [],
  resourceCounts = [],
  fixedSnapshots = [];
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
try {
  (await producer.admit(content)).unwrap();
  for (let width = 1; width <= 32; width++) {
    const instance = {
      schemaVersion: '3.0.0',
      packageId: instanceId(width),
      parent,
      values: { width },
    };
    const guid = guidFor(width);
    const start = performance.now();
    (await producer.generate(instance)).unwrap();
    const payload = (await registry.loadByGuid(registry.parseGuid(guid))).unwrap();
    timings.push(performance.now() - start);
    assert.equal(payload.aabb[3] - payload.aabb[0], width);
    const handle = world.allocSharedRef('MeshAsset', payload);
    assert.equal(world.sharedRefs._liveCount(), 1);
    world.sharedRefs.release(handle).unwrap();
    resourceCounts.push(world.sharedRefs._liveCount());
    assert.equal(resourceCounts.at(-1), 0);
    // Export the actual encoded variant, including its cooked mesh bytes.
    const row = producer.rows().find((row) => row.guid === guid);
    assert.ok(row);
    const fixed = (
      await captureAssetPublication(row, producer.rows(), producer.catalog, producer.fetch)
    ).unwrap();
    fixedSnapshots.push(await createFixedRuntimePackSnapshot(fixed));
  }
  const sourceSnapshot = producer.snapshot();
  const parameterizedBytes = bytes(sourceSnapshot);
  const expandedBytes = bytes(fixedSnapshots);
  // Both sides are real JSON archives, and both must restore all 32 identities.
  for (const mode of ['source', 'fixed']) {
    const recovered = makeProducer();
    const assets = new AssetRegistry({});
    assets.setCatalogSource(recovered.catalog, recovered.fetch);
    try {
      for (const snapshot of mode === 'source' ? [sourceSnapshot] : fixedSnapshots) {
        (await recovered.restore(JSON.parse(JSON.stringify(snapshot)))).unwrap();
      }
      for (let width = 1; width <= 32; width++) {
        const payload = (await assets.loadByGuid(assets.parseGuid(guidFor(width)))).unwrap();
        assert.equal(payload.aabb[3] - payload.aabb[0], width);
      }
    } finally {
      assets.clearCatalogSource();
      assets.invalidateAll();
      recovered.dispose();
    }
  }
  assert.ok(
    parameterizedBytes < expandedBytes,
    'source and parameter selections should avoid storing every full variant',
  );
  const warm = timings.slice(1).sort((a, b) => a - b);
  const evidence = {
    variants: fixedSnapshots.length,
    storageFormat:
      'UTF-8 JSON runtime-pack-source/2 archives; both restored with matching GUIDs and AABBs',
    parameterizedBytes,
    expandedBytes,
    savedFraction: 1 - parameterizedBytes / expandedBytes,
    generationAndLoadMs: {
      first: timings[0],
      warm: { min: warm[0], median: warm[Math.floor(warm.length / 2)], max: warm.at(-1) },
    },
    resourceCounts,
    finalSharedRefs: world.sharedRefs._liveCount(),
    boundary:
      '32 box variants; shared Engine excluded on both sides; producer result cache disabled, ESM module cache retained; timing covers generate and GUID load, not a hardware threshold; shared refs only prove balanced consumer handles',
  };
  await mkdir(dirname(report), { recursive: true });
  await writeFile(report, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(`${report}.source.json`, JSON.stringify(sourceSnapshot));
  await writeFile(`${report}.fixed.json`, JSON.stringify(fixedSnapshots));
  console.log(JSON.stringify(evidence));
} finally {
  registry.clearCatalogSource();
  registry.invalidateAll();
  producer.dispose();
}
