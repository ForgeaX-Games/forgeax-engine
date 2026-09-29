import { describe, expect, it, vi } from 'vitest';
import * as programs from '../material/program';
import { ShaderRegistry } from '../ShaderRegistry';

describe('registry-owned material programs', () => {
  it('shares one source analysis across registrations, variants, lookups and device replacement', () => {
    const source = '@group(2) @binding(3) var<uniform> cluster: vec4f;';
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const analyze = vi.spyOn(programs, 'createMaterialShaderProgram');
    try {
      registry.installMaterialArtifact('forgeax::first', { source, paramSchema: [] });
      registry.installMaterialArtifact('forgeax::second', { source, paramSchema: [] });
      const first = registry.findMaterialArtifact('forgeax::first').unwrap().program;
      const second = registry.findMaterialArtifact('forgeax::second').unwrap().program;
      const replacement = registry.forkForDevice({ createShaderModule: vi.fn() });
      for (let frame = 0; frame < 100; frame += 1) {
        expect(registry.materialProgram(source)).toBe(first);
        expect(replacement.materialProgram(source)).toBe(first);
      }
      expect(first).toBe(second);
      expect(first.group2).toBe('cluster');
      expect(Object.isFrozen(first)).toBe(true);
      expect(analyze).toHaveBeenCalledTimes(1);

      const changed = registry.materialProgram(
        '@group(2) @binding(1) var<uniform> skin: mat4x4<f32>;',
      );
      expect(changed.group2).toBe('skin');
      expect(changed.identity).not.toBe(first.identity);
      expect(analyze).toHaveBeenCalledTimes(2);
      expect(first.group2).toBe('cluster');
    } finally {
      analyze.mockRestore();
    }
  });

  it('derives both binding decisions from the selected source while ignoring comments', () => {
    const program = programs.createMaterialShaderProgram(`
      // @group(2) @binding(9) var<uniform> notCluster: vec4f;
      /* @group(2) @binding(1) var<uniform> notSkin: vec4f; */
      @group(2) @binding(0) var<storage> rows: array<u32>;
      @group(3) @binding(1) var<storage, read> probes: array<vec4<f32>>;
    `);
    expect(program.group2).toBe('mesh');
    expect(program.probeBlendRecordRequired).toBe(true);
    expect(
      programs.createMaterialShaderProgram(
        '@group(3) @binding(1) var<storage> visible: array<vec2<u32>>;',
      ).probeBlendRecordRequired,
    ).toBe(false);
  });
});
