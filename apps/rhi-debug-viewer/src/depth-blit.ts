// depth-blit.ts — sample a non-copyable depth texture into an r32float RT, then read it back.
//
// WebGPU forbids copyTextureToBuffer on the DEPTH plane of depth24plus /
// depth24plus-stencil8 (the layout is driver-private). The only faithful way to
// read those real depth values is to SAMPLE the depth texture (textureLoad on a
// texture_depth_2d view) and write the value into a copyable r32float render
// target, then read that back. Format is never changed — replay fidelity intact.
//
// The replayer promotes TEXTURE_BINDING onto depth-format textures
// (replayer.ts replayCreateTexture) so the live depth texture is sampleable here.
//
// Mirrors the mipmap-generator fullscreen-blit pattern (packages/runtime) and the
// SSAO depth-only-view idiom (render-graph-primitives.ts): a depth+stencil texture
// needs an explicit aspect:'depth-only' view or dawn rejects the multi-aspect default.
//
// Related: plan depth+stencil preview; reuses readbackTexturePixels (rhi-debug).

/// <reference types="@webgpu/types" />

import type { RhiDevice } from '@forgeax/engine-rhi';
import type { CreateShaderModuleFn } from '@forgeax/engine-rhi-debug';
import { readbackTexturePixels } from '@forgeax/engine-rhi-debug';

// GPUShaderStage.FRAGMENT = 0x2; GPUTextureUsage RENDER_ATTACHMENT=0x10, COPY_SRC=0x01.
const FRAGMENT_STAGE = 0x2;
const RT_USAGE_RENDER_ATTACHMENT_COPY_SRC = 0x10 | 0x01;

// Fullscreen-triangle VS + FS that reads the depth value at the fragment's integer
// pixel coords via textureLoad (no sampler needed; returns f32) and writes it into
// the r32float target's red channel. Idiom: textureLoad(shadowMap, coord, 0).
const DEPTH_BLIT_WGSL = /* wgsl */ `
@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(-1.0,  3.0),
    vec2<f32>( 3.0, -1.0),
  );
  return vec4<f32>(pos[vid], 0.0, 1.0);
}

@group(0) @binding(0) var depthTex : texture_depth_2d;

@fragment
fn fs_main(@builtin(position) fragCoord : vec4<f32>) -> @location(0) vec4<f32> {
  let d : f32 = textureLoad(depthTex, vec2<i32>(fragCoord.xy), 0);
  return vec4<f32>(d, 0.0, 0.0, 1.0);
}
`;

/**
 * Sample a (recreated, live) depth texture into an r32float RT and read it back
 * as a tight Float32Array of raw depth values (length = width*height).
 *
 * @param device - The replay RhiDevice (depth texture must have TEXTURE_BINDING).
 * @param createShaderModuleFn - Standalone shader compiler (from rhi-webgpu).
 * @param depthTexture - The live depth GPUTexture (opaque handle) to sample.
 * @param width - Texture width.
 * @param height - Texture height.
 * @param baseArrayLayer - Array layer (slice) to sample; 0 for a plain 2D depth
 *   texture, `layer*6 + face` for a cube/cube-array shadow atlas.
 * @returns Raw depth values as a tight Float32Array. Throws on GPU failure.
 */
export async function blitDepthToR32(
  device: RhiDevice,
  createShaderModuleFn: CreateShaderModuleFn,
  depthTexture: unknown,
  width: number,
  height: number,
  baseArrayLayer = 0,
): Promise<Float32Array> {
  // A depth+stencil texture's default view selects both aspects, which dawn
  // rejects for a sampled binding — request an explicit depth-only 2D view of the
  // single selected array layer (cube/array slices are sampled one at a time).
  const depthViewRes = device.createTextureView(depthTexture as never, {
    label: 'depth-blit-src-view',
    dimension: '2d',
    aspect: 'depth-only',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer,
    arrayLayerCount: 1,
  });
  if (!depthViewRes.ok) {
    throw new Error(`depth-blit: createTextureView failed: ${depthViewRes.error.code}`);
  }

  const rtRes = device.createTexture({
    label: 'depth-blit-r32-rt',
    size: { width, height, depthOrArrayLayers: 1 },
    format: 'r32float' as GPUTextureFormat,
    usage: RT_USAGE_RENDER_ATTACHMENT_COPY_SRC,
  });
  if (!rtRes.ok) throw new Error(`depth-blit: createTexture(r32) failed: ${rtRes.error.code}`);
  const rt = rtRes.value;

  try {
    const rtViewRes = device.createTextureView(rt as never, { label: 'depth-blit-r32-view' });
    if (!rtViewRes.ok) throw new Error(`depth-blit: r32 view failed: ${rtViewRes.error.code}`);

    const moduleRes = await createShaderModuleFn(device, {
      code: DEPTH_BLIT_WGSL,
      label: 'depth-blit-wgsl',
    });
    if (!moduleRes.ok) throw new Error(`depth-blit: shader failed: ${moduleRes.error.code}`);
    const module = moduleRes.value;

    const bglRes = device.createBindGroupLayout({
      label: 'depth-blit-bgl',
      entries: [
        {
          binding: 0,
          visibility: FRAGMENT_STAGE,
          texture: { sampleType: 'depth', viewDimension: '2d' },
        },
      ],
    });
    if (!bglRes.ok) throw new Error(`depth-blit: bgl failed: ${bglRes.error.code}`);

    const bgRes = device.createBindGroup({
      label: 'depth-blit-bg',
      layout: bglRes.value,
      entries: [{ binding: 0, resource: { kind: 'textureView', value: depthViewRes.value } }],
    } as never);
    if (!bgRes.ok) throw new Error(`depth-blit: bindgroup failed: ${bgRes.error.code}`);

    const plRes = device.createPipelineLayout({
      label: 'depth-blit-pl',
      bindGroupLayouts: [bglRes.value],
    });
    if (!plRes.ok) throw new Error(`depth-blit: pipeline layout failed: ${plRes.error.code}`);

    const pipeRes = device.createRenderPipeline({
      label: 'depth-blit-pipeline',
      layout: plRes.value,
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'r32float' }] },
      primitive: { topology: 'triangle-list' },
    } as never);
    if (!pipeRes.ok) throw new Error(`depth-blit: pipeline failed: ${pipeRes.error.code}`);

    const encRes = device.createCommandEncoder({});
    if (!encRes.ok) throw new Error(`depth-blit: encoder failed: ${encRes.error.code}`);
    const enc = encRes.value;
    const pass = enc.beginRenderPass({
      label: 'depth-blit-pass',
      colorAttachments: [
        {
          view: rtViewRes.value as never,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as never);
    pass.setPipeline(pipeRes.value as never);
    pass.setBindGroup(0, bgRes.value as never, []);
    pass.draw(3, 1, 0, 0);
    pass.end();
    const fin = enc.finish();
    if (!fin.ok) throw new Error(`depth-blit: finish failed: ${fin.error.code}`);
    device.queue.submit([fin.value as unknown as never] as unknown as readonly never[]);
    await device.queue.onSubmittedWorkDone();

    // r32float is 4 bytes/texel; readback returns tight RGBA-byte-order rows.
    const bytes = await readbackTexturePixels(device, rt, width, height, { bytesPerTexel: 4 });
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  } finally {
    device.destroyTexture(rt);
  }
}
