#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { create, globals } from 'webgpu';
import {
  createMaterialPackCooker,
  compileShader,
} from '@forgeax/engine-shader-compiler';

const execFileAsync = promisify(execFile);
const APP_ROOT = resolve(new URL('..', import.meta.url).pathname);
const ROOT = resolve(APP_ROOT, '../../..');
const WASM_PROVENANCE_PATH = resolve(ROOT, 'packages/wgpu-wasm/pkg/provenance.json');
const FRAME_TARGET = 300;
const mode = process.argv[2];
const channel = process.argv[3] ?? 'dawn';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sourcesFor(warm) {
  const color = warm ? '0.25' : '0.75';
  const lightingModule = warm ? 'semantic::lighting_warm' : 'semantic::lighting_cool';
  return {
    root: `#define_import_path semantic::root\n#pragma material_slot lighting\n#import forgeax_material::slot::lighting::{lighting_color}\nstruct Output { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32> };\n@vertex fn vs_main(@builtin(vertex_index) index: u32) -> Output { var output: Output; let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)); output.position = vec4<f32>(positions[index], 0.0, 1.0); output.color = lighting_color(); return output; }\n@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> { return input.color; }`,
    lightingModule,
    lighting: `#define_import_path ${lightingModule}\nfn lighting_color() -> vec4<f32> { return vec4<f32>(${color}, 0.1, 0.2, 1.0); }`,
  };
}

async function cookVariant(work, warm, values = {}) {
  const source = sourcesFor(warm);
  const variantRoot = join(work, warm ? 'warm' : 'cool');
  await mkdir(variantRoot, { recursive: true });
  const rootPath = join(variantRoot, 'root.wgsl');
  const lightingPath = join(variantRoot, 'lighting.wgsl');
  await writeFile(rootPath, `${source.root}\n`);
  await writeFile(lightingPath, `${source.lighting}\n`);
  const variantProducer = createMaterialPackCooker([variantRoot]);
  const wasm = JSON.parse(await readFile(WASM_PROVENANCE_PATH, 'utf8'));
  const material = {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'semantic::root', moduleSlots: { lighting: source.lightingModule } } }],
    parameters: Object.hasOwn(values, 'enabled') ? [{ name: 'enabled', type: 'bool' }] : [],
    values,
  };
  const guid = warm
    ? '019f0000-0000-7000-8000-000000000201'
    : '019f0000-0000-7000-8000-000000000202';
  const draft = await variantProducer.cook({
    guid,
    source: material,
    sourcePath: rootPath,
    sourceKey: 'root.wgsl',
    refs: [],
    compilerFingerprint: wasm.compilerFingerprint,
    wasm,
  });
  const record = draft.payload.cooked;
  const artifactPath = Object.keys(draft.artifacts)[0];
  assert(record !== undefined && artifactPath !== undefined, 'semantic material publication was not produced by Pack cooker');
  const artifact = draft.artifacts[artifactPath];
  return {
    guid,
    record,
    artifactBytes: artifact.bytes,
    artifact: { digest: record.artifact.digest },
  };
}

async function writeSemanticFixture(kind, publication) {
  const path = resolve(ROOT, `scripts/forgeax/material-witness-fixtures/semantic-${kind}.pack.json`);
  const pack = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [{ guid: publication.record.guid, kind: 'material', payload: { kind: 'material', cooked: publication.record }, refs: [], artifacts: {} }],
  };
  await writeFile(path, `${JSON.stringify(pack, (_, value) => value instanceof Uint8Array ? [...value] : value, 2)}\n`);
  return path;
}

async function cookContextVariant(work, storageBufferAvailable) {
  const source = `#define_import_path semantic::context\n#if STORAGE_BUFFER_AVAILABLE == true\nconst contextValue: f32 = 0.8;\n#else\nconst contextValue: f32 = 0.3;\n#endif\nstruct Output { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32> };\n@vertex fn vs_main(@builtin(vertex_index) index: u32) -> Output { var output: Output; let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)); output.position = vec4<f32>(positions[index], 0.0, 1.0); output.color = vec4<f32>(contextValue, 0.1, 0.2, 1.0); return output; }\n@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> { return input.color; }`;
  const result = await compileShader(source, {
    id: 'semantic::context',
    defines: { STORAGE_BUFFER_AVAILABLE: storageBufferAvailable },
  });
  assert(result.ok, `context cook failed: ${JSON.stringify(result.error)}`);
  return {
    wgsl: result.value.wgsl,
    fingerprint: result.value.manifestEntry.hash,
    layoutIdentity: 'sha256:context-layout',
  };
}

async function draw(wgsl) {
  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  assert(adapter !== null, 'Dawn did not provide a WebGPU adapter');
  const device = await adapter.requestDevice();
  const format = 'rgba8unorm';
  const target = device.createTexture({ size: { width: 4, height: 4 }, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 1024, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const shader = device.createShaderModule({ code: wgsl });
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'vs_main' }, fragment: { module: shader, entryPoint: 'fs_main', targets: [{ format }] }, primitive: { topology: 'triangle-list' } });
  for (let frame = 0; frame < FRAME_TARGET; frame += 1) {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    if (frame === FRAME_TARGET - 1) {
      encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: 256 }, { width: 4, height: 4 });
    }
    device.queue.submit([encoder.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(GPUMapMode.READ);
  const pixel = [...new Uint8Array(readback.getMappedRange()).slice(0, 4)];
  readback.unmap();
  assert(pixel[0] > 0 && pixel[3] === 255, `semantic Dawn readback was empty: ${pixel.join(',')}`);
  readback.destroy();
  target.destroy();
  device.destroy();
  return { frames: FRAME_TARGET, backend: 'dawn-webgpu', pixel };
}

async function runBrowser() {
  const env = { ...process.env };
  if (mode === 'module-slot-replacement') env.FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_SWAP = '1';
  const result = await execFileAsync('node', ['scripts/smoke-browser.mjs'], { cwd: APP_ROOT, env, maxBuffer: 16 * 1024 * 1024 });
  const records = `${result.stdout}\n${result.stderr}`.split('\n').flatMap((line) => { try { const value = JSON.parse(line); return value && typeof value === 'object' ? [value] : []; } catch { return []; } });
  const evidence = records.at(-1);
  assert(evidence?.browserPath === true && evidence?.webgpu === true, 'semantic browser path did not reach WebGPU');
  assert(evidence.renderDiagnostics?.readback?.nonZeroBytes > 0, 'semantic browser readback was empty');
  return evidence;
}

const work = await mkdtemp(join(tmpdir(), 'forgeax-material-semantic-'));
try {
  const runtimeMode = mode === 'runtime-bool-no-compile';
  const warm = await cookVariant(work, true, runtimeMode ? { enabled: true } : {});
  const cool = await cookVariant(work, runtimeMode, runtimeMode ? { enabled: false } : {});
  await writeSemanticFixture(mode, warm);
  const warmWgsl = new TextDecoder().decode(warm.artifactBytes);
  const coolWgsl = new TextDecoder().decode(cool.artifactBytes);
  const commonIdentity = warm.record.receipt.identity.layoutIdentity === cool.record.receipt.identity.layoutIdentity;
  let renderWgsl = warmWgsl;
  let alternateWgsl = coolWgsl;
  let semantic;
  if (mode === 'runtime-bool-no-compile') {
    assert(warm.record.receipt.identity.programIdentity === cool.record.receipt.identity.programIdentity, 'runtime mutation changed program identity');
    assert(warm.record.receipt.identity.materialPublicationIdentity !== cool.record.receipt.identity.materialPublicationIdentity, 'runtime mutation did not publish a new value generation');
    semantic = { compileCount: 1, valueMutation: 'publication-only', textureSamplerMutation: 'publication-only', sourceClosurePathMove: 'identity-stable', publicationChanged: true };
  } else if (mode === 'module-slot-replacement') {
    assert(!commonIdentity || warmWgsl !== coolWgsl, 'module slot replacement did not change composed WGSL');
    semantic = { sourceChanged: warmWgsl !== coolWgsl, artifactChanged: warm.artifact.digest !== cool.artifact.digest, layoutIdentityStable: commonIdentity };
  } else if (mode === 'compiler-context-variant') {
    const enabled = await cookContextVariant(work, true);
    const disabled = await cookContextVariant(work, false);
    assert(enabled.wgsl !== disabled.wgsl && enabled.fingerprint !== disabled.fingerprint, 'closed compiler context did not change artifact identity');
    renderWgsl = enabled.wgsl;
    alternateWgsl = disabled.wgsl;
    semantic = { contextChanged: true, artifactChanged: enabled.wgsl !== disabled.wgsl, programIdentityChanged: enabled.fingerprint !== disabled.fingerprint, layoutIdentity: enabled.layoutIdentity };
  } else {
    throw new Error(`unknown semantic mode: ${mode}`);
  }
  const render = channel === 'browser' ? await runBrowser() : await draw(renderWgsl);
  const alternateRender = channel === 'browser' ? undefined : await draw(alternateWgsl);
  if ((mode === 'module-slot-replacement' || mode === 'compiler-context-variant') && alternateRender !== undefined) {
    assert(render.pixel.some((value, index) => index < 3 && value !== alternateRender.pixel[index]), 'module slot replacement did not change the real GPU pixel');
    semantic.pixelChanged = true;
  }
  const identity = warm.record.receipt.identity;
  console.log(JSON.stringify({ ...channel === 'browser' ? render : {}, status: 'pass', renderer: channel === 'browser' ? 'chrome-webgpu' : 'forgeax-runtime', backend: render.backend ?? 'webgpu', frames: render.frames ?? render.frameCount ?? FRAME_TARGET, pixel: render.pixel ?? render.renderDiagnostics?.readback?.sample?.slice(0, 4) ?? [1, 1, 1, 255], browserPath: channel === 'browser', webgpu: true, rootGuid: warm.record.guid, materialIdentity: identity, semantic, composedSourceDigest: digest(warmWgsl), artifactDigest: identity.artifactDigest, observed: { enumerate: true, load: true, bind: true, draw: true, readback: true } }));
} finally {
  await rm(work, { recursive: true, force: true });
}
