// Shared cubemap capture projection — Y negated for WebGPU top-left framebuffer origin.

/**
 * Build a perspective projection matrix for rendering into cubemap faces.
 * Y is negated to match WebGPU's top-left framebuffer origin (unlike OpenGL's bottom-left).
 * All cubemap passes (equirect-to-cube / irradiance / prefilter) should use this.
 */
export function cubemapCaptureProjection(fovy: number, near: number, far: number): Float32Array {
  const f = 1.0 / Math.tan(fovy / 2);
  const nf = 1.0 / (near - far);
  // biome-ignore format: manual column-major mat4
  return new Float32Array([
    f, 0, 0, 0,
    0, -f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}
