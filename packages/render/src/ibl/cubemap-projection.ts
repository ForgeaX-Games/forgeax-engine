// Shared cubemap capture projection — Y negated for WebGPU top-left framebuffer origin.

/** The canonical diffuse IBL payload stores irradiance as E times pi. */
export const IBL_DIFFUSE_PAYLOAD_SEMANTIC = 'irradianceEOverPi' as const;
export type IblDiffusePayloadSemantic = typeof IBL_DIFFUSE_PAYLOAD_SEMANTIC;

export interface IblCapabilityReport {
  readonly capabilityStatus: 'supported' | 'degraded';
  readonly executionStatus: 'notExecuted' | 'complete';
  readonly verdict: 'failed' | 'passed';
  readonly rgba16floatRenderable: boolean;
  readonly outputFormat: 'rgba16float' | null;
  readonly fallbackArtifact: 'white-cube' | null;
  readonly expectedImpact: string;
  readonly hint: string;
}

export function describeIblCapability(input: {
  readonly rgba16floatRenderable: boolean;
}): IblCapabilityReport {
  if (input.rgba16floatRenderable) {
    return {
      capabilityStatus: 'supported',
      executionStatus: 'complete',
      verdict: 'passed',
      rgba16floatRenderable: true,
      outputFormat: 'rgba16float',
      fallbackArtifact: null,
      expectedImpact: 'HDR IBL irradiance and specular lighting execute normally',
      hint: 'capture the named rgba16float producer attachment for raw evidence',
    };
  }
  return {
    capabilityStatus: 'degraded',
    executionStatus: 'notExecuted',
    verdict: 'failed',
    rgba16floatRenderable: false,
    outputFormat: null,
    fallbackArtifact: 'white-cube',
    expectedImpact: 'HDR IBL producer execution is unavailable; lighting cannot be calibrated',
    hint: 'inspect rgba16floatRenderable and restore HDR capability before retrying the IBL case',
  };
}

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
