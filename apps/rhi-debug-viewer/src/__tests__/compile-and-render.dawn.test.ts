// compile-and-render.dawn.test.ts -- GPU proof of the shader-edit depth self-occlusion.
//
// Reproduces the exact sequence the Apply path runs (CodeMirrorShader ->
// compileAndRenderShader): a draw is committed (its depth written), then the SAME
// draw is re-issued with depthLoadOp:'load' against the depth it just wrote. Under
// the recorded STRICT compare ('less') the z==z fragment is discarded and the
// preview never changes -- the bug. Under the relaxed compare ('less-equal',
// produced by relaxDepthCompare) the re-draw passes and the new shader's color
// shows. The reverse-Z arm ('greater' -> 'greater-equal') mirrors it.
//
// This is the falsifiable witness for the fix in compile-and-render.ts: the
// strict-compare arm asserts the symptom (color unchanged) and the relaxed arm
// asserts the cure (color changed) on the same GPU device.

/// <reference types="@webgpu/types" />

// biome-ignore-all lint/suspicious/noExplicitAny: dawn-node mechanism test constructs RHI mock surfaces (opaque GPU device/buffer/texture brands, WebGPU descriptor shapes) that require any casts at the test boundary.

import type { RhiDevice, RhiInstance } from '@forgeax/engine-rhi';
import { readbackTexturePixels } from '@forgeax/engine-rhi-debug';
import { describe, expect, it } from 'vitest';
import { relaxDepthCompare } from '../compile-and-render';

interface DawnPack {
  readonly rhi: RhiInstance;
  readonly createShaderModule: (
    device: RhiDevice,
    desc: { code: string },
  ) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string } }>;
}

async function loadDawnRhi(): Promise<DawnPack | undefined> {
  try {
    return (await import('@forgeax/engine-rhi-webgpu')) as unknown as DawnPack;
  } catch {
    return undefined;
  }
}

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';
const W = 16;
const H = 16;

// Fullscreen triangle at a fixed clip-space depth z=0.5 (so it writes depth 0.5
// into the depth buffer; a re-draw then tests 0.5 <cmp> 0.5).
const VS = /* wgsl */ `
@vertex
fn main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0), vec2(-1.0,  3.0), vec2( 3.0, -1.0),
  );
  return vec4(pos[vi], 0.5, 1.0);
}`;
const fsColor = (r: number, g: number, b: number) => /* wgsl */ `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4(${r.toFixed(1)}, ${g.toFixed(1)}, ${b.toFixed(1)}, 1.0);
}`;

async function makeDevice(pack: DawnPack): Promise<RhiDevice> {
  const a = await pack.rhi.requestAdapter();
  if (!a.ok) throw new Error('adapter');
  const d = await a.value.requestDevice();
  if (!d.ok) throw new Error('device');
  return d.value;
}

function rt(device: RhiDevice) {
  const res = device.createTexture({
    size: { width: W, height: H, depthOrArrayLayers: 1 },
    format: 'rgba8unorm' as GPUTextureFormat,
    usage: 0x11, // COPY_SRC | RENDER_ATTACHMENT
  });
  if (!res.ok) throw new Error(`color tex: ${res.error.code}`);
  return res.value;
}

function depthRt(device: RhiDevice) {
  const res = device.createTexture({
    size: { width: W, height: H, depthOrArrayLayers: 1 },
    format: 'depth24plus' as GPUTextureFormat,
    usage: 0x10, // RENDER_ATTACHMENT
  });
  if (!res.ok) throw new Error(`depth tex: ${res.error.code}`);
  return res.value;
}

/**
 * Run the bug's exact GPU sequence on one device with a given depthCompare.
 * Returns the center pixel RGB after: (1) commit a red draw [depthLoadOp clear],
 * then (2) re-issue a green draw [depthLoadOp load] under `compare`.
 */
async function runReissue(
  pack: DawnPack,
  compare: GPUCompareFunction,
): Promise<[number, number, number]> {
  const device = await makeDevice(pack);
  const color = rt(device);
  const depth = depthRt(device);
  const colorViewR = device.createTextureView(color, {});
  const depthViewR = device.createTextureView(depth, {});
  if (!colorViewR.ok || !depthViewR.ok) throw new Error('views');
  const colorView = colorViewR.value;
  const depthView = depthViewR.value;

  const vs = await pack.createShaderModule(device, { code: VS });
  const fsRed = await pack.createShaderModule(device, { code: fsColor(1, 0, 0) });
  const fsGreen = await pack.createShaderModule(device, { code: fsColor(0, 1, 0) });
  if (!vs.ok || !fsRed.ok || !fsGreen.ok) throw new Error('shaders');

  const bgl = device.createBindGroupLayout({ entries: [] });
  if (!bgl.ok) throw new Error('bgl');
  const pl = device.createPipelineLayout({ bindGroupLayouts: [bgl.value] });
  if (!pl.ok) throw new Error('pl');

  const mkPipe = (fsMod: unknown, cmp: GPUCompareFunction) =>
    device.createRenderPipeline({
      layout: pl.value,
      vertex: { module: vs.value, entryPoint: 'main', buffers: [] },
      fragment: { module: fsMod, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: cmp },
    } as any);

  // Original pipeline always uses the strict recorded compare ('less'/'greater').
  const recorded: GPUCompareFunction = compare === 'less-equal' ? 'less' : 'greater';
  const depthClear = recorded === 'less' ? 1.0 : 0.0;

  // (1) Commit: clear color+depth, draw red. Writes depth 0.5 (the draw's own depth).
  const pRed = mkPipe(fsRed.value, recorded);
  if (!pRed.ok) throw new Error(`pRed: ${pRed.error.code}`);
  {
    const enc = device.createCommandEncoder({});
    if (!enc.ok) throw new Error('enc1');
    const pass = enc.value.beginRenderPass({
      colorAttachments: [
        {
          view: colorView as any,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthView as any,
        depthClearValue: depthClear,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    } as any);
    pass.setPipeline(pRed.value as any);
    pass.draw(3, 1, 0, 0);
    pass.end();
    const fin = enc.value.finish();
    if (!fin.ok) throw new Error('fin1');
    device.queue.submit([fin.value] as unknown as readonly never[]);
    await device.queue.onSubmittedWorkDone();
  }

  // (2) Re-issue: depthLoadOp 'load' (depth still holds 0.5), draw green under `compare`.
  const pGreen = mkPipe(fsGreen.value, compare);
  if (!pGreen.ok) throw new Error(`pGreen: ${pGreen.error.code}`);
  {
    const enc = device.createCommandEncoder({});
    if (!enc.ok) throw new Error('enc2');
    const pass = enc.value.beginRenderPass({
      colorAttachments: [{ view: colorView as any, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: depthView as any,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    } as any);
    pass.setPipeline(pGreen.value as any);
    pass.draw(3, 1, 0, 0);
    pass.end();
    const fin = enc.value.finish();
    if (!fin.ok) throw new Error('fin2');
    device.queue.submit([fin.value] as unknown as readonly never[]);
    await device.queue.onSubmittedWorkDone();
  }

  const px = await readbackTexturePixels(device, color, W, H);
  const center = ((H / 2) * W + W / 2) * 4;
  return [px[center] ?? 0, px[center + 1] ?? 0, px[center + 2] ?? 0];
}

describe.skipIf(SKIP_DAWN)('compile-and-render depth self-occlusion (forward + reverse-Z)', () => {
  it('STRICT less: re-issued draw is occluded by its own committed depth (the bug)', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;
    const [r, g, b] = await runReissue(pack, 'less');
    // Bug witness: green re-draw discarded -> pixel stays the original red.
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(40);
    expect(b).toBeLessThan(40);
  }, 60_000);

  it('RELAXED less-equal: re-issued draw passes -> new color shows (the fix)', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;
    expect(relaxDepthCompare('less')).toBe('less-equal');
    const [r, g, b] = await runReissue(pack, 'less-equal');
    // Fix witness: green re-draw passes -> pixel is now green.
    expect(g).toBeGreaterThan(200);
    expect(r).toBeLessThan(40);
    expect(b).toBeLessThan(40);
  }, 60_000);

  it('STRICT greater (reverse-Z): re-issued draw is occluded (the bug)', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;
    const [r, g, b] = await runReissue(pack, 'greater');
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(40);
    expect(b).toBeLessThan(40);
  }, 60_000);

  it('RELAXED greater-equal (reverse-Z): re-issued draw passes (the fix)', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;
    expect(relaxDepthCompare('greater')).toBe('greater-equal');
    const [r, g, b] = await runReissue(pack, 'greater-equal');
    expect(g).toBeGreaterThan(200);
    expect(r).toBeLessThan(40);
    expect(b).toBeLessThan(40);
  }, 60_000);
});
