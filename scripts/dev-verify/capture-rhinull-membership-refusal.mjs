#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argument = (name, fallback) =>
  process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;

const manifestPath = argument('--manifest');
const outputRootArgument = argument('--output-root');
if (manifestPath === undefined || outputRootArgument === undefined)
  throw new Error(
    'usage: capture-rhinull-membership-refusal.mjs --manifest=<manifest.json> --output-root=<dir>',
  );

const outputRoot = resolve(outputRootArgument);
const attemptId = 'rhinull-gpu-refused';
const sourceHead =
  process.env.FORGEAX_SOURCE_HEAD ??
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));

const { World } = await import('@forgeax/engine-ecs');
const { Camera, DirectionalLight } = await import('@forgeax/engine-render');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { rhi } = await import('@forgeax/engine-rhi-null');
const { Transform } = await import('@forgeax/engine-scene');
const { writeMembershipEvidence } = await import(
  '../../apps/learn-render/5.advanced-lighting/8.deferred-shading/scripts/membership-evidence.mjs'
);

if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { gpu: undefined },
  });
}

const canvas = {
  width: 512,
  height: 512,
  getContext() {
    return null;
  },
  addEventListener() {},
  removeEventListener() {},
};
const shaderManifest = {
  schemaVersion: '1.0.0',
  entries: [
    { hash: 'pbr00000', wgsl: '/* pbr stub */', glsl: '', bindings: '' },
    { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
    { hash: 'tonemap0', wgsl: '/* tonemap stub */', glsl: '', bindings: '' },
  ],
};
const shaderManifestUrl = `data:application/json,${encodeURIComponent(JSON.stringify(shaderManifest))}`;
const renderer = await createRenderer(
  canvas,
  {
    rhi,
    membershipTiming: { mode: 'gpu' },
  },
  { shaderManifestUrl },
);
try {
  const ready = await renderer.ready;
  if (!ready.ok) throw new Error(`RhiNull renderer.ready failed: ${ready.error.code}`);
  const controller = renderer.membershipTiming;
  if (controller === undefined) throw new Error('RhiNull membership timing controller is missing');
  const started = controller.start();
  if (started.ok || started.error.code !== 'timestamp-query-unsupported')
    throw new Error(`RhiNull did not refuse timestamp timing: ${JSON.stringify(started)}`);

  const world = new World();
  world.spawn(
    { component: Transform, data: {} },
    { component: Camera, data: { fov: 60, near: 0.1, far: 1000 } },
  );
  world.spawn(
    { component: Transform, data: {} },
    { component: DirectionalLight, data: { direction: [0, -1, 0] } },
  );
  let frames = 0;
  for (; frames < 300; frames += 1) {
    const drawn = renderer.draw([world], { owner: 0 });
    if (!drawn.ok) throw new Error(`RhiNull frame ${frames + 1} failed: ${drawn.error.code}`);
  }

  const record = writeMembershipEvidence({
    outputDir: join(outputRoot, attemptId),
    artifactRoot: outputRoot,
    manifest,
    recordKind: 'attempt',
    attemptId,
    mode: 'gpu',
    sourceHead,
    command: process.argv,
    actualProducer: 'cpu',
    timing: { code: started.error.code, detail: started.error.hint },
    evidence: {
      backendKind: renderer.device.caps.backendKind,
      compute: renderer.device.caps.compute,
      timestampQuery: renderer.device.caps.timestampQuery,
      timestampPeriodNanoseconds: renderer.device.caps.timestampPeriodNanoseconds ?? null,
      adapter: 'rhi-null',
      environment: 'node-rhi-null',
      actualProducer: 'cpu',
    },
    membership: null,
    pixels: null,
    lights: 128,
    frames,
  });
  process.stdout.write(
    `[membership] RhiNull refusal record=${join(outputRoot, attemptId, 'record.json')} frames=${frames} code=${record.record.reason?.code}\n`,
  );
} finally {
  renderer.dispose();
}
