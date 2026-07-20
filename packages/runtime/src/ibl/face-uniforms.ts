// face-uniforms.ts -- M3.5 t55.
//
// CPU-side helpers that allocate + populate the per-face viewProj uniform
// buffer (6 entries) and the per-prefilter-sub-pass roughness uniform
// buffer (5 mip x 6 face = 30 entries). Both are 256-byte stride to honour
// the WebGPU dynamic-offset alignment SSOT (plan-strategy section 3.2
// sequence diagram, D-9 face-uniforms layout cross-pipeline reuse).
//
// The buffer payloads are:
//   faceUniforms[face]      = mat4x4<f32> viewProj  (64 byte usable; 256 byte stride)
//   prefilterUniforms[idx]  = { roughness: f32, faceSize: f32, _pad0, _pad1 }
//                             (16 byte usable; 256 byte stride)
//
// Indexed as:
//   face       = 0..5
//   prefilter  = mip * 6 + face   (mip 0..4, face 0..5)

import { CAPTURE_VIEW_PROJS, PREFILTER_MIP_LEVELS, PREFILTER_SIZE } from './IblPipelineCache';

const DYNAMIC_OFFSET_STRIDE = 256;
const FACE_COUNT = 6;
const PREFILTER_SUBPASS_COUNT = PREFILTER_MIP_LEVELS * FACE_COUNT;

const GPU_BUFFER_USAGE_UNIFORM = 0x40;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;

/**
 * Minimal device shape consumed by the helpers -- mirrors
 * `IblPipelineDevice` createBuffer surface plus queue.writeBuffer.
 */
export interface FaceUniformsDevice {
  // biome-ignore lint/suspicious/noExplicitAny: shim shape
  createBuffer(desc: any): { ok: true; value: any } | { ok: false; error: unknown };
  readonly queue: {
    // biome-ignore lint/suspicious/noExplicitAny: shim shape
    writeBuffer?: (...args: any[]) => unknown;
  };
}

/**
 * Allocate the 6-face viewProj uniform buffer. Size = 6 * 256 bytes so
 * each face slot is dynamic-offset addressable.
 */
export function createFaceUniformsBuffer(
  device: FaceUniformsDevice,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU buffer
): { ok: true; value: any } | { ok: false; error: unknown } {
  return device.createBuffer({
    label: 'ibl-face-uniforms',
    size: FACE_COUNT * DYNAMIC_OFFSET_STRIDE,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
}

/**
 * Allocate the prefilter sub-pass uniform buffer. Size = 30 * 256 bytes.
 */
export function createPrefilterUniformsBuffer(
  device: FaceUniformsDevice,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU buffer
): { ok: true; value: any } | { ok: false; error: unknown } {
  return device.createBuffer({
    label: 'ibl-prefilter-uniforms',
    size: PREFILTER_SUBPASS_COUNT * DYNAMIC_OFFSET_STRIDE,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
}

/**
 * Write a single face's viewProj matrix at the dynamic-offset slot.
 *
 * @param device device with queue.writeBuffer
 * @param buffer face-uniforms buffer from createFaceUniformsBuffer
 * @param faceIdx 0..5
 * @param viewProj 16-element column-major mat4
 */
export function writeFaceUniforms(
  device: FaceUniformsDevice,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU buffer
  buffer: any,
  faceIdx: number,
  viewProj: Float32Array,
): void {
  if (typeof device.queue.writeBuffer !== 'function') return;
  if (faceIdx < 0 || faceIdx >= FACE_COUNT) {
    throw new Error(`writeFaceUniforms: faceIdx ${faceIdx} out of range [0,5]`);
  }
  if (viewProj.length !== 16) {
    throw new Error(`writeFaceUniforms: viewProj must be 16 floats, got ${viewProj.length}`);
  }
  device.queue.writeBuffer(buffer, faceIdx * DYNAMIC_OFFSET_STRIDE, viewProj);
}

/**
 * Write all 6 capture viewProj matrices into the face-uniforms buffer.
 * Uses the static CAPTURE_VIEW_PROJS SSOT from IblPipelineCache.
 */
export function writeAllFaceUniforms(
  device: FaceUniformsDevice,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU buffer
  buffer: any,
): void {
  for (let face = 0; face < FACE_COUNT; face++) {
    const vp = CAPTURE_VIEW_PROJS[face];
    if (vp === undefined) continue;
    writeFaceUniforms(device, buffer, face, vp);
  }
}

/**
 * Write a single prefilter sub-pass uniform slot (roughness + faceSize).
 * subPassIdx = mip * 6 + face.
 */
export function writePrefilterUniforms(
  device: FaceUniformsDevice,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU buffer
  buffer: any,
  subPassIdx: number,
  roughness: number,
  mipFaceSize: number,
): void {
  if (typeof device.queue.writeBuffer !== 'function') return;
  if (subPassIdx < 0 || subPassIdx >= PREFILTER_SUBPASS_COUNT) {
    throw new Error(`writePrefilterUniforms: subPassIdx ${subPassIdx} out of range`);
  }
  const payload = new Float32Array([roughness, mipFaceSize, 0, 0]);
  device.queue.writeBuffer(buffer, subPassIdx * DYNAMIC_OFFSET_STRIDE, payload);
}

/**
 * Write all 30 prefilter sub-pass uniforms (5 mip x 6 face) with
 * roughness = mip / (mipLevels - 1) and mipFaceSize halved per mip.
 */
export function writeAllPrefilterUniforms(
  device: FaceUniformsDevice,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU buffer
  buffer: any,
): void {
  for (let mip = 0; mip < PREFILTER_MIP_LEVELS; mip++) {
    const roughness = mip / (PREFILTER_MIP_LEVELS - 1);
    const mipFaceSize = PREFILTER_SIZE / 2 ** mip;
    for (let face = 0; face < FACE_COUNT; face++) {
      writePrefilterUniforms(device, buffer, mip * FACE_COUNT + face, roughness, mipFaceSize);
    }
  }
}

export const FACE_UNIFORMS_STRIDE = DYNAMIC_OFFSET_STRIDE;
export const FACE_UNIFORMS_BUFFER_SIZE = FACE_COUNT * DYNAMIC_OFFSET_STRIDE;
export const PREFILTER_UNIFORMS_BUFFER_SIZE = PREFILTER_SUBPASS_COUNT * DYNAMIC_OFFSET_STRIDE;
