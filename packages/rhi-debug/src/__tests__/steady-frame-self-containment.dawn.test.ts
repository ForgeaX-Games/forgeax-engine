/**
 * create-then-wrap steady-frame dawn-node regression test (M3 / m3-1).
 *
 * Proves AC-05: a tape produced from a steady frame where all persistent GPU
 * resources were created BEFORE arm() (bootstrap phase) is self-contained --
 * deserializeTape succeeds without dangling handle errors, and the
 * inspect-offline path emits a valid InspectReport JSON + decodable RT PNG.
 *
 * Contrast with inspect-offline.dawn.test.ts (w20) which does
 *   wrap() -> arm() -> create* -> recordFrame
 * so every create* event is an in-frame declaration. That test never
 * exercises the bootstrapCreates closure path (plan-strategy R-4).
 *
 * This test does:
 *   wrap() -> create* (bootstrap / idle state) -> arm(1) -> record steady frame
 * where the frame has 0 persistent resource create* events -- every buffer,
 * texture, shader, pipeline, and bindGroup was registered earlier.  The
 * getTape() _computeClosure path must pull those early creates from
 * bootstrapCreates into the tape prefix.
 *
 * AC-06: the test name appears in `pnpm exec vitest run --project=dawn`
 * output since the file matches the dawn project glob `**\/*.dawn.test.ts`.
 *
 * AC-07: existing dawn tests (inspect-offline.dawn.test.ts) are not broken.
 */

/// <reference types="@webgpu/types" />

// biome-ignore-all lint/suspicious/noExplicitAny: dawn-node e2e constructs RHI
// mock surfaces (GPU device/buffer brands, WebGPU descriptor types) whose
// structural shapes require any casts at the test boundary; dawn-node opaque
// GPU types cannot be imported at the type level

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RhiDevice, RhiInstance } from '@forgeax/engine-rhi';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { runOfflineInspectAt } from '../cli';
import { DebugError } from '../errors';
import { type CreateShaderModuleFn, wrap, wrapCreateShaderModule } from '../recorder';
import { assembleReport } from '../recorder-core';
import { deserializeTape, serializeTape } from '../tape-format';

// ============================================================================
// dawn-node RHI bootstrap
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

const VS_WGSL = /* wgsl */ `
@vertex
fn main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return vec4(position * 0.8, 1.0);
}`;

const FS_WGSL = /* wgsl */ `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4(0.0, 0.0, 1.0, 1.0);
}`;

interface RecordedTape {
  readonly json: string;
  readonly blob: Uint8Array;
}

// ============================================================================
// create-then-arm steady-frame tape producer
// ============================================================================

/**
 * Record a steady frame where every persistent GPU resource is created
 * BEFORE arm() (bootstrap / idle state). The recorded frame contains 0
 * persistent create* events -- only command encoding and draw calls that
 * reference the early handles. This mirrors a real createApp demo's
 * steady-state frame where all resources were initialized before the
 * recorder was armed.
 */
async function recordSteadyFrameTape(pack: DawnPack): Promise<RecordedTape> {
  // (1) wrap -- install proxy on the RHI instance.
  const debugInst = wrap(pack.rhi);
  const wrappedCreateShader = wrapCreateShaderModule(pack.createShaderModule, debugInst);

  // (2) obtain a proxy device (and its _realDevice escape hatch for shader
  //     module creation, just like createApp does).
  const adapterRes = await debugInst.requestAdapter();
  if (!adapterRes.ok) throw new Error('adapter');
  const devRes = await adapterRes.value.requestDevice();
  if (!devRes.ok) throw new Error('device');
  const wrappedDevice = devRes.value;
  const rawDevice: RhiDevice = (wrappedDevice as any)._realDevice;

  // (3) create all persistent GPU resources BEFORE arm().
  //     State is Idle -> registerHandle populates bootstrapCreates +
  //     handleMap; pushEvent is a no-op so no frame events are emitted.
  //     This is the "create-then-arm" pattern that simulates a real
  //     createApp init phase.

  const texRes = wrappedDevice.createTexture({
    size: { width: RT_WIDTH, height: RT_HEIGHT, depthOrArrayLayers: 1 },
    format: 'rgba8unorm' as GPUTextureFormat,
    usage: 0x11, // RENDER_ATTACHMENT | COPY_SRC
  });
  if (!texRes.ok) throw new Error('tex');
  const viewRes = wrappedDevice.createTextureView(texRes.value, {});
  if (!viewRes.ok) throw new Error('view');

  // Shader modules via the standalone createShaderModule wrapper (same
  // path createApp uses: _realDevice -> original fn).
  const vs = await wrappedCreateShader(rawDevice, { code: VS_WGSL });
  if (!vs.ok) throw new Error('vs');
  const fs = await wrappedCreateShader(rawDevice, { code: FS_WGSL });
  if (!fs.ok) throw new Error('fs');

  // Vertex + index buffer objects (created in bootstrap / idle state).
  // writeBuffer must happen after arm() because pushEvent is state-gated;
  // the buffer objects themselves are in bootstrapCreates via registerHandle.
  const verts = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const inds = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const vboRes = wrappedDevice.createBuffer({
    size: verts.byteLength,
    usage: 0x28, // VERTEX | COPY_DST
  });
  if (!vboRes.ok) throw new Error('vbo');
  const iboRes = wrappedDevice.createBuffer({
    size: inds.byteLength,
    usage: 0x18, // INDEX | COPY_DST
  });
  if (!iboRes.ok) throw new Error('ibo');

  // Bind group layout + pipeline layout + render pipeline
  const bglRes = wrappedDevice.createBindGroupLayout({ entries: [] });
  if (!bglRes.ok) throw new Error('bgl');
  const plRes = wrappedDevice.createPipelineLayout({
    bindGroupLayouts: [bglRes.value],
  });
  if (!plRes.ok) throw new Error('pl');
  const pipeRes = wrappedDevice.createRenderPipeline({
    layout: plRes.value,
    vertex: {
      module: vs.value,
      entryPoint: 'main',
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }],
        },
      ],
    },
    fragment: {
      module: fs.value,
      entryPoint: 'main',
      targets: [{ format: 'rgba8unorm' }],
    },
    primitive: { topology: 'triangle-list' },
  } as any);
  if (!pipeRes.ok) throw new Error('pipeline');

  // Bind group (empty, so BGL has no entries)
  const bgRes = wrappedDevice.createBindGroup({
    layout: bglRes.value,
    entries: [],
  });
  if (!bgRes.ok) throw new Error('bindGroup');

  // (4) Sanity: bootstrapCreates is populated but events are still empty.
  expect(debugInst._getBootstrapCreatesSize()).toBeGreaterThan(0);
  expect(debugInst.getEvents().length).toBe(0);

  // (5) arm(1) + record the steady frame. The frame has 0 persistent
  //     create* events -- only writeBuffer for data uploads (which were
  //     deferred to after arm because pushEvent only records during
  //     Armed/Recording state) and command-encoding references.
  const armRes = debugInst.arm(1);
  if (!armRes.ok) throw new Error('arm');

  // writeBuffer data upload for the early-created buffer objects.
  // These produce writeBuffer events but the buffer handleIds resolve
  // from handleMap (set during the earlier createBuffer calls). The
  // buffers' createBuffer events come from bootstrapCreates.
  wrappedDevice.queue.writeBuffer(vboRes.value as any, 0, verts.buffer);
  wrappedDevice.queue.writeBuffer(iboRes.value as any, 0, inds.buffer);

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
  pass.setBindGroup(0, bgRes.value as any);
  pass.setVertexBuffer(0, vboRes.value as any, 0, verts.byteLength);
  pass.setIndexBuffer(iboRes.value as any, 'uint16', 0, inds.byteLength);
  pass.drawIndexed(6, 1, 0, 0, 0);
  pass.end();
  const fin = enc.finish();
  if (!fin.ok) throw new Error('finish');
  wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
  await wrappedDevice.queue.onSubmittedWorkDone();

  debugInst.onFrameEnd();

  // (6) getTape must succeed -- produce a self-contained tape.
  const tape = debugInst.getTape() as any;
  if (tape instanceof DebugError) throw new Error(`tape error: ${tape.message}`);
  if (!tape) throw new Error('tape is undefined');
  const { json, blob } = serializeTape(tape);
  return { json, blob };
}

// ============================================================================
// Disk spilling (same L1 two-file schema as inspect-offline.dawn.test.ts)
// ============================================================================

function spillToDisk(rec: RecordedTape): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-steady-frame-'));
  const report = assembleReport({
    json: rec.json,
    passOffsets: [],
    valid: true,
  });
  const tapePath = join(dir, 'frame-0.tape.bin');
  const reportPath = join(dir, 'frame-0.report.json');
  writeFileSync(tapePath, Buffer.from(rec.blob));
  writeFileSync(reportPath, JSON.stringify(report));
  return tapePath;
}

// ============================================================================
// Tests
// ============================================================================

describe.skipIf(SKIP_DAWN)(
  'steady-frame self-containment dawn regression -- AC-05/AC-06 (m3-1)',
  () => {
    it('create-then-arm steady frame produces self-contained tape + inspect-offline green', async () => {
      const pack = await loadDawnRhi();
      if (!pack) throw new Error('dawn-node RHI unavailable (FORGEAX_SKIP_DAWN not set)');

      const rec = await recordSteadyFrameTape(pack);

      // (A) tape is self-contained: deserializeTape succeeds.
      const deserRes = deserializeTape(rec.json, rec.blob);
      expect(deserRes.ok).toBe(true);
      const tape = deserRes.ok ? deserRes.value : undefined;
      expect(tape).toBeDefined();

      // (B) tape events count > 0.
      if (tape) {
        expect(tape.events.length).toBeGreaterThan(0);
        // Verify at least some create* events are present as bootstrap
        // prefix (not just the frame events).
        const createKinds = tape.events.map((e) => e.kind).filter((k) => k.startsWith('create'));
        expect(createKinds.length).toBeGreaterThan(0);
      }

      // (C) inspect-offline path works: deserializeTape + replay + inspect
      //     emit report JSON + decodable RT PNG.
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

      const report = result.value.report;
      expect(typeof report).toBe('object');
      expect('bindings' in report).toBe(true);
      expect('drawCall' in report).toBe(true);
      expect(Array.isArray(report.bindings)).toBe(true);
      expect(typeof report.drawCall).toBe('object');
      expect(typeof report.rt).toBe('string');
      const pngPath = report.rt as string;
      const decoded = PNG.sync.read(readFileSync(pngPath));
      expect(decoded.width).toBeGreaterThan(0);
      expect(decoded.height).toBeGreaterThan(0);
    }, 60_000);

    // falsification (plan-strategy 5.3, not CI-resident):
    // prove the test has discriminative power -- a tape with a genuinely
    // dangling handle (registered in handleMap but missing from
    // bootstrapCreates) is rejected by getTape() via the M2 fail-fast path.
    it.skipIf(!RUN_FALSIFY)(
      'falsification: dangling handle (bypass bootstrap) causes getTape to fail-fast',
      async () => {
        const pack = await loadDawnRhi();
        if (!pack) throw new Error('dawn-node RHI unavailable');

        // Build a recorder, register a shader module handle directly in
        // handleMap WITHOUT a corresponding bootstrapCreates entry, then
        // reference it in a frame. getTape() must error because the handle
        // is referenced but has no create event (neither in bootstrapCreates
        // nor as an in-frame declaration).
        const debugInst = wrap(pack.rhi);
        const wrappedCreateShader = wrapCreateShaderModule(pack.createShaderModule, debugInst);
        const adapterRes = await debugInst.requestAdapter();
        if (!adapterRes.ok) throw new Error('adapter');
        const devRes = await adapterRes.value.requestDevice();
        if (!devRes.ok) throw new Error('device');
        const wrappedDevice = devRes.value;
        const rawDevice: RhiDevice = (wrappedDevice as any)._realDevice;

        // Create a real shader module so the GPU object is valid, then
        // register it in handleMap via _registerShaderModule (which only
        // sets handleMap, NOT bootstrapCreates).
        const vs = await wrappedCreateShader(rawDevice, {
          code: VS_WGSL,
        });
        if (!vs.ok) throw new Error('vs');
        // This adds to handleMap only -- no bootstrapCreates entry.
        debugInst._registerShaderModule(vs.value, 'shaderModule:orphan' as any);

        // Now create a render pipeline that references this dangling
        // shader module. The pipeline's createRenderPipeline will call
        // getHandleId for the shader module, find it in handleMap, and
        // return 'shaderModule:orphan'. But that id has no create event
        // in bootstrapCreates.
        const pipeRes = wrappedDevice.createRenderPipeline({
          layout: 'auto' as any,
          vertex: {
            module: vs.value,
            entryPoint: 'main',
            buffers: [
              {
                arrayStride: 12,
                attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }],
              },
            ],
          },
          fragment: {
            module: vs.value,
            entryPoint: 'main',
            targets: [{ format: 'rgba8unorm' }],
          },
          primitive: { topology: 'triangle-list' },
        } as any);
        if (!pipeRes.ok) throw new Error('pipeline');

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

        const encRes = wrappedDevice.createCommandEncoder({});
        if (!encRes.ok) throw new Error('enc');
        const pass = encRes.value.beginRenderPass({
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
        pass.draw(3, 1, 0, 0);
        pass.end();
        const fin = encRes.value.finish();
        if (!fin.ok) throw new Error('finish');
        wrappedDevice.queue.submit([fin.value] as unknown as readonly never[]);
        await wrappedDevice.queue.onSubmittedWorkDone();

        debugInst.onFrameEnd();

        // getTape must return a DebugError (M2 fail-fast) or undefined.
        const tape = debugInst.getTape() as any;
        // Accept either: explicit DebugError or undefined (no events
        // because the frame didn't record or closure was rejected).
        if (tape instanceof DebugError) {
          expect(tape.code).toBe('tape-handle-graph-broken');
        } else if (tape === undefined) {
          // Also acceptable: the recorder produced no tape because the
          // closure computation rejected the dangling handle before the
          // frame was finalized.
        } else {
          // If a tape IS produced, deserialize must reject it.
          const { json, blob } = serializeTape(tape);
          const deserRes = deserializeTape(json, blob);
          expect(deserRes.ok).toBe(false);
        }
      },
      60_000,
    );
  },
);
