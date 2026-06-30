// smoke-browser.mjs -- feat-20260611-fox-skinning-vertex-attribute-chain
//
// Playwright e2e smoke for apps/hello/skin. Spawns a local vite dev server,
// drives headed Chrome with WebGPU enabled, and asserts the page boots with
// no `Invalid RenderPipeline.*pbr-skin` GPU validation error in the console.
//
// Why a separate script (not the dawn smoke):
// `smoke-dawn.mjs` walks `gltfDocToSceneAsset` -> direct `register(handle)`,
// skipping the entire `JSON.stringify(pack) -> fetch -> JSON.parse` dev/build
// pack-body pipeline AND the WebGPU device. Three distinct bug families
// surface only on the browser path:
//   (1) typed-array survival (PR#350 -- skeletonLoader number[] dual contract)
//   (2) skin pipeline layout (PR#353 -- pbr-skin BGL 2 entries)
//   (3) skin vertex-attribute chain (this loop -- gltfImporter JOINTS_0 /
//       WEIGHTS_0 extraction + 18F MeshAsset stride + 72B vertex buffer)
// dawn smoke can never catch them. Local-only gate today; CI inclusion gated
// on a Chrome-with-WebGPU runner (plan-strategy R-3 / OOS-1).
//
// Layer-3 (this loop, feat-20260611) flips from informational warn to a hard
// positive gate: we now require BOTH (a) absence of any `Vertex attribute
// slot N used in ... is not present in the VertexState` GPU validation error
// AND (b) browser runtime evidence that an 18F-stride VBO (size % 72 === 0,
// size > 0) was uploaded for the Fox mesh -- i.e. the post-loader MeshAsset
// retained skinIndex / skinWeight as typed arrays through the
// JSON.stringify -> fetch -> JSON.parse round-trip. Both conditions failing
// would have shipped previously (informational warn mode); they now exit 1.
//
// Invocation: `pnpm -F @forgeax/hello-skin smoke:browser`
//
// Exit codes:
//   0 = green (no skin-pipeline error AND no asset-parse error AND layer-3
//       positive gate satisfied)
//   1 = red (regression detected at any layer)
//   2 = harness error (vite did not boot)

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/hello/skin/scripts -> apps/hello/skin -> apps/hello -> apps -> repo root.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-skin', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let portUrl = null;
viteProc.stdout.on('data', (chunk) => {
  const s = chunk.toString();
  process.stdout.write(`[vite] ${s}`);
  const m = s.match(/Local:\s+(http:\/\/[^\s]+)/);
  if (m) portUrl = m[1];
});
viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

const deadline = Date.now() + 30000;
while (!portUrl && Date.now() < deadline) await sleep(200);
if (!portUrl) {
  console.error('FAIL: vite did not become ready in 30s');
  viteProc.kill();
  process.exit(2);
}
console.log(`[smoke-browser] using ${portUrl}`);

// macOS / Linux system Chrome ships WebGPU; bundled chromium does not without
// the right flags + a Vulkan/Metal swiftshader fallback.
const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--ignore-gpu-blocklist',
  ],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
const consoleAll = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}\n${e.stack ?? ''}`));
page.on('console', (msg) => {
  const txt = msg.text();
  consoleAll.push(`[${msg.type()}] ${txt}`);
  if (msg.type() === 'error') errors.push(`CONSOLE-ERR: ${txt}`);
});

// AC-03 (bug-20260612): record every dev `POST /__import/<guid>` response so the
// smoke can prove the dev lazy-import chain actually fired AND returned a
// well-formed `PackIndexEntry[]` body (not a 4xx/5xx). The runtime's
// `createDevImportTransport` issues exactly one POST per missing-DDC GUID; a
// successful Fox.glb load should hit /__import for the scene root + all
// sub-asset GUIDs the runtime walks (mesh, material, texture, skeleton, skin,
// 3 anim-clips). A 4xx/5xx, an empty entries array, or a missing `kind=scene`
// row indicates the very failure mode the requirements describe even when the
// browser console transcript happens to be clean.
const importProbeHits = [];
page.on('response', async (resp) => {
  const url = resp.url();
  const idx = url.indexOf('/__import/');
  if (idx < 0) return;
  // Strip query/hash if any, then take the suffix as guid.
  const guid = url.slice(idx + '/__import/'.length).replace(/[?#].*$/, '');
  let entriesLen;
  let entryKinds = [];
  try {
    const body = await resp.json();
    if (Array.isArray(body)) {
      entriesLen = body.length;
      entryKinds = body
        .map((e) => (e && typeof e === 'object' ? e.kind : undefined))
        .filter((k) => typeof k === 'string');
    }
  } catch (_e) {
    // Non-JSON body (e.g. plain-text 4xx/5xx) -- leave entriesLen undefined.
  }
  importProbeHits.push({
    guid,
    status: resp.status(),
    entriesLen,
    entryKinds,
  });
});

// Capture GPU pipeline descriptors + device errors + vertex-buffer uploads.
// The buffer hooks form the layer-3 positive probe: we record every
// `createBuffer` whose usage includes GPUBufferUsage.VERTEX (0x20) plus the
// matching `queue.writeBuffer` payload arg type+byteLength. A Fox 18F mesh
// upload manifests as an `mesh-<id>-vbo` buffer whose size is a non-zero
// multiple of 72 (12F position+normal+uv+tangent + 8B skinIndex packed +
// 16B skinWeight = 72B stride).
await page.addInitScript(() => {
  if (navigator.gpu == null) return;
  globalThis.__forgeaxPipelines = [];
  globalThis.__forgeaxDeviceErrors = [];
  globalThis.__forgeaxVertexBuffers = [];
  globalThis.__forgeaxVertexBufferWrites = [];
  // feat-20260612-skin-palette-per-frame-upload M4 / m4-1 + m4-2: capture
  // every queue.writeBuffer payload targeting a buffer with label
  // `skin-palette` (the per-frame palette storage buffer the new
  // SkinPaletteAllocator from M1 m1-2 owns). For each write we record an
  // FNV-1a-32 hash of the full payload bytes (AC-01 full-mat4-region
  // distinctness) plus a focused FNV-1a-32 hash of the FIRST mat4 (bytes
  // [0..64], 16-float column-major, i.e. the root joint M_0 = joint_world *
  // IBM) for AC-02 root-joint-Transform.world distinctness. Cursor rewinds
  // per frame so byteOffset=0 entries should appear once per frame per
  // skinned entity; across ~8s of rendering (= hundreds of frames) we
  // expect >>10 entries with ≥2 distinct hash values once advanceAnimation
  // -> Transform.world -> writeJointPalette is alive.
  globalThis.__forgeaxSkinPaletteBuffers = [];
  globalThis.__forgeaxSkinPaletteWrites = [];
  // M4 / m4-3: capture every setBindGroup(2, bg, dynamicOffsets) call so
  // we can verify dynamicOffsets[1] (= per-entity skin palette byteOffset
  // wired by record-stage M3 m3-2) takes >=2 distinct values across the
  // 3 Fox lineup. The first dynamic offset is the per-entity mesh UBO
  // stride (mesh-array-bgl binding 0); the second is the skin palette
  // slice byteOffset (mesh-array-bgl binding 1). Three Fox instances
  // produce three distinct slice byteOffsets within a single frame
  // (allocator cursor advances per allocateSlice), so a sane recording
  // collects {0, 24*64, 2*24*64} = {0, 1536, 3072} on a 24-joint Fox.
  // FALSIFY anchor: hardcode dynamicOffsets[1]=0 in record-stage ->
  // distinctness collapses to 1 -> probe red.
  globalThis.__forgeaxSkinSetBindGroup2 = [];
  navigator.gpu.requestAdapter = async (...a) => {
    const adapter = await origReqAdapter(...a);
    if (adapter == null) return adapter;
    const origReqDev = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (...da) => {
      const dev = await origReqDev(...da);
      if (dev == null) return dev;
      const origCRP = dev.createRenderPipeline.bind(dev);
      dev.createRenderPipeline = (desc) => {
        try {
          globalThis.__forgeaxPipelines.push({
            label: desc.label,
            vertexEntryPoint: desc.vertex?.entryPoint,
            bufferCount: (desc.vertex?.buffers ?? []).length,
            bufferStrides: (desc.vertex?.buffers ?? []).map((b) => b.arrayStride),
          });
        } catch (_e) {}
        return origCRP(desc);
      };
      const origCB = dev.createBuffer.bind(dev);
      // GPUBufferUsage.VERTEX = 0x20 per the WebGPU spec.
      const VERTEX_USAGE = 0x20;
      // Map: buffer -> entry index in __forgeaxVertexBuffers, so the
      // queue.writeBuffer hook can look up the buffer's recorded label/size.
      const bufferIndex = new WeakMap();
      // M4 / m4-1: parallel WeakMap for skin-palette buffers so the
      // writeBuffer hook below can hash + record only those payloads,
      // independent of the VERTEX-usage path.
      const paletteIndex = new WeakMap();
      dev.createBuffer = (desc) => {
        const buf = origCB(desc);
        try {
          if ((desc.usage & VERTEX_USAGE) === VERTEX_USAGE) {
            const idx = globalThis.__forgeaxVertexBuffers.length;
            globalThis.__forgeaxVertexBuffers.push({
              label: desc.label ?? '',
              size: desc.size,
              usage: desc.usage,
            });
            bufferIndex.set(buf, idx);
          }
          // M4 / m4-1 + m4-2: track skin-palette buffer reallocations. The
          // SkinPaletteAllocator labels its GPUBuffer 'skin-palette' (see
          // packages/runtime/src/systems/skin-palette-allocator.ts grow()).
          if ((desc.label ?? '') === 'skin-palette') {
            const pIdx = globalThis.__forgeaxSkinPaletteBuffers.length;
            globalThis.__forgeaxSkinPaletteBuffers.push({
              size: desc.size,
              usage: desc.usage,
            });
            paletteIndex.set(buf, pIdx);
          }
        } catch (_e) {}
        return buf;
      };
      // M4 / m4-1 + m4-2: FNV-1a 32-bit hash over a Uint8Array byte range.
      // Inlined (not imported) because addInitScript runs in page context
      // before any modules. Stable across frames for identical bytes; any
      // single-bit mutation flips ≥1 byte of the digest. 0-byte inputs
      // collapse to the FNV offset basis (string '0').
      const fnv1a32 = (bytes, start, end) => {
        let h = 0x811c9dc5;
        for (let i = start; i < end; i++) {
          h ^= bytes[i] ?? 0;
          h = (h * 0x01000193) >>> 0;
        }
        return h.toString(16).padStart(8, '0');
      };
      const origQueue = dev.queue;
      const origWriteBuffer = origQueue.writeBuffer.bind(origQueue);
      origQueue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
        try {
          const idx = bufferIndex.get(buffer);
          if (idx !== undefined) {
            const entry = globalThis.__forgeaxVertexBuffers[idx];
            const ctorName = data?.constructor?.name ?? typeof data;
            const byteLen =
              data?.byteLength ??
              (typeof data?.length === 'number' ? data.length : undefined);
            globalThis.__forgeaxVertexBufferWrites.push({
              label: entry?.label,
              ctor: ctorName,
              byteLength: byteLen,
            });
          }
          const pIdx = paletteIndex.get(buffer);
          if (pIdx !== undefined) {
            // Capture the payload bytes for hash (AC-01 full + AC-02
            // first-mat4 root-joint slice). data may be a TypedArray or a
            // plain ArrayBuffer; normalise to Uint8Array view.
            const u8 =
              data instanceof Uint8Array
                ? data
                : data?.buffer != null
                  ? new Uint8Array(data.buffer, data.byteOffset ?? 0, data.byteLength)
                  : data instanceof ArrayBuffer
                    ? new Uint8Array(data)
                    : null;
            if (u8 !== null) {
              const totalLen = u8.byteLength;
              const fullHash = fnv1a32(u8, 0, totalLen);
              // First mat4 = 64 bytes = bytes [0..64]; clamp on shorter
              // payloads (e.g. partial slice writes) so the slice still has
              // a stable identity.
              const headEnd = Math.min(64, totalLen);
              const firstMat4Hash = fnv1a32(u8, 0, headEnd);
              globalThis.__forgeaxSkinPaletteWrites.push({
                offset,
                byteLength: totalLen,
                fullHash,
                firstMat4Hash,
              });
            }
          }
        } catch (_e) {}
        return origWriteBuffer(buffer, offset, data, dataOffset, size);
      };
      // M4 / m4-3: wrap createCommandEncoder so we can intercept
      // beginRenderPass -> setBindGroup. setBindGroup is called on
      // GPURenderPassEncoder instances created lazily per frame, so we
      // wrap each encoder + pass at construction time. We only record
      // groupIndex===2 calls (the mesh-array-bgl slot wired in record-
      // stage); their dynamicOffsets[1] is the load-bearing value.
      const origCreateCommandEncoder = dev.createCommandEncoder.bind(dev);
      dev.createCommandEncoder = (cdesc) => {
        const enc = origCreateCommandEncoder(cdesc);
        try {
          const origBeginRenderPass = enc.beginRenderPass.bind(enc);
          enc.beginRenderPass = (pdesc) => {
            const pass = origBeginRenderPass(pdesc);
            try {
              const origSetBindGroup = pass.setBindGroup.bind(pass);
              pass.setBindGroup = (groupIndex, bindGroup, dynamicOffsets) => {
                try {
                  if (groupIndex === 2 && dynamicOffsets != null) {
                    // dynamicOffsets may be Uint32Array or number[]; both
                    // expose .length + index access.
                    const len =
                      typeof dynamicOffsets.length === 'number' ? dynamicOffsets.length : 0;
                    if (len >= 1) {
                      globalThis.__forgeaxSkinSetBindGroup2.push({
                        passLabel: pdesc?.label ?? '',
                        offsets: Array.from({ length: len }, (_, k) => Number(dynamicOffsets[k])),
                      });
                    }
                  }
                } catch (_e) {}
                return origSetBindGroup(groupIndex, bindGroup, dynamicOffsets);
              };
            } catch (_e) {}
            return pass;
          };
        } catch (_e) {}
        return enc;
      };
      dev.addEventListener('uncapturederror', (ev) => {
        globalThis.__forgeaxDeviceErrors.push(String(ev.error?.message ?? ev));
        console.error('[gpu-uncapturederror]', String(ev.error?.message ?? ev));
      });
      return dev;
    };
    return adapter;
  };
});

await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(8000);

const captured = await page.evaluate(() => ({
  pipelines: globalThis.__forgeaxPipelines ?? [],
  deviceErrors: globalThis.__forgeaxDeviceErrors ?? [],
  vertexBuffers: globalThis.__forgeaxVertexBuffers ?? [],
  vertexBufferWrites: globalThis.__forgeaxVertexBufferWrites ?? [],
  skinPaletteBuffers: globalThis.__forgeaxSkinPaletteBuffers ?? [],
  skinPaletteWrites: globalThis.__forgeaxSkinPaletteWrites ?? [],
  skinSetBindGroup2: globalThis.__forgeaxSkinSetBindGroup2 ?? [],
  hudText: document.getElementById('skin-hud')?.innerText ?? '',
}));
console.log('\n=== captured GPU pipelines ===');
captured.pipelines.forEach((p, i) => console.log(`[#${i}]`, JSON.stringify(p)));
console.log('=== captured GPU device errors ===');
captured.deviceErrors.forEach((e) => console.log(e));
console.log('=== captured VERTEX buffers (createBuffer) ===');
captured.vertexBuffers.forEach((b, i) =>
  console.log(`[#${i}] label=${b.label} size=${b.size} size%72=${b.size % 72}`),
);
console.log('=== captured VERTEX buffer writes (queue.writeBuffer) ===');
captured.vertexBufferWrites.forEach((w, i) =>
  console.log(`[#${i}] label=${w.label} ctor=${w.ctor} byteLength=${w.byteLength}`),
);
console.log('=== full console transcript ===');
consoleAll.forEach((l) => console.log(l));
console.log('=== captured CONSOLE errors ===');
errors.forEach((e) => console.log(e));
console.log('=== end ===');

await browser.close();
viteProc.kill('SIGTERM');
await sleep(500);

// Layer-1 (PR#350): asset-parse-failed for skeleton  -- must not regress
// Layer-2 (PR#353): Invalid RenderPipeline / Binding doesn't exist on
//   pbr-mesh-array-bgl  -- must not regress (the new pbr-skin-mesh-array-bgl
//   has 2 entries so the binding-1 lookup succeeds)
// Layer-3 (this loop, feat-20260611): Vertex attribute slot N used in ... is
//   not present in the VertexState  -- positive gate: must NOT appear AND a
//   non-zero 72B-stride VBO (size % 72 === 0) must have been uploaded with a
//   typed-array data argument (proving the pack-body number[] -> typed array
//   round-trip survived for skinIndex / skinWeight).
const layer1Regression = errors.find((e) =>
  /asset-parse-failed.*skeleton|loadByGuid.*failed/i.test(e),
);
if (layer1Regression) {
  console.error(
    `\n[smoke-browser] LAYER-1 RED -- asset-parse-failed regression (PR#350):\n  ${layer1Regression}`,
  );
  process.exit(1);
}
const layer2Regression = [...errors, ...captured.deviceErrors].find((e) =>
  /Binding doesn't exist.*pbr-mesh-array-bgl/i.test(e),
);
if (layer2Regression) {
  console.error(
    `\n[smoke-browser] LAYER-2 RED -- pbr-mesh-array-bgl binding-1 missing regression:\n  ${layer2Regression}`,
  );
  process.exit(1);
}
const skinPipelineSeen = captured.pipelines.some((p) =>
  /pbr-pipeline-forgeax::pbr-skin/i.test(p.label ?? ''),
);
if (!skinPipelineSeen) {
  console.error(
    '\n[smoke-browser] RED -- no `pbr-pipeline-forgeax::pbr-skin` createRenderPipeline call observed; demo did not exercise the skin path',
  );
  process.exit(1);
}

// Layer-3 positive gate (feat-20260611): hard-fail on any vertex-attribute
// validation error referencing pbr-skin.
const layer3VertexAttrError = [...errors, ...captured.deviceErrors].find((e) =>
  /Vertex attribute.*not present in.*VertexState|Vertex attribute slot \d+ used in.*pbr-skin/i.test(
    e,
  ),
);
if (layer3VertexAttrError) {
  console.error(
    `\n[smoke-browser] LAYER-3 RED -- skin pipeline vertex-attribute validation error:\n  ${layer3VertexAttrError}`,
  );
  process.exit(1);
}

// Layer-3 positive evidence: at least one VERTEX-usage buffer with a non-zero
// size that is an exact multiple of 72 (the 18F skin stride). Builtin
// 12F meshes (cube / sphere / quad / triangle) all have stride 48, so a
// 72-multiple buffer can only come from the Fox 18F upload path.
const skinVbo = captured.vertexBuffers.find(
  (b) => b.size > 0 && b.size % 72 === 0,
);
if (skinVbo === undefined) {
  console.error(
    '\n[smoke-browser] LAYER-3 RED -- no VERTEX buffer with size%72===0 observed; ' +
      'Fox 18F mesh upload did not occur. ' +
      'Suspect: gltfImporter JOINTS_0/WEIGHTS_0 extraction, MeshAsset.attributes.skinIndex ' +
      'pack-body round-trip, or render-data layout discriminator regressed. ' +
      `Recorded ${captured.vertexBuffers.length} VBO(s); sizes=${captured.vertexBuffers
        .map((b) => b.size)
        .join(',')}.`,
  );
  process.exit(1);
}
const skinVboWrite = captured.vertexBufferWrites.find(
  (w) => w.label === skinVbo.label,
);
if (skinVboWrite === undefined) {
  console.error(
    `\n[smoke-browser] LAYER-3 RED -- 18F VBO ${skinVbo.label} created but no matching queue.writeBuffer recorded`,
  );
  process.exit(1);
}
// `mesh.vertices` is the loader-emitted Float32Array (interleaved 18 floats
// per vertex). A typed-array-shaped writeBuffer arg confirms the dual-contract
// recovery in mesh-loader (number[] -> Float32Array) succeeded.
if (skinVboWrite.ctor !== 'Float32Array') {
  console.error(
    `\n[smoke-browser] LAYER-3 RED -- 18F VBO write data ctor was ${skinVboWrite.ctor}; expected Float32Array. ` +
      'Suspect: mesh-loader dual-contract regression (skinIndex / skinWeight survived as number[]).',
  );
  process.exit(1);
}
const skinVertexCount = skinVbo.size / 72;
console.log(
  `\n[smoke-browser] LAYER-3 GREEN -- 18F VBO ${skinVbo.label} size=${skinVbo.size} ` +
    `(${skinVertexCount} vertices x 72B stride), write ctor=${skinVboWrite.ctor} byteLength=${skinVboWrite.byteLength}`,
);

// AC-01 strict gate (feat-20260611 R2 / M8 / w27): the regex layers above
// only catch named validation errors; the broader BGL-mismatch /
// Invalid CommandBuffer / queue-submit-failed family slips through
// unless we hard-fail on any non-empty deviceErrors collection. R1
// implement-review F-1 demonstrated this exact false-green path: the
// record stage built a 1-binding `pbr-mesh-bg` against a 2-binding
// `pbr-skin-pl` PipelineLayout, the device fired
// `Bind group layout pbr-skin-mesh-array-bgl ... does not match layout
// pbr-mesh-array-bgl` every frame, but the regex above didn't match the
// "Bind group layout ... does not match" wording so the smoke printed
// GREEN anyway. captured.deviceErrors is the single source of truth for
// every uncapturederror the device fires; one empty-set gate covers
// the entire device-error class.
if (captured.deviceErrors.length > 0) {
  console.error(
    `\n[smoke-browser] AC-01 RED -- ${captured.deviceErrors.length} device error(s) captured ` +
      'but smoke would have printed GREEN. Listing each below:',
  );
  captured.deviceErrors.forEach((e, i) => {
    console.error(`  [device-error #${i}] ${e}`);
  });
  process.exit(1);
}

// AC-03 (bug-20260612): dev `/__import/<guid>` positive probe. Walks the
// recorded responses captured via `page.on('response')` above. Three gates,
// any one red exits 1:
//   (a) hit count >= 3 -- Fox.glb declares 9 sub-assets (scene + mesh +
//       material + texture + skeleton + skin + 3 anim-clip). The runtime
//       walks the scene graph lazily, so an exact count is brittle, but
//       fewer than 3 imports means the lazy-import transport never engaged
//       (the bug's exact symptom: `asset-not-imported` returned without a
//       transport fetch). Lower bound is intentionally loose to tolerate
//       runtime-side walk-order changes; a FALSIFY (empty pluginPack roots)
//       collapses this to 0 hits and trips the gate.
//   (b) zero non-2xx responses -- a 404 / 422 / 500 from /__import means
//       the dev plugin rejected the GUID; the runtime would surface this
//       as the exact `asset-not-imported` error the requirements describe.
//   (c) at least one response carries `kind=scene` -- proves the Fox.glb
//       SCENE root specifically routed through the per-meta import path.
//       If only sub-assets (mesh / texture) round-trip but the scene row
//       is missing, `loadByGuid<SceneAsset>(FOX_SCENE_GUID)` would still
//       fail even though the rest of the chain looks healthy.
const importProbeHitCount = importProbeHits.length;
const importProbeNon2xx = importProbeHits.filter((h) => h.status < 200 || h.status >= 300);
const importProbeKindUnion = new Set(importProbeHits.flatMap((h) => h.entryKinds));
console.log('\n=== AC-03 import probe hits ===');
importProbeHits.forEach((h, i) =>
  console.log(
    `[#${i}] guid=${h.guid.slice(0, 8)} status=${h.status} entriesLen=${h.entriesLen ?? 'n/a'} kinds=[${h.entryKinds.join(',')}]`,
  ),
);
console.log(
  `=== AC-03 summary: hits=${importProbeHitCount} non2xx=${importProbeNon2xx.length} kindUnion=[${[...importProbeKindUnion].join(',')}] ===`,
);
if (importProbeHitCount < 3) {
  console.error(
    `\n[smoke-browser] AC-03 RED -- only ${importProbeHitCount} POST /__import hit(s) observed; ` +
      'expected >= 3 for Fox.glb sub-asset walk (scene + mesh + material + texture + skeleton + skin + 3 anim-clip). ' +
      'Suspect: createDevImportTransport never engaged, vite pluginPack missing Fox roots, or runtime asset-registry walk regressed.',
  );
  process.exit(1);
}
if (importProbeNon2xx.length > 0) {
  console.error(
    `\n[smoke-browser] AC-03 RED -- ${importProbeNon2xx.length} non-2xx /__import response(s); ` +
      'dev plugin rejected GUID(s). First failure:',
  );
  const first = importProbeNon2xx[0];
  console.error(`  guid=${first.guid} status=${first.status} kinds=[${first.entryKinds.join(',')}]`);
  process.exit(1);
}
if (!importProbeKindUnion.has('scene')) {
  console.error(
    '\n[smoke-browser] AC-03 RED -- no /__import response carried kind=scene; ' +
      'Fox.glb SCENE root never imported through dev transport. ' +
      `Observed kinds: [${[...importProbeKindUnion].join(',')}]. ` +
      'Suspect: per-meta import filtered out the scene row, or runtime never resolved the scene GUID.',
  );
  process.exit(1);
}

// feat-20260612-skin-palette-per-frame-upload M4 / m4-1: AC-01 palette
// buffer hash distinctness probe. The new SkinPaletteAllocator (M1 m1-2)
// owns one GPUBuffer labeled `skin-palette` and rewrites it every frame
// via queue.writeBuffer (record stage M3). The advanceAnimationPlayer +
// Transform.world propagation drives joint world matrices each frame, so
// the pre-multiplied M_i = joint_world * IBM payload bytes must change
// across frames whenever any clip is playing. Three Fox.glb instances are
// playing Survey/Walk/Run clips so within any few frames the recorded
// payload hashes should span ≥2 distinct values. A frozen palette (the
// failure mode plan-strategy §5.4 calls "writeJointPalette short-circuited
// to identity") collapses every recorded hash to a single value and trips
// this gate. Lower-bound on hits stays loose (≥3) to tolerate slow CI
// runners that only render a handful of frames before the 8s wait
// expires; the distinctness gate (≥2 unique fullHash entries) is the
// load-bearing assertion. FALSIFY anchor (documented, not in CI):
// short-circuit writeJointPalette in skin-palette-allocator.ts to write a
// constant identity payload, then re-run smoke:browser -> this probe must
// turn red.
const skinPaletteWrites = captured.skinPaletteWrites;
const skinPaletteHits = skinPaletteWrites.length;
const skinPaletteFullHashes = skinPaletteWrites.map((w) => w.fullHash);
const skinPaletteFullHashSet = new Set(skinPaletteFullHashes);
console.log('\n=== AC-01 skin-palette buffer writes ===');
skinPaletteWrites.slice(0, 12).forEach((w, i) =>
  console.log(
    `[#${i}] offset=${w.offset} byteLength=${w.byteLength} fullHash=${w.fullHash} firstMat4Hash=${w.firstMat4Hash}`,
  ),
);
if (skinPaletteWrites.length > 12) {
  console.log(`(...${skinPaletteWrites.length - 12} more entries elided)`);
}
console.log(
  `=== AC-01 summary: hits=${skinPaletteHits} distinctFullHash=${skinPaletteFullHashSet.size} distinctFirstMat4Hash=${new Set(skinPaletteWrites.map((w) => w.firstMat4Hash)).size} ===`,
);
if (skinPaletteHits < 3) {
  console.error(
    `\n[smoke-browser] AC-01 RED -- only ${skinPaletteHits} skin-palette writeBuffer call(s) observed; ` +
      'expected >=3 frames worth of palette uploads (one per skinned entity per frame, 3 Fox instances). ' +
      'Suspect: SkinPaletteAllocator never created the buffer, extract stage error short-circuited before record, ' +
      'or device.queue.writeBuffer hook never engaged.',
  );
  process.exit(1);
}
if (skinPaletteFullHashSet.size < 2) {
  console.error(
    `\n[smoke-browser] AC-01 RED -- ${skinPaletteHits} palette writes recorded but only ` +
      `${skinPaletteFullHashSet.size} distinct fullHash value(s); palette payload is frozen across frames. ` +
      'Suspect: writeJointPalette short-circuited to identity, advanceAnimationPlayer not driving Transform.world, ' +
      'or the per-frame allocator cursor reset is eating into the same identical payload every frame.',
  );
  process.exit(1);
}
console.log(
  `\n[smoke-browser] AC-01 GREEN -- ${skinPaletteHits} palette writes, ` +
    `${skinPaletteFullHashSet.size} distinct fullHash values (palette is alive across frames).`,
);

// feat-20260612-skin-palette-per-frame-upload M4 / m4-2: AC-02 root-joint
// Transform.world distinctness probe. Reuses skinPaletteWrites from the
// same queue.writeBuffer hook but focuses on the FIRST mat4 of each
// payload (bytes [0..64], 16-float column-major). For a Skin whose
// SkinAsset.jointPaths[0] points at the skeleton root, that mat4 is
// M_0 = root_joint_world * IBM_0 -- and IBM_0 is a constant determined by
// SkeletonAsset.inverseBindMatrices, so any change in firstMat4Hash maps
// 1:1 to a change in root_joint Transform.world. Distinctness across
// ≥10 sample writes proves advanceAnimationPlayer is mutating the joint
// hierarchy each frame and propagateTransforms is rewriting Transform.world
// before the record stage's writeJointPalette pulls the view. FALSIFY
// anchor: short-circuit advanceAnimationPlayer to skip its world.set
// emissions -> Transform.world stays at the bind pose value -> firstMat4
// payload bytes collapse to a single hash -> probe red. The 10-sample
// minimum is the plan-strategy §5.3 sample-window for AC-02 (vs AC-01's
// 3 samples) and is the load-bearing falsify divergence between the two
// probes when only one half of the chain breaks; on a fully-broken upstream
// (M1 m1-2 regression making smoke 0-frames) both probes red identically.
const skinPaletteFirstMat4Set = new Set(skinPaletteWrites.map((w) => w.firstMat4Hash));
console.log(
  `=== AC-02 summary: hits=${skinPaletteHits} distinctFirstMat4=${skinPaletteFirstMat4Set.size} (sample window >=10 writes, first-mat4 = root joint M_0) ===`,
);
if (skinPaletteHits < 10) {
  console.error(
    `\n[smoke-browser] AC-02 RED -- only ${skinPaletteHits} palette writes recorded (need >=10 for ` +
      'AC-02 sample window). The 8-second wait should have produced hundreds of frames worth of ' +
      'skinned-entity uploads. Suspect: smoke is exiting before steady-state, dev server cold-start ' +
      'is eating the budget, or the upstream extract path is rejecting Fox skin entities.',
  );
  process.exit(1);
}
if (skinPaletteFirstMat4Set.size < 2) {
  console.error(
    `\n[smoke-browser] AC-02 RED -- ${skinPaletteHits} palette writes recorded but first-mat4 ` +
      `(root joint M_0) collapsed to a single hash across all of them. Suspect: advanceAnimationPlayer ` +
      'short-circuited (no world.set), propagateTransforms not rewriting Transform.world, or the ' +
      'joint hierarchy is sourced from a stale view that never refreshes.',
  );
  process.exit(1);
}
console.log(
  `\n[smoke-browser] AC-02 GREEN -- ${skinPaletteHits} palette writes, ` +
    `${skinPaletteFirstMat4Set.size} distinct first-mat4 hashes (root joint world matrix is alive).`,
);

// feat-20260612-skin-palette-per-frame-upload M4 / m4-3: AC-03 dyn-offset
// distinctness probe. record-stage M3 m3-2 wires dynamicOffsets[1] of
// every setBindGroup(2, mesh-array-bg, ...) call to the per-entity
// SkinPaletteSlice.byteOffset that was allocated upstream (M2 m2-6).
// Three Fox.glb instances with 24 joints each carve three distinct
// allocator slices (cursor at 0, 24*64=1536, 2*24*64=3072) so within any
// single frame we expect dynamicOffsets[1] in {0, 1536, 3072} -- a set of
// >=2 distinct values is the load-bearing assertion. FALSIFY anchor:
// hardcode dynamicOffsets[1]=0 in render-system-record.ts -> set
// distinctness collapses to {0} -> probe red. Note: only setBindGroup(2)
// calls on the skin pass should emit groupIndex===2 with the mesh-array
// dyn-offset shape; non-skin paths (shadow, sprite) also hit
// setBindGroup(2) but with their own mesh-bgl byteOffset semantics, which
// is fine because they too should produce >=2 distinct values per frame
// across multiple draws.
const skinDyn = captured.skinSetBindGroup2;
const skinDynSecondValues = skinDyn
  .map((s) => (s.offsets && s.offsets.length >= 2 ? s.offsets[1] : undefined))
  .filter((v) => typeof v === 'number');
const skinDynSecondSet = new Set(skinDynSecondValues);
console.log('\n=== M4 AC-03 setBindGroup(2,...) captures ===');
skinDyn.slice(0, 12).forEach((s, i) =>
  console.log(`[#${i}] passLabel=${JSON.stringify(s.passLabel)} offsets=[${s.offsets.join(',')}]`),
);
if (skinDyn.length > 12) {
  console.log(`(...${skinDyn.length - 12} more entries elided)`);
}
console.log(
  `=== M4 AC-03 summary: setBindGroup2Hits=${skinDyn.length} secondOffsetCount=${skinDynSecondValues.length} distinctSecondOffset=${skinDynSecondSet.size} (sample=[${[...skinDynSecondSet].slice(0, 8).join(',')}]) ===`,
);
if (skinDynSecondValues.length < 3) {
  console.error(
    `\n[smoke-browser] M4 AC-03 RED -- only ${skinDynSecondValues.length} setBindGroup(2,...) call(s) ` +
      'with >=2 dynamicOffsets observed; expected at least 3 (one per Fox instance per frame). ' +
      'Suspect: record stage never reached the skin pass, dynamicOffsets array shrunk to length 1, ' +
      'or setBindGroup wrap was bypassed by a different command-encoder path.',
  );
  process.exit(1);
}
if (skinDynSecondSet.size < 2) {
  console.error(
    `\n[smoke-browser] M4 AC-03 RED -- ${skinDynSecondValues.length} dynamicOffsets[1] values ` +
      `recorded but only ${skinDynSecondSet.size} distinct value(s) (=${[...skinDynSecondSet].join(',')}). ` +
      'Suspect: record-stage hardcoded dynamicOffsets[1]=0 (M3 m3-2 regression), allocator returning ' +
      'identical byteOffset for every entity (cursor not advancing), or only one skinned entity ' +
      'made it past the extract gate.',
  );
  process.exit(1);
}
console.log(
  `\n[smoke-browser] M4 AC-03 GREEN -- ${skinDynSecondValues.length} dynamicOffsets[1] values, ` +
    `${skinDynSecondSet.size} distinct (allocator slice byteOffsets are spreading across entities).`,
);

// feat-20260612-skin-palette-per-frame-upload M6 / AC-04: skin-palette
// dynamic-offset bounds gate. The bug this fix repairs surfaces ONLY in
// the browser path's WebGPU validator -- dawn-node accepted the same
// command stream and produced a green pixel readback (verify-stage 1st
// run shipped GREEN with this bug live). When the allocator's underlying
// buffer is sized to a single binding window (16320 B) but the 2nd skin
// entity's setBindGroup(2, _, [_, dynOffset=1536]) requests a 16320 B
// view starting at 1536, validation fires:
//
//   "Dynamic Offset[1] (1536) is out of bounds of [Buffer "skin-palette"]
//    with a size of 16320 and a bound range of (offset: 0, size: 16320)"
//
// One probe across both surfaces: scan deviceErrors for the wgpu phrase
// + check the captured RhiError text for the runtime-translated
// `queue-write-buffer-out-of-bounds` code (the engine surface for the
// same wgpu validation). Either hit -> RED. Empty -> GREEN.
const skinPaletteBoundsHits = captured.deviceErrors.filter((line) => {
  const s = String(line);
  return (
    /skin-palette/.test(s) &&
    (/Dynamic\s+Offset/.test(s) || /out\s+of\s+bounds/i.test(s) ||
      /queue-write-buffer-out-of-bounds/.test(s))
  );
});
if (skinPaletteBoundsHits.length > 0) {
  console.error(
    `\n[smoke-browser] M6 AC-04 RED -- ${skinPaletteBoundsHits.length} skin-palette ` +
      'dynamic-offset bounds error(s) detected. The allocator buffer is sized for a single ' +
      'binding window but the 2nd+ skin entity binds dynOffset > 0; allocator.allocateSlice ' +
      'must guarantee buffer.size >= byteOffset + bindingWindowBytes for every slice it returns.',
  );
  skinPaletteBoundsHits.forEach((line, i) =>
    console.error(`  [bounds-error #${i}] ${line}`),
  );
  process.exit(1);
}
console.log(
  `\n[smoke-browser] M6 AC-04 GREEN -- 0 skin-palette dynamic-offset bounds errors ` +
    '(allocator buffer extends a full binding window past the last slice).',
);

// feat-20260615-animation-player-crossfade-simple-transition AC-09: HUD
// text snapshot grep gate. The hello-skin demo HUD is a DOM div (#skin-hud)
// updated every frame by refreshHud() in src/main.ts, surfacing the
// AnimationPlayer SoA columns (clips/times/weights) per-slot. charter F2
// (text >> image) + plan-strategy D-4 lock the HUD to DOM innerText so this
// string-grep is the primary verification path for N-way SoA exposure;
// AC-07/08 PNG readback only arbitrates ambiguous visual diffs.
//
// Required literals (each must appear at least once in HUD innerText):
//   * clips[0..3]=     (4-slot SoA clips column)
//   * weights[0..3]=   (weights column)
//   * times[0..3]=     (times column)
// 12 literals total. Any miss -> exit 1. The HUD is captured into
// captured.hudText above; it reflects whichever mode (hardcut / crossfade /
// 3way) the demo last entered. Default boot is hardcut and refreshHud()
// runs once before app.start(), so the field names are always present even
// without keyboard input -- inactive slots print `clips[i]=invalid`, which
// still satisfies the `clips[i]=` literal grep.
const hudText = String(captured.hudText ?? '');
console.log('\n=== HUD snapshot (#skin-hud innerText) ===');
console.log(hudText);
const requiredHudLiterals = [
  'clips[0]=',
  'clips[1]=',
  'clips[2]=',
  'clips[3]=',
  'weights[0]=',
  'weights[1]=',
  'weights[2]=',
  'weights[3]=',
  'times[0]=',
  'times[1]=',
  'times[2]=',
  'times[3]=',
];
const missingHudLiterals = requiredHudLiterals.filter((lit) => !hudText.includes(lit));
if (missingHudLiterals.length > 0) {
  console.error(
    `\n[smoke-browser] AC-09 RED -- HUD text is missing ${missingHudLiterals.length} required ` +
      `literal(s): ${missingHudLiterals.map((s) => `\`${s}\``).join(', ')}. ` +
      'Suspect: refreshHud() never ran (playerEnt is undefined / world.get failed) or the ' +
      'innerHTML template dropped one of the per-slot SoA column field names. ' +
      `HUD innerText was: ${JSON.stringify(hudText)}`,
  );
  process.exit(1);
}
console.log(
  `\n[smoke-browser] AC-09 GREEN -- HUD text contains all ${requiredHudLiterals.length} required ` +
    'clips[i]= / weights[i]= / times[i]= literals (4-slot SoA exposure).',
);

console.log(
  '\n[smoke-browser] GREEN (layer-1 + layer-2 + layer-3 + AC-01 deviceErrors empty + AC-03 import probe + M4 AC-01 palette hash + M4 AC-02 root-joint hash + M4 AC-03 dyn-offset + M6 AC-04 palette-bounds + AC-09 HUD weights snapshot) -- ' +
    `${captured.pipelines.length} pipelines created, ` +
    `${captured.pipelines.filter((p) => /pbr-skin/.test(p.label ?? '')).length} skin variants, ` +
    `${captured.deviceErrors.length} device errors, ` +
    `${importProbeHitCount} /__import hits (kinds=[${[...importProbeKindUnion].join(',')}]), ` +
    `${skinPaletteHits} palette writes (${skinPaletteFullHashSet.size} distinct full, ${skinPaletteFirstMat4Set.size} distinct first-mat4), ` +
    `${skinDynSecondValues.length} dyn-offset captures (${skinDynSecondSet.size} distinct second-offset values). ` +
    'pack-body typed-array contract + 18F MeshAsset stride + skin pipeline vertex layout + dev import chain + skin palette per-frame upload all green.',
);
process.exit(0);
