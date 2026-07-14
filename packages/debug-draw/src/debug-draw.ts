// @forgeax/engine-debug-draw -- DebugDraw class implementation (feat-20260615-debug-draw M2)
//
// This file is the single SSOT for DebugDraw class, GPU resource lifecycle,
// flush, and destroy semantics.
//
// Decision anchors:
// - plan-strategy D-2: depthMode single-instance single-PSO
// - plan-strategy D-3: inline WGSL, direct RHI (no ShaderRegistry)
// - plan-strategy D-4: queue.writeBuffer overwrite + double-resize + hard-cap truncate
// - plan-strategy D-9: vertex stride 16 B (12 B position + 4 B color)
// - plan-strategy D-11: destroy-after-shape = no-op + single warn

import type { ColorLike, Mat4, Vec3 } from '@forgeax/engine-math';
import type {
  BindGroup,
  Buffer,
  RenderPipeline,
  RhiCommandEncoder,
  RhiDevice,
  TextureView,
} from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { INITIAL_VERTEX_CAPACITY, MAX_VERTEX_CAPACITY, VERTEX_STRIDE_BYTES } from './constants';
import type { DebugDrawError } from './errors';
import {
  bufferAllocationFailed,
  flushedAfterDestroy,
  pipelineCreateFailed,
  viewProjRequired,
} from './errors';
import { aabbVertices } from './shapes/aabb';
import { arrowVertices } from './shapes/arrow';
import { axesArrowSets } from './shapes/axes';
import { frustumVertices } from './shapes/frustum';
import { lineVertices } from './shapes/line';
import { sphereVertices } from './shapes/sphere';
import type { DebugDraw as DebugDrawInterface, DebugDrawOptions } from './types';

// ==========================================================================
// Inline WGSL (plan-strategy D-3: no ShaderRegistry dependency)
// ==========================================================================

const VERTEX_SHADER = /* wgsl */ `
struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}

struct Uniforms {
  viewProj: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4<f32>(in.position, 1.0);
  out.color = in.color;
  return out;
}
`;

const FRAGMENT_SHADER = /* wgsl */ `
struct FragmentInput {
  @location(0) color: vec4<f32>,
}

@fragment
fn fs_main(in: FragmentInput) -> @location(0) vec4<f32> {
  return in.color;
}
`;

// ==========================================================================
// Internal helpers
// ==========================================================================

/** Access Vec3/Mat4/ColorLike array element, narrow via `as number`. */
function at(a: { readonly [index: number]: number }, i: number): number {
  return a[i] as number;
}

// ==========================================================================
// DebugDraw (w12 / w13 / w14)
// ==========================================================================

export class DebugDraw implements DebugDrawInterface {
  private stagingArr: Float32Array;
  private stagingLen = 0;

  private capVal: number;

  private gpuVbo: Buffer | null = null;

  private gpuPipeline: RenderPipeline | null = null;

  private gpuUniformBuffer: Buffer | null = null;

  private gpuBindGroup: BindGroup | null = null;

  private maxCapVal: number;

  private readonly rhiDevice: RhiDevice;

  private isDestroyed = false;

  // Whether the destroy-after-shape warning has been emitted (plan-strategy D-11).
  // private (no underscore, no @internal) — purely class-internal state, not part of
  // package-internal API surface. Biome R-internal-A forbids `_x` on private fields;
  // lint:internal R-internal-C requires `_x` for `@internal`. Drop both markers since
  // there is no package-internal use for this field — accessing it from outside the
  // class is meaningless.
  private destroyedWarnedOnce = false;

  /**
   * Depth texture view for less-equal depth mode.
   * Set via {@link _setDepthView} before flush() when depthMode is 'less-equal'.
   * The runtime auto-attach path receives depth from the render-graph context;
   * low-path callers (test harnesses, smoke runners) set this explicitly.
   */
  private depthView: TextureView | null = null;

  constructor(
    device: RhiDevice,
    pipeline: RenderPipeline,
    vbo: Buffer,
    uniformBuffer: Buffer,
    bindGroup: BindGroup,
    initialCapacity: number,
    maxCapacity: number,
  ) {
    this.rhiDevice = device;
    this.gpuPipeline = pipeline;
    this.gpuVbo = vbo;
    this.gpuUniformBuffer = uniformBuffer;
    this.gpuBindGroup = bindGroup;
    this.capVal = initialCapacity;
    this.maxCapVal = maxCapacity;
    this.stagingArr = new Float32Array(initialCapacity * (VERTEX_STRIDE_BYTES / 4));
  }

  /** @internal CPU staging vertex count (exposed for unit tests). */
  get _stagingVertexCount(): number {
    return this.stagingLen;
  }

  /** @internal Current GPU vertex buffer capacity in vertex count. */
  get _capacity(): number {
    return this.capVal;
  }

  /** @internal Whether destroy() has been called. */
  get _destroyed(): boolean {
    return this.isDestroyed;
  }

  /**
   * @internal Set the depth texture view for less-equal depth mode.
   * Required before flush() when depthMode is 'less-equal'.
   * Used by test harnesses and smoke runners that don't have a scene
   * depth buffer; the runtime auto-attach path receives depth from
   * the render-graph context.
   */
  _setDepthView(view: TextureView): void {
    this.depthView = view;
  }

  /** @internal Read position of vertex at `index` in CPU staging (for unit tests). */
  _getVertexPosition(index: number): [number, number, number] {
    const idx = index * 4;
    return [
      this.stagingArr[idx + 0] as number,
      this.stagingArr[idx + 1] as number,
      this.stagingArr[idx + 2] as number,
    ];
  }

  /** @internal Read color of vertex at `index` as packed u32 (for unit tests). */
  _getVertexPackedColor(index: number): number {
    const byteOff = index * VERTEX_STRIDE_BYTES + 12;
    const bytes = new Uint8Array(this.stagingArr.buffer, byteOff, 4);
    return (
      ((bytes[3] as number) << 24) |
      ((bytes[2] as number) << 16) |
      ((bytes[1] as number) << 8) |
      (bytes[0] as number)
    );
  }

  private postDestroyWarnOnce(): void {
    if (!this.destroyedWarnedOnce) {
      this.destroyedWarnedOnce = true;
      console.warn(
        '[DebugDraw] Shape call after destroy() is a no-op. ' +
          'Create a new instance via createDebugDraw().',
      );
    }
  }

  private pushVertex(
    px: number,
    py: number,
    pz: number,
    rc: number,
    gc: number,
    bc: number,
    ac: number,
  ): void {
    if (this.isDestroyed) {
      this.postDestroyWarnOnce();
      return;
    }

    // Truncation: silently drop vertices above max cap (warned once in ensureCapacity)
    if (this.stagingLen >= this.maxCapVal) return;

    const idx = this.stagingLen * 4; // 4 f32s per vertex (stride=16B)
    this.stagingArr[idx + 0] = px;
    this.stagingArr[idx + 1] = py;
    this.stagingArr[idx + 2] = pz;

    // Write RGBA as u8 bytes via Uint8Array view (Float32Array would
    // corrupt u32 bit-patterns via f32 conversion; the GPU reads raw bytes).
    const u8r = Math.round(Math.max(0, Math.min(1, rc)) * 255);
    const u8g = Math.round(Math.max(0, Math.min(1, gc)) * 255);
    const u8bc = Math.round(Math.max(0, Math.min(1, bc)) * 255);
    const u8a = Math.round(Math.max(0, Math.min(1, ac)) * 255);
    const byteOff = this.stagingLen * VERTEX_STRIDE_BYTES + 12;
    const colorView = new Uint8Array(this.stagingArr.buffer, byteOff, 4);
    colorView[0] = u8r;
    colorView[1] = u8g;
    colorView[2] = u8bc;
    colorView[3] = u8a;

    this.stagingLen++;
  }

  private ensureCapacity(needed: number): void {
    if (this.isDestroyed) return;
    if (needed <= this.capVal) return;

    // Warn for hard-cap truncation (once, before any vertex drops)
    if (needed > this.maxCapVal) {
      console.warn(
        `[DebugDraw] Vertex count would exceed MAX_VERTEX_CAPACITY=${this.maxCapVal}; ` +
          'vertices beyond the limit are discarded.',
      );
    }

    // Double up to max cap
    let newCap = this.capVal;
    while (newCap < needed && newCap < this.maxCapVal) {
      newCap = Math.min(newCap * 2, this.maxCapVal);
    }

    if (newCap > this.capVal) {
      // Bug B fix (feat-20260626 m6-4): the GPU vertex buffer must grow with the
      // CPU staging, or flush() binds a buffer too small for the staged vertex
      // count and the backend rejects the draw ("Vertex range requires a larger
      // buffer than the bound buffer size"). This was latent until the overlay
      // pass actually flushed -- before the glue merge the pass was a no-op stub,
      // so the GPU vbo was never bound past its initial size. Reallocate at the
      // new size + destroy the old; on alloc failure keep the old cap (the draw
      // stays bounded + correct, just truncated) rather than growing the staging
      // past the GPU buffer.
      const newVbo = this.rhiDevice.createBuffer({
        size: newCap * VERTEX_STRIDE_BYTES,
        usage: 8 | 32, // COPY_DST | VERTEX (mirrors createDebugDraw factory)
        label: 'debug-draw-vbo',
      });
      if (!newVbo.ok) {
        console.warn(
          `[DebugDraw] GPU vertex buffer grow to ${newCap} failed (${newVbo.error.code}); ` +
            `keeping ${this.capVal} -- excess vertices are truncated this frame.`,
        );
        return;
      }
      console.warn(`[DebugDraw] Resizing vertex buffer from ${this.capVal} to ${newCap} vertices.`);
      if (this.gpuVbo !== null) this.rhiDevice.destroyBuffer(this.gpuVbo);
      this.gpuVbo = newVbo.value;
      this.capVal = newCap;
      const newStaging = new Float32Array(newCap * (VERTEX_STRIDE_BYTES / 4));
      newStaging.set(this.stagingArr.subarray(0, this.stagingLen * 4));
      this.stagingArr = newStaging;
    }
  }

  private colorToRGBA(color: ColorLike): [number, number, number, number] {
    if (Array.isArray(color)) {
      return [at(color, 0), at(color, 1), at(color, 2), (color as number[])[3] ?? 1];
    }
    // Float32Array (branded Color or plain)
    return [at(color, 0), at(color, 1), at(color, 2), color[3] ?? 1];
  }

  // -- Public shape API --

  line(a: Vec3, b: Vec3, color: ColorLike): void {
    if (this.isDestroyed) {
      this.postDestroyWarnOnce();
      return;
    }
    const [r, g, bc, alpha] = this.colorToRGBA(color);
    this.ensureCapacity(this.stagingLen + 2);
    for (const [x, y, z] of lineVertices(a, b)) {
      this.pushVertex(x, y, z, r, g, bc, alpha);
    }
  }

  aabb(min: Vec3, max: Vec3, color: ColorLike): void {
    if (this.isDestroyed) {
      this.postDestroyWarnOnce();
      return;
    }
    const [r, g, bc, alpha] = this.colorToRGBA(color);
    const verts = aabbVertices(min, max);
    this.ensureCapacity(this.stagingLen + verts.length);
    for (const [x, y, z] of verts) {
      this.pushVertex(x, y, z, r, g, bc, alpha);
    }
  }

  sphere(center: Vec3, radius: number, color: ColorLike, segments = 16): void {
    if (this.isDestroyed) {
      this.postDestroyWarnOnce();
      return;
    }
    const [r, g, bc, alpha] = this.colorToRGBA(color);
    const verts = sphereVertices(center, radius, segments);
    this.ensureCapacity(this.stagingLen + verts.length);
    for (const [x, y, z] of verts) {
      this.pushVertex(x, y, z, r, g, bc, alpha);
    }
  }

  frustum(viewProj: Mat4, color: ColorLike): void {
    if (this.isDestroyed) {
      this.postDestroyWarnOnce();
      return;
    }
    const verts = frustumVertices(viewProj);
    if (verts === null) {
      console.warn(
        '[DebugDraw] frustum() received a near-singular viewProj matrix; skipping this frame.',
      );
      return;
    }
    const [r, g, bc, alpha] = this.colorToRGBA(color);
    this.ensureCapacity(this.stagingLen + verts.length);
    for (const [x, y, z] of verts) {
      this.pushVertex(x, y, z, r, g, bc, alpha);
    }
  }

  arrow(start: Vec3, end: Vec3, color: ColorLike, tipLength?: number): void {
    if (this.isDestroyed) {
      this.postDestroyWarnOnce();
      return;
    }
    const [r, g, bc, alpha] = this.colorToRGBA(color);
    const verts = arrowVertices(start, end, tipLength);
    this.ensureCapacity(this.stagingLen + verts.length);
    for (const [x, y, z] of verts) {
      this.pushVertex(x, y, z, r, g, bc, alpha);
    }
  }

  axes(worldMat: Mat4, length: number): void {
    if (this.isDestroyed) {
      this.postDestroyWarnOnce();
      return;
    }
    // Three arrows (X=red, Y=green, Z=blue) along the transform's local axes; each
    // carries its own color, so they cannot share the single-color push path.
    for (const { vertices, color } of axesArrowSets(worldMat, length)) {
      const [r, g, bc, alpha] = this.colorToRGBA(color as unknown as ColorLike);
      this.ensureCapacity(this.stagingLen + vertices.length);
      for (const [x, y, z] of vertices) {
        this.pushVertex(x, y, z, r, g, bc, alpha);
      }
    }
  }

  // -- flush (w13) --

  flush(
    encoder: RhiCommandEncoder,
    view: TextureView,
    viewProj: Mat4,
  ): Result<void, DebugDrawError> {
    if (this.isDestroyed) {
      return flushedAfterDestroy();
    }

    if (viewProj === undefined || viewProj === null) {
      return viewProjRequired();
    }

    if (this.stagingLen === 0) {
      return ok(undefined as void);
    }

    const vertexCount = Math.min(this.stagingLen, this.maxCapVal);

    // Truncation warning (already warned in ensureCapacity, but double-check at flush)
    if (this.stagingLen > this.maxCapVal) {
      console.warn(
        `[DebugDraw] Flush truncated: ${this.stagingLen} vertices staged, ` +
          `only ${this.maxCapVal} flushed (MAX_VERTEX_CAPACITY).`,
      );
    }

    // Narrow nullable GPU resources for this call site
    const vbo = this.gpuVbo as Buffer;
    const pipeline = this.gpuPipeline as RenderPipeline;
    const uniformBuf = this.gpuUniformBuffer as Buffer;
    const bindGroup = this.gpuBindGroup as BindGroup;

    // Upload staging to GPU via writeBuffer
    const byteCount = vertexCount * VERTEX_STRIDE_BYTES;
    this.rhiDevice.queue.writeBuffer(
      vbo,
      0,
      new Uint8Array(this.stagingArr.buffer, 0, byteCount),
      0,
      byteCount,
    );

    // Upload viewProj uniform (mat4x4<f32> = 64 bytes)
    const uniformData = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
      uniformData[i] = viewProj[i] as number;
    }
    this.rhiDevice.queue.writeBuffer(uniformBuf, 0, new Uint8Array(uniformData.buffer), 0, 64);

    // Begin render pass with loadOp='load' to preserve scene content.
    // forgeax TextureView is an opaque RHI handle; the underlying WebGPU
    // GPURenderPassDescriptor expects raw GPUTextureView.
    // When depthMode is 'less-equal', a depthStencilAttachment is required
    // matching the PSO's depth format. The caller must provide depthView
    // for less-equal mode; without it, the render pass will fail validation.
    // biome-ignore lint/suspicious/noExplicitAny: opaque RHI descriptor (color + optional depth)
    const passDesc: Record<string, any> = {
      colorAttachments: [
        {
          // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
          view: view as any,
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    };
    if (this.depthView !== null) {
      passDesc.depthStencilAttachment = {
        // biome-ignore lint/suspicious/noExplicitAny: opaque depth view
        view: this.depthView as any,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      };
    }
    // biome-ignore lint/suspicious/noExplicitAny: opaque RHI descriptor
    const pass = encoder.beginRenderPass(passDesc as any);

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vbo);
    pass.draw(vertexCount);
    pass.end();

    // Reset staging for next frame
    this.stagingLen = 0;

    return ok(undefined as void);
  }

  // -- destroy (w14) --

  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    if (this.gpuVbo) {
      this.rhiDevice.destroyBuffer(this.gpuVbo);
      this.gpuVbo = null;
    }
    if (this.gpuUniformBuffer) {
      this.rhiDevice.destroyBuffer(this.gpuUniformBuffer);
      this.gpuUniformBuffer = null;
    }
    // BindGroup / Pipeline: WebGPU spec destroys them when the JS reference is lost;
    // we null them to drop GPU resource references.
    this.gpuBindGroup = null;
    this.gpuPipeline = null;
    this.stagingArr = new Float32Array(0);
    this.stagingLen = 0;
  }
}

// ==========================================================================
// createDebugDraw factory (w12)
// ==========================================================================

export async function createDebugDraw(
  opts: DebugDrawOptions,
): Promise<Result<DebugDraw, DebugDrawError>> {
  const device = opts.device;
  const fmt: string = opts.format ?? 'bgra8unorm';
  const depthFormat = opts.depthFormat;
  const depthMode = opts.depthMode ?? 'always';
  const initialCap = opts.initialVertexCapacity ?? INITIAL_VERTEX_CAPACITY;
  const maxCap = opts.maxVertexCapacity ?? MAX_VERTEX_CAPACITY;

  // Allocate GPU vertex buffer
  // GPUBufferUsage.COPY_DST=8, VERTEX=32
  const vboByteSize = initialCap * VERTEX_STRIDE_BYTES;
  const vboResult = device.createBuffer({
    size: vboByteSize,
    usage: 8 | 32, // COPY_DST | VERTEX
    label: 'debug-draw-vbo',
  });
  if (!vboResult.ok) {
    return bufferAllocationFailed(
      `createBuffer(COPY_DST|VERTEX, ${vboByteSize}B): ${vboResult.error.code}`,
    );
  }
  const vbo = vboResult.value;

  // Allocate uniform buffer for viewProj (mat4x4<f32> = 64 bytes)
  // GPUBufferUsage.UNIFORM=64 (0x0040), COPY_DST=8 (0x0008)
  const uniformBufResult = device.createBuffer({
    size: 64,
    usage: 64 | 8, // UNIFORM | COPY_DST
    label: 'debug-draw-uniform',
  });
  if (!uniformBufResult.ok) {
    device.destroyBuffer(vbo);
    return bufferAllocationFailed(
      `createBuffer(UNIFORM|COPY_DST, 64B): ${uniformBufResult.error.code}`,
    );
  }
  const uniformBuf = uniformBufResult.value;

  // Compile WGSL shader modules via injected factory
  const vsResult = await opts.createShaderModule(device, {
    label: 'debug-draw-vs',
    code: VERTEX_SHADER,
  });
  if (!vsResult.ok) {
    device.destroyBuffer(vbo);
    return pipelineCreateFailed(`createShaderModule(vertex): ${vsResult.error.code}`);
  }
  const vsModule = vsResult.value;

  const fsResult = await opts.createShaderModule(device, {
    label: 'debug-draw-fs',
    code: FRAGMENT_SHADER,
  });
  if (!fsResult.ok) {
    device.destroyBuffer(vbo);
    return pipelineCreateFailed(`createShaderModule(fragment): ${fsResult.error.code}`);
  }
  const fsModule = fsResult.value;

  // Build render pipeline descriptor.
  // For 'always' mode: no depthStencil — the overlay draws on top regardless of depth.
  // For 'less-equal' mode: depthStencil included so the overlay respects scene depth.
  const depthStencil: GPUDepthStencilState | undefined =
    depthMode === 'less-equal'
      ? {
          format: (depthFormat ?? 'depth24plus') as GPUTextureFormat,
          depthWriteEnabled: false,
          depthCompare: 'less-equal',
        }
      : undefined;

  const vertexBuffers: GPUVertexBufferLayout[] = [
    {
      arrayStride: VERTEX_STRIDE_BYTES,
      stepMode: 'vertex',
      attributes: [
        {
          format: 'float32x3' as GPUVertexFormat,
          offset: 0,
          shaderLocation: 0,
        },
        {
          format: 'unorm8x4' as GPUVertexFormat,
          offset: 12,
          shaderLocation: 1,
        },
      ],
    },
  ];

  const pipelineDesc = {
    label: 'debug-draw-pso',
    layout: 'auto',
    vertex: {
      module: vsModule,
      entryPoint: 'vs_main',
      buffers: [...vertexBuffers],
    },
    primitive: {
      topology: 'line-list' as GPUPrimitiveTopology,
    },
    depthStencil,
    fragment: {
      module: fsModule,
      entryPoint: 'fs_main',
      targets: [{ format: fmt as GPUTextureFormat }],
    },
  };

  /* biome-ignore lint/suspicious/noExplicitAny: forgeax ShaderModule / TextureFormat
     are opaque RHI handles; underlying WebGPU descriptor expects raw GPU types. */
  const psoResult = device.createRenderPipeline(pipelineDesc as any);
  if (!psoResult.ok) {
    device.destroyBuffer(vbo);
    device.destroyBuffer(uniformBuf);
    return pipelineCreateFailed(`createRenderPipeline: ${psoResult.error.code}`);
  }
  const pipeline = psoResult.value;

  // Get the auto-generated bind group layout and create bind group
  // biome-ignore lint/suspicious/noExplicitAny: forgeax PipelineLayout getBindGroupLayout
  const bglResult = (pipeline as any).getBindGroupLayout(0);
  if (!bglResult) {
    device.destroyBuffer(vbo);
    device.destroyBuffer(uniformBuf);
    return pipelineCreateFailed('getBindGroupLayout(0) returned null — auto layout failed');
  }
  const bgResult = device.createBindGroup({
    layout: bglResult,
    entries: [
      {
        binding: 0,
        resource: {
          kind: 'buffer' as const,
          value: { buffer: uniformBuf, offset: 0, size: 64 },
        },
      },
    ],
    label: 'debug-draw-bindgroup',
    // biome-ignore lint/suspicious/noExplicitAny: forgeax opaque BGL -> createBindGroup descriptor
  } as any);
  if (!bgResult.ok) {
    device.destroyBuffer(vbo);
    device.destroyBuffer(uniformBuf);
    return pipelineCreateFailed(`createBindGroup: ${bgResult.error.code}`);
  }

  return ok(new DebugDraw(device, pipeline, vbo, uniformBuf, bgResult.value, initialCap, maxCap));
}
