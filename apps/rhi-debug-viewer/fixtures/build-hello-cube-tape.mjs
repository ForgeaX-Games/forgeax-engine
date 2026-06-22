// build-hello-cube-tape.mjs — in-memory hello-cube tape fixture builder.
//
// The engine repo tracks NO binaries (zero-binary invariant, grep:no-binary-assets
// gate). Instead of committing frame-0.tape.bin, callers build the fixture bytes
// in-memory at test time via buildHelloCubeFixture(). Uses the official
// serializeTape + assembleReport primitives from @forgeax/engine-rhi-debug, so the
// output is byte-identical to a real browser capture of the same event stream.
//
// Returns { json, blob, report }:
//   - json   : the tape JSON string (header + events, fed to deserializeTape)
//   - blob   : the tape binary Uint8Array (blob pool; empty for this inline-WGSL tape)
//   - report : the assembled report.json object (header + events + passOffsets + valid)
//
// Consumers:
//   - src/__tests__/viewer-model.unit.test.ts (deserializeTape -> buildViewModel)
//   - scripts/smoke-browser.mjs / smoke-browser-no-webgpu.mjs (write to a temp dir
//     for playwright setInputFiles — never committed)

import {
  TAPE_FORMAT_VERSION,
  assembleReport,
  computePassOffsets,
  serializeTape,
} from '@forgeax/engine-rhi-debug';

// Minimal WGSL shader: pass-through vertex + solid-color fragment.
const vertWgsl = `
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  return vec4f(pos[idx], 0.0, 1.0);
}
`;

const fragWgsl = `
@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(0.4, 0.2, 0.6, 1.0);
}
`;

/**
 * Build a minimal valid hello-cube tape (1 render pass + 1 draw + color
 * attachment) and return its serialized json/blob plus the assembled report.
 */
export function buildHelloCubeFixture() {
  // Build a minimal tape with 1 render pass + 1 draw.
  const events = [
    // --- Resources ---
    { kind: 'createShaderModule', handleId: 'sm:vs', wgslCode: vertWgsl },
    { kind: 'createShaderModule', handleId: 'sm:fs', wgslCode: fragWgsl },
    { kind: 'createBindGroupLayout', handleId: 'bgl:1', desc: { entries: [] } },
    { kind: 'createPipelineLayout', handleId: 'pl:1', bglHandleIds: ['bgl:1'] },
    {
      kind: 'createRenderPipeline',
      handleId: 'rp:1',
      desc: {
        vertex: { module: null, entryPoint: 'vs_main', buffers: [] },
        fragment: {
          module: null,
          entryPoint: 'fs_main',
          targets: [{ format: 'bgra8unorm' }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
        multisample: { count: 1 },
      },
      layoutHandleId: 'pl:1',
      vertexShaderModuleHandleId: 'sm:vs',
      fragmentShaderModuleHandleId: 'sm:fs',
    },
    {
      kind: 'createTexture',
      handleId: 'tex:color',
      desc: {
        size: [800, 600, 1],
        format: 'bgra8unorm',
        usage: 16,
        dimension: '2d',
        mipLevelCount: 1,
        sampleCount: 1,
      },
    },
    {
      kind: 'createTextureView',
      resultHandleId: 'tv:color',
      sourceHandleId: 'tex:color',
      desc: {
        format: 'bgra8unorm',
        dimension: '2d',
        aspect: 'all',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 1,
      },
    },
    { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
    // --- Render pass ---
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'cmd:1',
      passHandleId: 'pass:1',
      desc: {
        colorAttachments: [
          {
            view: undefined,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
          },
        ],
      },
      colorAttachmentViewHandleIds: ['tv:color'],
    },
    { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'rp:1' },
    {
      kind: 'draw',
      passHandleId: 'pass:1',
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    { kind: 'endRenderPass', passHandleId: 'pass:1' },
    // --- Submit ---
    { kind: 'submit', cmdHandleIds: ['cmd:1'] },
    // --- Frame boundary ---
    { kind: 'frameMark', frameIdx: 0 },
  ];

  // wgslCode is referenced inline in createShaderModule events; serializeTape
  // does NOT store wgslCode in the blob pool, so the pool is empty for this
  // minimal tape (no buffer data blobs).
  const tape = {
    formatVersion: TAPE_FORMAT_VERSION,
    rhiCapsRecorded: {
      canvasFormat: 'bgra8unorm',
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompression: false,
      storageBuffer: false,
      timestampQuery: false,
    },
    events,
    blobPool: new Map(),
  };

  const { json, blob } = serializeTape(tape);
  const passOffsets = computePassOffsets(events);
  const report = assembleReport({ json, passOffsets, valid: true });

  return { json, blob, report };
}
