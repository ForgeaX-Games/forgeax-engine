/**
 * Offline inspect-at dawn e2e (M4 / w20 + w21).
 *
 * Proves AC-09: the new offline CLI entry (runOfflineInspectAt in cli.ts)
 * reads an on-disk L1 tape (frame-0.tape.bin + frame-0.report.json), boots a
 * fresh dawn-node device, replays to the requested drawIdx, and emits a
 * structured InspectReport JSON + an RT PNG. The PNG is the only image
 * artefact and is verified by the machine contract `PNG.sync.read(...)`
 * not throwing (plan-strategy §5.4: visualEvidence.enabled=false, no
 * Read(image)).
 *
 * w20 parity: record a real RHI frame, spill it to a tmp .forgeax-debug dir
 * exactly the way the Node finalize() / HTTP endpoint tail does (assembleReport
 * + fs writeFileSync), then call the offline inspect entry and assert the
 * returned report parses with `bindings` + `drawCall` and the RT PNG decodes.
 *
 * w21 falsification: XOR the writeBuffer/writeTexture blob-pool payload bytes
 * before spilling to disk, run the offline inspect on that mutated tape, and
 * assert the RT PNG bytes differ from the clean frame's PNG (the inspect path
 * is content-sensitive). Gated behind FORGEAX_FALSIFY=1 so it does not run in
 * the CI-resident dawn project.
 */

/// <reference types="@webgpu/types" />

// biome-ignore-all lint/suspicious/noExplicitAny: dawn-node e2e constructs RHI mock surfaces (GPU device/buffer brands, WebGPU descriptor types) whose structural shapes require any casts at the test boundary; dawn-node opaque GPU types cannot be imported at the type level

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RhiDevice, RhiInstance } from '@forgeax/engine-rhi';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { runOfflineInspectAt } from '../cli';
import { type CreateShaderModuleFn, wrap, wrapCreateShaderModule } from '../recorder';
import { assembleReport } from '../recorder-core';
import { createReplay } from '../replayer';
import { deserializeTape, serializeTape } from '../tape-format';
import type { Tape } from '../types';

// ============================================================================
// dawn-node RHI bootstrap (mirrors e2e.dawn.test.ts:loadDawnRhi)
// ============================================================================

interface DawnPack {
  readonly rhi: RhiInstance;
  readonly createShaderModule: CreateShaderModuleFn;
}

async function loadDawnRhi(): Promise<DawnPack | undefined> {
  try {
    return (await import('@forgeax/engine-rhi-webgpu')) as unknown as DawnPack;
  } catch {
    return undefined;
  }
}

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';
const RUN_FALSIFY = process.env.FORGEAX_FALSIFY === '1';

const RT_WIDTH = 64;
const RT_HEIGHT = 64;

const VBO_VS = /* wgsl */ `
@vertex
fn main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return vec4(position * 0.8, 1.0);
}`;

const FS = /* wgsl */ `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4(1.0, 0.0, 0.0, 1.0);
}`;

interface RecordedTape {
  readonly json: string;
  readonly blob: Uint8Array;
}

/**
 * Record one VBO drawIndexed frame with the recorder proxy and return the
 * serialized tape (json + blob), the same bytes the Node finalize() tail
 * spills to disk.
 */
async function recordVboFrame(pack: DawnPack): Promise<RecordedTape> {
  const debugInst = wrap(pack.rhi);
  const wrappedCreateShader = wrapCreateShaderModule(pack.createShaderModule, debugInst);
  const adapterRes = await debugInst.requestAdapter();
  if (!adapterRes.ok) throw new Error('adapter');
  const devRes = await adapterRes.value.requestDevice();
  if (!devRes.ok) throw new Error('device');
  const wrappedDevice = devRes.value;
  const rawDevice: RhiDevice = (wrappedDevice as any)._realDevice;

  const armRes = debugInst.arm(1);
  if (!armRes.ok) throw new Error('arm');

  const texRes = wrappedDevice.createTexture({
    size: { width: RT_WIDTH, height: RT_HEIGHT, depthOrArrayLayers: 1 },
    format: 'rgba8unorm' as GPUTextureFormat,
    usage: 0x11,
  });
  if (!texRes.ok) throw new Error('tex');
  const viewRes = wrappedDevice.createTextureView(texRes.value, {});
  if (!viewRes.ok) throw new Error('view');

  const vs = await wrappedCreateShader(rawDevice, { code: VBO_VS });
  if (!vs.ok) throw new Error('vs');
  const fs = await wrappedCreateShader(rawDevice, { code: FS });
  if (!fs.ok) throw new Error('fs');

  const verts = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const inds = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const vboRes = wrappedDevice.createBuffer({ size: verts.byteLength, usage: 0x28 });
  if (!vboRes.ok) throw new Error('vbo');
  wrappedDevice.queue.writeBuffer(vboRes.value as any, 0, verts.buffer);
  const iboRes = wrappedDevice.createBuffer({ size: inds.byteLength, usage: 0x18 });
  if (!iboRes.ok) throw new Error('ibo');
  wrappedDevice.queue.writeBuffer(iboRes.value as any, 0, inds.buffer);

  const bglRes = wrappedDevice.createBindGroupLayout({ entries: [] });
  if (!bglRes.ok) throw new Error('bgl');
  const plRes = wrappedDevice.createPipelineLayout({ bindGroupLayouts: [bglRes.value] });
  if (!plRes.ok) throw new Error('pl');
  const pipeRes = wrappedDevice.createRenderPipeline({
    layout: plRes.value,
    vertex: {
      module: vs.value,
      entryPoint: 'main',
      buffers: [
        { arrayStride: 12, attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }] },
      ],
    },
    fragment: { module: fs.value, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  } as any);
  if (!pipeRes.ok) throw new Error('pipeline');

  const encRes = wrappedDevice.createCommandEncoder({});
  if (!encRes.ok) throw new Error('enc');
  const enc = encRes.value;
  const pass = enc.beginRenderPass({
    colorAttachments: [
      {
        view: viewRes.value as any,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  } as any);
  pass.setPipeline(pipeRes.value as any);
  pass.setVertexBuffer(0, vboRes.value as any, 0, verts.byteLength);
  pass.setIndexBuffer(iboRes.value as any, 'uint16', 0, inds.byteLength);
  pass.drawIndexed(6, 1, 0, 0, 0);
  pass.end();
  const fin = enc.finish();
  if (!fin.ok) throw new Error('finish');
  wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
  await wrappedDevice.queue.onSubmittedWorkDone();

  debugInst.onFrameEnd();
  const tape = debugInst.getTape() as any;
  if (!tape) throw new Error('tape');
  const { json, blob } = serializeTape(tape);
  return { json, blob };
}

/**
 * Spill a serialized tape to a fresh tmp `.forgeax-debug/<runId>/` directory in
 * the exact two-file L1 schema the Node finalize() tail + HTTP endpoint write:
 *   frame-0.tape.bin   -> raw blob pool bytes
 *   frame-0.report.json -> assembleReport({ json, passOffsets, valid })
 * Returns the tape path (the offline inspect entry's first argument).
 */
function spillToDisk(rec: RecordedTape): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-offline-inspect-'));
  const report = assembleReport({ json: rec.json, passOffsets: [], valid: true });
  const tapePath = join(dir, 'frame-0.tape.bin');
  const reportPath = join(dir, 'frame-0.report.json');
  writeFileSync(tapePath, Buffer.from(rec.blob));
  writeFileSync(reportPath, JSON.stringify(report));
  return tapePath;
}

describe.skipIf(SKIP_DAWN)('offline inspect-at dawn e2e -- AC-09 JSON + PNG (m4 / w20)', () => {
  it('reads L1 tape from disk, replays, emits InspectReport JSON + decodable RT PNG', async () => {
    const pack = await loadDawnRhi();
    if (!pack) throw new Error('dawn-node RHI unavailable (FORGEAX_SKIP_DAWN not set)');

    const rec = await recordVboFrame(pack);
    const tapePath = spillToDisk(rec);

    const result = await runOfflineInspectAt({
      tapePath,
      drawIdx: 0,
      fields: undefined,
      device: undefined,
      createShaderModule: undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // (4) report JSON parses + carries bindings + drawCall.
    const report = result.value.report;
    expect(typeof report).toBe('object');
    expect('bindings' in report).toBe(true);
    expect('drawCall' in report).toBe(true);
    expect(Array.isArray(report.bindings)).toBe(true);
    expect(typeof report.drawCall).toBe('object');

    // (5) RT PNG path exists + decodes via pngjs without throwing.
    expect(typeof report.rt).toBe('string');
    const pngPath = report.rt as string;
    const decoded = PNG.sync.read(readFileSync(pngPath));
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);

    // (6) The RT must carry the *rendered* pixels, not an all-zero buffer.
    // VBO_VS + FS draw a red quad (vec4(1,0,0,1)) over a black-with-alpha=1
    // clear, so a faithful readback has: alpha=255 everywhere (the clear) and a
    // band of red pixels (the quad). An all-zero readback (the pre-fix
    // mapAsync(mode=2=WRITE) / Result-not-unwrapped bug) would fail both checks
    // -- this is the regression guard for that empty-frame-falsely-passes trap.
    const px = decoded.data;
    let alphaMax = 0;
    let redPixels = 0;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3] ?? 0;
      if (a > alphaMax) alphaMax = a;
      if ((px[i] ?? 0) > 200 && (px[i + 1] ?? 0) < 64 && (px[i + 2] ?? 0) < 64) redPixels++;
    }
    expect(alphaMax).toBe(255);
    expect(redPixels).toBeGreaterThan(0);
  }, 60_000);

  // w21 falsification (AC-09 SSOT arbitration, plan-strategy §5.4 NOTE).
  //
  // Originally this falsifier was DOWNGRADED to a structural-only contract on
  // the belief that "a direct readbackTexturePixels of a freshly rendered
  // dawn-node texture returns an all-zero buffer (even clearValue alpha=1.0
  // reads back as 0)". That was NOT a dawn-node limitation -- it was the
  // readback.ts bug (mapAsync called with mode=2=GPUMapMode.WRITE instead of
  // READ=0x1, and getMappedRange's Result wrapper fed straight into
  // `new Uint8Array(...)` yielding length 0). With that fixed, dawn-node
  // readback faithfully returns the rendered pixels, so the pixel-divergent
  // falsifier is achievable again and asserted here directly: XOR-corrupting
  // the VBO payload moves/destroys the red quad, so the mutated frame's red
  // pixel count diverges from the clean frame's. Gated behind FORGEAX_FALSIFY=1
  // -- not CI-resident.
  it.skipIf(!RUN_FALSIFY)(
    'falsification: XOR-mutated VBO yields a pixel-divergent RT (readback is faithful)',
    async () => {
      const pack = await loadDawnRhi();
      if (!pack) throw new Error('dawn-node RHI unavailable');

      const countRed = (pngPath: string): number => {
        const px = PNG.sync.read(readFileSync(pngPath)).data;
        let red = 0;
        for (let i = 0; i < px.length; i += 4) {
          if ((px[i] ?? 0) > 200 && (px[i + 1] ?? 0) < 64 && (px[i + 2] ?? 0) < 64) red++;
        }
        return red;
      };

      // Clean frame: the red quad renders, so it has a non-zero red pixel count.
      const clean = await recordVboFrame(pack);
      expect(clean.blob.length).toBeGreaterThan(0);
      const cleanTapePath = spillToDisk(clean);
      const cleanRes = await runOfflineInspectAt({
        tapePath: cleanTapePath,
        drawIdx: 0,
        fields: undefined,
        device: undefined,
        createShaderModule: undefined,
      });
      expect(cleanRes.ok).toBe(true);
      if (!cleanRes.ok) return;
      const cleanRed = countRed(cleanRes.value.report.rt as string);
      expect(cleanRed).toBeGreaterThan(0);

      // XOR every blob byte with 0xFF (corrupts the VBO payload, the only
      // blob-pool content for this frame). The mutated bytes still round-trip
      // the tape format (blob pool layout is byte-length-keyed, not
      // content-keyed), so the offline path receives genuinely different
      // geometry than the clean frame.
      const mutatedBlob = new Uint8Array(clean.blob.length);
      for (let i = 0; i < clean.blob.length; i++) {
        mutatedBlob[i] = (clean.blob[i] ?? 0) ^ 0xff;
      }
      const rt = deserializeTape(clean.json, mutatedBlob);
      expect(rt.ok).toBe(true);

      const mutTapePath = spillToDisk({ json: clean.json, blob: mutatedBlob });
      const mutRes = await runOfflineInspectAt({
        tapePath: mutTapePath,
        drawIdx: 0,
        fields: undefined,
        device: undefined,
        createShaderModule: undefined,
      });

      if (!mutRes.ok) {
        // Content-sensitive rejection -- the path consumed the mutated bytes.
        expect(mutRes.ok).toBe(false);
        return;
      }
      // Structurally valid report, and its pixels DIVERGE from the clean frame
      // (the corrupted geometry no longer paints the same red quad).
      const report = mutRes.value.report;
      expect('bindings' in report).toBe(true);
      expect('drawCall' in report).toBe(true);
      const mutRed = countRed(report.rt as string);
      expect(mutRed).not.toBe(cleanRed);
    },
    60_000,
  );
});

// ============================================================================
// M4 / w19 + w20 -- black-cube repair + falsify (initial-state capture feat).
//
// The whole feat exists to fix a black cube: a hello-cube frame uploads its
// VBO/IBO during the *loading phase* (createBuffer + writeBuffer BEFORE the
// recorder is armed), so the writeBuffer events are never recorded. Without the
// frame-header snapshot loop the replayed buffers have no bytes -> the vertices
// collapse to the origin -> no rasterized cube -> a black RT. The Phase 1
// frame-header snapshot loop (snapshotAllLiveResources) snapshots those
// pre-arm live resources into `initialData` events so replay re-seeds the bytes
// and the cube renders.
//
// The verification's discriminating power hinges on ONE recording-shape
// invariant (research F-2b, plan-strategy R1): writeBuffer MUST happen before
// arm(). The existing recordVboFrame helper (and e2e.dawn.test.ts) writes the
// VBO *after* arm -- with that shape the VBO bytes already live in the blobPool
// as a recorded writeBuffer event, so deleting the initialData event would NOT
// blacken the cube (false-green: AC-02 would still pass for the wrong reason).
// This block writes a NEW helper that uploads before arm, which is the only
// shape under which AC-01 (redPixels > 0) and AC-02 (delete initialData ->
// redPixels == 0) form a genuine repair/falsify pair.
// ============================================================================

const VBO_VS_LOAD = /* wgsl */ `
@vertex
fn main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return vec4(position * 0.8, 1.0);
}`;

const FS_RED = /* wgsl */ `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4(1.0, 0.0, 0.0, 1.0);
}`;

interface LoadPhaseTape {
  readonly json: string;
  readonly blob: Uint8Array;
}

/**
 * Record a cube frame whose VBO/IBO are uploaded during the *loading phase*
 * (createBuffer + writeBuffer BEFORE arm()), then captured into `initialData`
 * events by the frame-header snapshot loop. This is the writeBuffer-before-arm
 * shape required by research F-2b / plan-strategy R1 -- the only shape under
 * which removing the initialData seed actually blackens the cube.
 *
 * Sequence:
 *   createBuffer(VBO) -> writeBuffer(VBO)   <- before arm, NOT recorded as writeBuffer
 *   createBuffer(IBO) -> writeBuffer(IBO)   <- before arm, NOT recorded as writeBuffer
 *   arm(1)
 *   snapshotAllLiveResources()              <- snapshots VBO/IBO into initialData
 *   createPipeline + drawIndexed            <- recorded frame body
 *   onFrameEnd
 */
async function recordLoadPhaseCubeFrame(pack: DawnPack): Promise<LoadPhaseTape> {
  const debugInst = wrap(pack.rhi);
  const wrappedCreateShader = wrapCreateShaderModule(pack.createShaderModule, debugInst);
  const adapterRes = await debugInst.requestAdapter();
  if (!adapterRes.ok) throw new Error('adapter');
  const devRes = await adapterRes.value.requestDevice();
  if (!devRes.ok) throw new Error('device');
  const wrappedDevice = devRes.value;
  const rawDevice: RhiDevice = (wrappedDevice as any)._realDevice;

  // ---- LOADING PHASE: upload VBO + IBO bytes BEFORE arm() ----
  // The recorder is Idle here, so these writeBuffer calls reach the real queue
  // but are NOT recorded as writeBuffer events. Their bytes survive only if the
  // frame-header snapshot captures them into initialData below.
  const verts = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const inds = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const vboRes = wrappedDevice.createBuffer({ size: verts.byteLength, usage: 0x28 });
  if (!vboRes.ok) throw new Error('vbo');
  wrappedDevice.queue.writeBuffer(vboRes.value as any, 0, verts.buffer);
  const iboRes = wrappedDevice.createBuffer({ size: inds.byteLength, usage: 0x18 });
  if (!iboRes.ok) throw new Error('ibo');
  wrappedDevice.queue.writeBuffer(iboRes.value as any, 0, inds.buffer);
  await wrappedDevice.queue.onSubmittedWorkDone();

  // ---- ARM + frame-header snapshot ----
  const armRes = debugInst.arm(1);
  if (!armRes.ok) throw new Error('arm');
  const snapRes = await debugInst.snapshotAllLiveResources();
  if (!snapRes.ok) throw new Error(`snapshot: ${snapRes.error.code}`);

  // ---- RECORDED FRAME BODY: pipeline + drawIndexed ----
  const texRes = wrappedDevice.createTexture({
    size: { width: RT_WIDTH, height: RT_HEIGHT, depthOrArrayLayers: 1 },
    format: 'rgba8unorm' as GPUTextureFormat,
    usage: 0x11,
  });
  if (!texRes.ok) throw new Error('tex');
  const viewRes = wrappedDevice.createTextureView(texRes.value, {});
  if (!viewRes.ok) throw new Error('view');

  const vs = await wrappedCreateShader(rawDevice, { code: VBO_VS_LOAD });
  if (!vs.ok) throw new Error('vs');
  const fs = await wrappedCreateShader(rawDevice, { code: FS_RED });
  if (!fs.ok) throw new Error('fs');

  const bglRes = wrappedDevice.createBindGroupLayout({ entries: [] });
  if (!bglRes.ok) throw new Error('bgl');
  const plRes = wrappedDevice.createPipelineLayout({ bindGroupLayouts: [bglRes.value] });
  if (!plRes.ok) throw new Error('pl');
  const pipeRes = wrappedDevice.createRenderPipeline({
    layout: plRes.value,
    vertex: {
      module: vs.value,
      entryPoint: 'main',
      buffers: [
        { arrayStride: 12, attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }] },
      ],
    },
    fragment: { module: fs.value, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  } as any);
  if (!pipeRes.ok) throw new Error('pipeline');

  const encRes = wrappedDevice.createCommandEncoder({});
  if (!encRes.ok) throw new Error('enc');
  const enc = encRes.value;
  const pass = enc.beginRenderPass({
    colorAttachments: [
      {
        view: viewRes.value as any,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  } as any);
  pass.setPipeline(pipeRes.value as any);
  pass.setVertexBuffer(0, vboRes.value as any, 0, verts.byteLength);
  pass.setIndexBuffer(iboRes.value as any, 'uint16', 0, inds.byteLength);
  pass.drawIndexed(6, 1, 0, 0, 0);
  pass.end();
  const fin = enc.finish();
  if (!fin.ok) throw new Error('finish');
  wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
  await wrappedDevice.queue.onSubmittedWorkDone();

  debugInst.onFrameEnd();
  const tape = debugInst.getTape() as any;
  if (!tape) throw new Error('tape');
  const { json, blob } = serializeTape(tape);
  return { json, blob };
}

/** Count strongly-red pixels (research F-9 template). */
function countRedPixels(pixels: Uint8Array): number {
  let red = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i] ?? 0) > 200 && (pixels[i + 1] ?? 0) < 64 && (pixels[i + 2] ?? 0) < 64) red++;
  }
  return red;
}

/** Replay a deserialized Tape on a fresh device and return RT pixels. */
async function replayTapeToPixels(pack: DawnPack, tape: Tape): Promise<Uint8Array> {
  const rawAdapterRes = await pack.rhi.requestAdapter();
  if (!rawAdapterRes.ok) throw new Error('replay adapter');
  const rawDevRes = await rawAdapterRes.value.requestDevice();
  if (!rawDevRes.ok) throw new Error('replay device');
  const rawDev2: RhiDevice = rawDevRes.value;

  const replayRes = createReplay(tape, rawDev2, pack.createShaderModule);
  if (!replayRes.ok) throw new Error(`createReplay: ${replayRes.error.code}`);
  const replay = replayRes.value;
  const stepRes = await replay.stepTo(tape.events.length - 1);
  if (!stepRes.ok) throw new Error(`stepTo: ${stepRes.error.code}`);
  const rtRes = await replay.readbackRt(0);
  if (!rtRes.ok) throw new Error(`readbackRt: ${rtRes.error.code}`);
  return rtRes.value.pixels;
}

/** Replay a (json, blob) tape on a fresh device and return RT pixels. */
async function replayToPixels(pack: DawnPack, json: string, blob: Uint8Array): Promise<Uint8Array> {
  const rt = deserializeTape(json, blob);
  if (!rt.ok) throw new Error(`deserialize: ${rt.error.code}`);
  return replayTapeToPixels(pack, rt.value);
}

describe.skipIf(SKIP_DAWN)('M4 black-cube repair -- writeBuffer-before-arm (w19 AC-01)', () => {
  it('load-phase VBO/IBO seeded via initialData replays a visible (red) cube', async () => {
    const pack = await loadDawnRhi();
    if (!pack) throw new Error('dawn-node RHI unavailable (FORGEAX_SKIP_DAWN not set)');

    const { json, blob } = await recordLoadPhaseCubeFrame(pack);

    // The recording shape must be writeBuffer-before-arm: the tape must carry
    // initialData seed events for the pre-arm buffers, and must NOT carry their
    // bytes via in-frame writeBuffer events. Assert that structural invariant so
    // a future shape regression (writeBuffer drifting after arm) fails loudly
    // here instead of silently disarming the AC-02 falsifier.
    const parsed = JSON.parse(json) as { events: ReadonlyArray<{ kind: string }> };
    const initialDataCount = parsed.events.filter((e) => e.kind === 'initialData').length;
    const writeBufferCount = parsed.events.filter((e) => e.kind === 'writeBuffer').length;
    expect(initialDataCount).toBeGreaterThanOrEqual(2);
    expect(writeBufferCount).toBe(0);

    const pixels = await replayToPixels(pack, json, blob);
    const redPixels = countRedPixels(pixels);
    expect(redPixels).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(SKIP_DAWN)('M4 black-cube falsify -- delete initialData (w20 AC-02)', () => {
  it('removing one initialData seed event blackens the replayed cube (redPixels == 0)', async () => {
    const pack = await loadDawnRhi();
    if (!pack) throw new Error('dawn-node RHI unavailable (FORGEAX_SKIP_DAWN not set)');

    // Same writeBuffer-before-arm shape as w19. This is the falsification
    // counterpart: w19 proves the initialData seed makes the cube visible
    // (redPixels > 0); w20 proves the seed is the *causal necessary condition*
    // by deleting one initialData event and asserting the cube vanishes
    // (redPixels == 0). The pair (w19 > 0, w20 == 0) is the discriminating
    // evidence that the repair works for the right reason -- if w20 also
    // rendered red, the recording shape would be wrong (writeBuffer leaking
    // into the recorded frame, plan-strategy R1).
    const { json, blob } = await recordLoadPhaseCubeFrame(pack);
    const des = deserializeTape(json, blob);
    if (!des.ok) throw new Error(`deserialize: ${des.error.code}`);
    const cleanTape = des.value;

    // Drop the FIRST initialData event (the VBO seed). Without its bytes the
    // vertex buffer replays empty, the vertices collapse to the origin, and the
    // draw rasterizes nothing -- a black RT.
    const firstInitialDataIdx = cleanTape.events.findIndex((e) => e.kind === 'initialData');
    expect(firstInitialDataIdx).toBeGreaterThanOrEqual(0);
    const mutatedEvents = cleanTape.events.filter((_, i) => i !== firstInitialDataIdx);
    const mutatedTape: Tape = {
      formatVersion: cleanTape.formatVersion,
      rhiCapsRecorded: cleanTape.rhiCapsRecorded,
      events: mutatedEvents,
      blobPool: cleanTape.blobPool,
    };

    const pixels = await replayTapeToPixels(pack, mutatedTape);
    const redPixels = countRedPixels(pixels);
    expect(redPixels).toBe(0);
  }, 60_000);
});
