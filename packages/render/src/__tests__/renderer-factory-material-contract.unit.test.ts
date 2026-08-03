import { describe, expect, it } from 'vitest';
import {
  allowsUnlitPreparedFallback,
  resolveMaterialShaderVertexInputContract,
} from '../renderer/renderer-factory';

describe('material shader vertex input contract', () => {
  it('recognizes VsIn-style vertex input structs', () => {
    const source = `
      struct VsIn { @location(0) position: vec3<f32> }
      struct VsOut { @builtin(position) position: vec4<f32> }
      @vertex fn vs_main(input: VsIn) -> VsOut { var out: VsOut; return out }
    `;

    expect(resolveMaterialShaderVertexInputContract(source)).toBe('render-material');
  });

  it('does not treat fullscreen output locations as vertex inputs', () => {
    const source = `
      struct FullscreenOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
      }
      @vertex fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> FullscreenOutput {
        var out: FullscreenOutput;
        return out;
      }
    `;

    expect(resolveMaterialShaderVertexInputContract(source)).toBe('none');
  });

  it('keeps an explicit prepared vertex layout on a missing shader', () => {
    expect(allowsUnlitPreparedFallback(null, undefined)).toBe(true);
    expect(allowsUnlitPreparedFallback(null, 'position-size-color-instance', 'forward')).toBe(true);
    expect(
      allowsUnlitPreparedFallback(null, 'position-size-color-instance', 'forgeax::missing-shader'),
    ).toBe(false);
  });
});
