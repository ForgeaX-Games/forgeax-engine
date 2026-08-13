#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';
import {
  collectRhiDebugDraws,
  runRhiDebugBrowserAdmission,
} from '../../../shared/scripts/rhi-debug-browser-admission.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(scriptsDir);
const root = resolve(scriptsDir, '..', '..', '..', '..');
const packageName = '@forgeax/bevy-text2d';

if (process.env.TEXT2D_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: packageName,
    label: 'bevy text2d public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareText2dCapture',
    appDir,
    assertTape: ({ tape }) => assertTextTape({ events: tape.events, blobPool: tape.blobPool }),
  });
} else {
  const publicExit = await runPublicCaptureFrame();
  if (publicExit !== 0) process.exit(publicExit);
  await runRhiDebugBrowserAdmission({
    pkg: packageName,
    label: 'bevy text2d',
    readyHook: '__bevyText2dReady',
    capturePrepareHook: '__prepareText2dCapture',
    screenshotPath: resolve(appDir, 'artifacts', 'text2d-rhi-debug.png'),
    triggerLabel: 'text2d-public-trigger',
    assertTape: ({ events, blobPool }) => assertTextTape({ events, blobPool }),
    formatCapture: ({ capture, selected, inspected }) =>
      `${capture.runId ?? 'remote'} glyphDraws=${selected.glyphDraws} drawOrdinal=${selected.drawOrdinal} ` +
      `indexCount=${inspected.drawCall.indexCount} bindings=${inspected.bindings.length} ` +
      `atlas=${selected.fontAtlasTexture} sampler=${selected.fontAtlasSampler}`,
  });
}

function runPublicCaptureFrame() {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      env: { ...process.env, TEXT2D_PUBLIC: '1' },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

function assertTextTape({ events, blobPool }) {
  const { draws, groups, layouts, initialData } = collectRhiDebugDraws(events);
  const textures = new Map(events.filter((event) => event.kind === 'createTexture').map((event) => [event.handleId, event]));
  const textureViews = new Map(events.filter((event) => event.kind === 'createTextureView').map((event) => [event.resultHandleId, event]));
  const samplers = new Map(events.filter((event) => event.kind === 'createSampler').map((event) => [event.handleId, event]));
  const shaderModules = events.filter((event) => event.kind === 'createShaderModule');
  const msdfShaders = shaderModules.filter(
    (event) =>
      typeof event.wgslCode === 'string' &&
      event.wgslCode.includes('screen_px_range') &&
      event.wgslCode.includes('median') &&
      event.wgslCode.includes('baseColorTexture'),
  );
  if (msdfShaders.length !== 1) throw new Error(`expected one captured MSDF text shader, got ${msdfShaders.length}`);
  const indexed = draws.filter(({ event }) => event.kind === 'drawIndexed');
  const glyphDraws = indexed.filter(
    (draw) =>
      draw.pass?.colorAttachmentViewHandleIds?.length === 1 &&
      typeof draw.pass.depthStencilViewHandleId === 'string' &&
      draw.vertexBuffer !== undefined &&
      draw.indexBuffer !== undefined &&
      hasGlyphPipeline(draw.pipeline) &&
      hasFontAtlasBinding(draw, groups, layouts, textures, textureViews, initialData, samplers, blobPool),
  );
  if (glyphDraws.length !== 4) {
    throw new Error(`expected four semantically selected GlyphText draws, got ${glyphDraws.length} of ${indexed.length} indexed draws`);
  }
  for (const draw of glyphDraws) {
    if (draw.event.indexCount <= 0 || draw.event.instanceCount <= 0) {
      throw new Error(`selected GlyphText draw is not non-empty: ${JSON.stringify(draw.event)}`);
    }
    assertNonEmptyBuffer(draw.vertexBuffer.bufferHandleId, initialData, blobPool, 'vertex');
    assertNonEmptyBuffer(draw.indexBuffer.bufferHandleId, initialData, blobPool, 'index');
  }
  const selected = glyphDraws[0];
  const materialSet = selected.bindGroups.get(1);
  const materialGroup = materialSet === undefined ? undefined : groups.get(materialSet.bindGroupHandleId);
  if (materialGroup === undefined) throw new Error('selected GlyphText draw has no material bind group');
  const materialLayout = layouts.get(materialGroup.layoutHandleId);
  if (materialLayout?.desc?.label !== 'pbr-material-skylight-bgl') {
    throw new Error(`selected GlyphText draw has unexpected material layout: ${materialLayout?.desc?.label ?? 'missing'}`);
  }
  const atlas = resourceAt(materialGroup, 2);
  const atlasTextureView = atlas?.resourceKind === 'textureView' ? textureViews.get(atlas.resourceHandleId) : undefined;
  const atlasTexture = atlasTextureView === undefined ? undefined : textures.get(atlasTextureView.sourceHandleId);
  const atlasSampler = resourceAt(materialGroup, 1);
  const sampler = atlasSampler?.resourceKind === 'sampler' ? samplers.get(atlasSampler.resourceHandleId) : undefined;
  if (atlasTexture === undefined || atlasTexture.desc?.size?.width !== 512 || atlasTexture.desc?.size?.height !== 512 || atlasTexture.desc?.format !== 'rgba8unorm') {
    throw new Error(`selected GlyphText draw has no 512x512 rgba8unorm font atlas: ${JSON.stringify(atlasTexture?.desc)}`);
  }
  if (sampler === undefined) throw new Error('selected GlyphText draw has no font atlas sampler');
  assertNonEmptyBuffer(atlasTexture.handleId, initialData, blobPool, 'font atlas texture');
  const drawOrdinal = draws.indexOf(selected);
  const fontAtlasTexture = atlasTexture.handleId;
  const fontAtlasSampler = sampler.handleId;
  console.log(
    `[bevy text2d] semantic selector glyphDraws=${glyphDraws.length} indexCounts=${glyphDraws.map(({ event }) => event.indexCount).join(',')} ` +
      `atlas=${fontAtlasTexture} sampler=${fontAtlasSampler} drawOrdinal=${drawOrdinal}`,
  );
  return { drawOrdinal, glyphDraws: glyphDraws.length, fontAtlasTexture, fontAtlasSampler };
}

function hasGlyphPipeline(pipeline) {
  const attributes = pipeline?.desc?.vertex?.buffers?.flatMap((buffer) => buffer.attributes ?? []) ?? [];
  const byLocation = new Map(attributes.map((attribute) => [attribute.shaderLocation, attribute.format]));
  return (
    byLocation.get(0) === 'float32x3' &&
    byLocation.get(1) === 'float32x3' &&
    byLocation.get(2) === 'float32x2' &&
    byLocation.get(3) === 'float32x4' &&
    pipeline?.desc?.primitive?.cullMode === 'none' &&
    pipeline?.desc?.depthStencil?.format === 'depth24plus-stencil8' &&
    pipeline?.desc?.fragment?.targets?.length === 1 &&
    pipeline.desc.fragment.targets[0]?.format === 'rgba16float'
  );
}

function hasFontAtlasBinding(draw, groups, layouts, textures, textureViews, initialData, samplers, blobPool) {
  const materialSet = draw.bindGroups.get(1);
  const materialGroup = materialSet === undefined ? undefined : groups.get(materialSet.bindGroupHandleId);
  if (materialGroup === undefined || layouts.get(materialGroup.layoutHandleId)?.desc?.label !== 'pbr-material-skylight-bgl') return false;
  const sampler = resourceAt(materialGroup, 1);
  const texture = resourceAt(materialGroup, 2);
  if (sampler?.resourceKind !== 'sampler' || texture?.resourceKind !== 'textureView') return false;
  const samplerEvent = samplers.get(sampler.resourceHandleId);
  const textureViewEvent = textureViews.get(texture.resourceHandleId);
  const textureEvent = textureViewEvent === undefined ? undefined : textures.get(textureViewEvent.sourceHandleId);
  if (samplerEvent === undefined || textureEvent === undefined) return false;
  if (textureEvent.desc?.size?.width !== 512 || textureEvent.desc?.size?.height !== 512 || textureEvent.desc?.format !== 'rgba8unorm') return false;
  const seed = initialData.get(textureEvent.handleId);
  const bytes = seed === undefined ? undefined : blobPool.get(seed.dataHash);
  const view = bytes === undefined ? undefined : asBytes(bytes);
  return view !== undefined && view.byteLength > 0 && view.some((value) => value !== 0);
}

function resourceAt(group, binding) {
  const index = group.entries.findIndex((entry) => entry.binding === binding);
  if (index < 0) return undefined;
  const entry = group.entries[index];
  const resourceHandleId = group.resourceHandleIds[index];
  return resourceHandleId === undefined ? undefined : { ...entry, resourceHandleId };
}

function assertNonEmptyBuffer(handleId, initialData, blobPool, label) {
  const seed = initialData.get(handleId);
  const blob = seed === undefined ? undefined : blobPool.get(seed.dataHash);
  const bytes = blob === undefined ? undefined : asBytes(blob);
  if (bytes === undefined || bytes.byteLength === 0 || !bytes.some((value) => value !== 0)) {
    throw new Error(`selected GlyphText ${label} has no non-zero captured data`);
  }
}

function asBytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
