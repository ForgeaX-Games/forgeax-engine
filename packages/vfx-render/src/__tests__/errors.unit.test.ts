import {
  createParticleRenderError,
  PARTICLE_RENDER_ERROR_CODES,
  type ParticleRenderError,
  type ParticleRenderErrorCode,
} from '@forgeax/engine-vfx-render';
import { describe, expect, it } from 'vitest';

const details = {
  'particle-render-material-not-ready': { assetGuid: 'material-guid' },
  'particle-render-mesh-not-ready': { assetGuid: 'mesh-guid' },
  'particle-render-type-mismatch': { expectedKind: 'mesh', actualKind: 'billboard' },
  'particle-render-executor-missing': { operator: 'update:gravity:v1' },
  'particle-render-camera-unavailable': { owner: 0 },
  'particle-render-bucket-invalid': { bucket: 'world:billboard:material' },
  'particle-render-prepared-generation-mismatch': { expectedGeneration: 2, actualGeneration: 1 },
  'particle-render-device-lost': { generation: 1 },
  'particle-render-feature-failed': { stage: 'contribute' },
} as const satisfies Record<ParticleRenderErrorCode, object>;

function makeError(code: ParticleRenderErrorCode): ParticleRenderError {
  switch (code) {
    case 'particle-render-material-not-ready':
      return createParticleRenderError(code, details[code]);
    case 'particle-render-mesh-not-ready':
      return createParticleRenderError(code, details[code]);
    case 'particle-render-type-mismatch':
      return createParticleRenderError(code, details[code]);
    case 'particle-render-executor-missing':
      return createParticleRenderError(code, details[code]);
    case 'particle-render-camera-unavailable':
      return createParticleRenderError(code, details[code]);
    case 'particle-render-bucket-invalid':
      return createParticleRenderError(code, details[code]);
    case 'particle-render-prepared-generation-mismatch':
      return createParticleRenderError(code, details[code]);
    case 'particle-render-device-lost':
      return createParticleRenderError(code, details[code]);
    case 'particle-render-feature-failed':
      return createParticleRenderError(code, details[code]);
  }
}

function narrow(error: ParticleRenderError): string {
  switch (error.code) {
    case 'particle-render-material-not-ready':
    case 'particle-render-mesh-not-ready':
      return error.detail.assetGuid;
    case 'particle-render-type-mismatch':
      return `${error.detail.expectedKind}:${error.detail.actualKind}`;
    case 'particle-render-executor-missing':
      return error.detail.operator;
    case 'particle-render-camera-unavailable':
      return String(error.detail.owner);
    case 'particle-render-bucket-invalid':
      return error.detail.bucket;
    case 'particle-render-prepared-generation-mismatch':
      return `${error.detail.expectedGeneration}:${error.detail.actualGeneration}`;
    case 'particle-render-device-lost':
      return String(error.detail.generation);
    case 'particle-render-feature-failed':
      return error.detail.stage;
  }
}

describe('particle render closed errors', () => {
  it('exposes one exhaustive code union with actionable structured detail', () => {
    expect(PARTICLE_RENDER_ERROR_CODES).toHaveLength(9);
    for (const code of PARTICLE_RENDER_ERROR_CODES) {
      const error = makeError(code);
      expect(error.code).toBe(code);
      expect(error.expected).toContain('particle render');
      expect(error.hint.length).toBeGreaterThan(0);
      expect(narrow(error)).toBeTruthy();
    }
  });

  it('does not use message text for recovery decisions', () => {
    const error = createParticleRenderError(
      'particle-render-prepared-generation-mismatch',
      details['particle-render-prepared-generation-mismatch'],
    );
    expect(error.detail.expectedGeneration).toBe(2);
    expect(error.detail.actualGeneration).toBe(1);
    expect(error.hint).toContain('recover');
  });
});
