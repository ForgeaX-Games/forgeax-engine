import { describe, expect, it } from 'vitest';
import { CUBE_CAMERA_FACE_ORDER } from '@forgeax/engine-render';

describe('CubeCamera Dawn evidence contract', () => {
  it('keeps the six-face readback order explicit for the native backend', () => {
    expect(CUBE_CAMERA_FACE_ORDER).toEqual(['+X', '-X', '+Y', '-Y', '+Z', '-Z']);
  });
});
