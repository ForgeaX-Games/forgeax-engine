import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allowsUnlitPreparedFallback,
  normalizeMaterialShaderVariantSet,
  resolveMaterialShaderBindingContract,
  resolveMaterialShaderVertexInputContract,
  shouldDeferMissingPreparedMaterialShader,
} from '../assembly/factory';

describe('material shader variant identity', () => {
  it('keeps single-source manifests on the canonical module key', () => {
    const singleSourceManifest = {
      identifier: 'forgeax::points-lines',
      sourcePath: 'points-lines.wgsl',
      composedWgsl: 'shader',
      paramSchema: '{}',
      variants: [],
    };

    expect(
      normalizeMaterialShaderVariantSet('VERTEX_COLOR_AVAILABLE=false', singleSourceManifest),
    ).toBeUndefined();
  });

  it('preserves variant requests for manifests that actually declare variants', () => {
    const variantManifest = {
      identifier: 'forgeax::default-standard-pbr',
      sourcePath: 'standard-pbr.wgsl',
      composedWgsl: 'shader',
      paramSchema: '{}',
      variants: [
        {
          definesKey: 'STORAGE_BUFFER_AVAILABLE=true',
          defines: { STORAGE_BUFFER_AVAILABLE: true },
          composedWgsl: 'shader',
        },
      ],
    };

    expect(
      normalizeMaterialShaderVariantSet('STORAGE_BUFFER_AVAILABLE=true', variantManifest),
    ).toBe('STORAGE_BUFFER_AVAILABLE=true');
    expect(normalizeMaterialShaderVariantSet('CUSTOM=true', undefined)).toBe('CUSTOM=true');
  });
});

describe('material shader binding contract', () => {
  it('keeps record binding on the cooked projection contract', () => {
    const recordSource = readFileSync(
      resolve(import.meta.dirname, '../record/main-pass-material.ts'),
      'utf8',
    );
    const projectionSource = readFileSync(
      resolve(import.meta.dirname, '../assembly/material/pipeline-projection.ts'),
      'utf8',
    );
    expect(projectionSource).toContain('routeMaterialPipeline');
    expect(recordSource).not.toMatch(/internals\.assets\.get<MaterialAsset>/);
    expect(recordSource).not.toMatch(/firstMaterial as \{/);
    expect(recordSource).not.toContain('baseColorHandle');
  });

  it('recognizes a world-space shader that reads only the canonical view uniform', () => {
    const source = `
      struct View { worldViewProj: mat4x4<f32> }
      @group(0) @binding(0) var<uniform> view: View;
      @vertex fn vs_main() -> @builtin(position) vec4<f32> { return view.worldViewProj[0]; }
    `;

    expect(resolveMaterialShaderBindingContract(source)).toBe('view-only');
  });

  it('recognizes the canonical view name after naga-oil import mangling', () => {
    const source = `
      @group(0) @binding(0)
      var<uniform> viewX_naga_oil_mod_XMZXXEZ3FMF4F65TJMV3TUOTDN5WW233OX: View;
    `;

    expect(resolveMaterialShaderBindingContract(source)).toBe('view-only');
  });

  it('recognizes the VFX view plus sampled scene-depth contract', () => {
    const source = `
      struct View { worldViewProj: mat4x4<f32> }
      @group(0) @binding(0) var<uniform> view: View;
      @group(0) @binding(1) var scene_depth: texture_depth_2d;
      @fragment fn fs_main() -> @location(0) vec4<f32> {
        return vec4<f32>(textureLoad(scene_depth, vec2<i32>(0, 0), 0));
      }
    `;

    expect(resolveMaterialShaderBindingContract(source)).toBe('view-and-scene-depth');
  });

  it('keeps shaders with material groups on the full render-material layout', () => {
    const source = `
      @group(0) @binding(0) var<uniform> view: mat4x4<f32>;
      @group(1) @binding(0) var<uniform> material: vec4<f32>;
    `;

    expect(resolveMaterialShaderBindingContract(source)).toBe('render-material');
  });

  it('recognizes a group-zero sampled depth resource without inventing a view uniform', () => {
    const source = `
      @group(0) @binding(0) var sceneDepth: texture_depth_2d;
      @fragment fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
        return vec4<f32>(textureLoad(sceneDepth, vec2<i32>(position.xy), 0));
      }
    `;

    expect(resolveMaterialShaderBindingContract(source)).toBe('group-0-resource');
  });
});

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

  it('defers every VFX prepared layout when its material shader is missing', () => {
    expect(shouldDeferMissingPreparedMaterialShader('billboard-material-instance')).toBe(true);
    expect(shouldDeferMissingPreparedMaterialShader('topology-segment-instance')).toBe(true);
    expect(shouldDeferMissingPreparedMaterialShader('mesh-geometry-material-instance')).toBe(true);
    expect(shouldDeferMissingPreparedMaterialShader('position-size-color-instance')).toBe(false);
    expect(shouldDeferMissingPreparedMaterialShader(undefined)).toBe(false);
  });
});
