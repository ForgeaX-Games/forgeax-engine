// Run from an extracted/deployed Engine archive, outside the producer checkout.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import {
  createAssetRegistry,
  createCatalogSource,
  defineAssetKind,
} from '@forgeax/engine/assets-runtime';
import { World } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { vec3 } from '@forgeax/engine/math';
import { createRapier3DPhysicsWorld, loadRapier3D } from '@forgeax/engine/physics-rapier3d';

const directory = resolve(process.argv[3] ?? './provider-output');
const guids = [
  '77777777-7777-4777-8777-777777777777',
  '88888888-8888-4888-8888-888888888888',
  '99999999-9999-4999-8999-999999999999',
];
const kind = defineAssetKind('wave1-shape');
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

if (process.argv[2] === '--produce') {
  // Tools stay in the producer process. The cold consumer needs only its files.
  const { NativeCookerRegistry } = await import('@forgeax/engine/pack/native-cooker');
  const { createRuntimePackPublication, projectExternalCatalogEntries } = await import(
    '@forgeax/engine/pack/build'
  );
  const { projectRuntimePack } = await import('@forgeax/engine/pack');
  const cooker = new NativeCookerRegistry();
  cooker.register({
    key: 'wave1',
    discover: (input) => input,
    cook: (input) => {
      const payload = {
        cells: [
          [-1, 0, 0],
          [0, 0, 0],
        ],
        cellSize: 1,
      };
      return {
        guid: input.guid,
        payload,
        refs: input.refs,
        inputFingerprint: digest(input.guid),
        artifacts: {
          body: {
            mediaType: 'application/json',
            assetCodec: { name: 'wave1-json', version: '1' },
            bytes: new TextEncoder().encode(JSON.stringify(payload)),
          },
        },
      };
    },
  });
  await mkdir(directory, { recursive: true });
  const assets = [];
  const outputs = [];
  for (let index = 0; index < guids.length; index++) {
    const guid = guids[index];
    const input = { guid, refs: index === 0 ? [guids[1]] : [] };
    const draft = (await cooker.runDraft('wave1', input)).unwrap();
    const product = (await cooker.run('wave1', input)).unwrap();
    const bytes = draft.artifacts.body.bytes;
    await writeFile(resolve(directory, `${guid}.json`), bytes);
    assets.push({
      guid,
      kind: 'wave1-shape',
      payload: draft.payload,
      refs: draft.refs,
      artifacts: {
        body: {
          path: `${guid}.json`,
          mediaType: 'application/json',
          assetCodec: { name: 'wave1-json', version: '1' },
          contentEncoding: 'identity',
          byteLength: bytes.length,
          integrity: { algorithm: 'sha256', digest: digest(bytes) },
        },
      },
    });
    outputs.push({
      guid,
      kind: 'wave1-shape',
      sourceKey: `wave1://shape/${index}`,
      digest: product.digest,
      refs: product.refs,
    });
  }
  const publication = createRuntimePackPublication({
    pack: { assets },
    scopeId: 'wave1',
    sourcePath: 'wave1://shapes',
    sourceRevision: '1',
    packageUrl: '/shapes.pack.json',
    inputFingerprint: digest('wave1'),
    outputs,
    generation: 1,
  });
  const pack = projectRuntimePack(publication.pack).unwrap();
  const rows = projectExternalCatalogEntries(
    {
      schemaVersion: 'provider/1',
      packageId: 'wave1',
      provenance: { provider: 'wave1', version: '1' },
      revision: { digest: digest('wave1'), observedAt: 1, rootId: 'wave1' },
    },
    'wave1://shapes',
    '/shapes.pack.json',
    outputs,
  );
  await writeFile(resolve(directory, 'shapes.pack.json'), JSON.stringify(pack));
  await writeFile(
    resolve(directory, 'catalog.json'),
    JSON.stringify(
      rows.map((row, index) => ({
        ...row,
        refs: outputs[index].refs,
        publication: publication.publication,
      })),
    ),
  );
  console.log(JSON.stringify({ producer: 'PASS', outputs: outputs.length }));
} else {
  const world = new World();
  const mesh = createBoxGeometry(2, 2, 1).unwrap();
  const handle = world.allocSharedRef('MeshAsset', mesh);
  assert.equal(world.sharedRefs.resolve(handle).unwrap(), mesh);
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw new Error(JSON.stringify(rapier));
  const physics = createRapier3DPhysicsWorld(rapier);
  physics.setGravity(vec3.create(0, 0, 0));
  physics.ensureBody(
    1,
    {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    { type: 1, mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
    {
      shape: 0,
      halfExtents: [0.25, 0.25, 0.25],
      radius: 0.25,
      halfHeight: 0.25,
      friction: 0.5,
      restitution: 0,
      density: 1,
      isSensor: 0,
      collisionGroups: 0xffffffff,
      solverGroups: 0xffffffff,
    },
  );
  const candidate = physics
    .prepareDerivedShapeCandidate({
      entity: 1,
      revision: 1,
      sourceKey: 'wave1://body',
      bodyType: 'dynamic',
      velocityPolicy: 'preserve',
      constraints: [],
      massProperties: {
        mode: 'explicit',
        mass: 2,
        centerOfMass: [0.25, 0, 0],
        principalInertia: [1, 1, 1],
      },
      shapes: [
        { id: 'left', revision: 1, cells: [[0, 0, 0]], voxelSize: [1, 1, 1], origin: [0, 0, 0] },
        { id: 'right', revision: 1, cells: [[0, 0, 0]], voxelSize: [1, 1, 1], origin: [2, 0, 0] },
      ],
      seams: [{ shapeA: 'left', shapeB: 'right', offset: [2, 0, 0] }],
    })
    .unwrap();
  assert.equal(physics.getDerivedShapes(1).length, 0);
  physics.admitDerivedShapeCandidate(candidate).unwrap();
  physics.step(1 / 60);
  assert.deepEqual(physics.getDerivedPublication(1).shapeIds, ['left', 'right']);
  assert.equal(physics.getDerivedBodyMass(1), 2);
  const server = createServer(async (req, res) => {
    try {
      res.end(await readFile(resolve(directory, (req.url ?? '/').slice(1))));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const entries = JSON.parse(await readFile(resolve(directory, 'catalog.json'), 'utf8'));
  const registry = createAssetRegistry({
    catalog: createCatalogSource({ entries }),
    scopeId: 'wave1',
    fetcher: (url, options) => fetch(new URL(String(url), base), options),
  });
  const decoder = {
    decode: async ({ envelope, artifacts }) => {
      const bytes = await artifacts.read(envelope.artifacts.body);
      return bytes.ok
        ? { ok: true, value: JSON.parse(new TextDecoder().decode(bytes.value)) }
        : bytes;
    },
  };
  try {
    const lease = registry.installDecoder(kind, decoder);
    assert.equal((await registry.load(guids[0], kind)).unwrap().cells.length, 2);
    lease.dispose();
    const rejected = await registry.load(guids[2], kind);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'asset-decoder-missing');
    const reloaded = registry.installDecoder(kind, decoder);
    assert.equal((await registry.load(guids[2], kind)).unwrap().cellSize, 1);
    reloaded.dispose();
    console.log(
      JSON.stringify({
        consumer: 'PASS',
        shapeCount: 2,
        mass: 2,
        providerColdLoad: true,
        decoderRevokeReload: true,
      }),
    );
  } finally {
    registry.dispose();
    physics.dispose();
    world.sharedRefs.release(handle).unwrap();
    await new Promise((done) => server.close(done));
  }
}
