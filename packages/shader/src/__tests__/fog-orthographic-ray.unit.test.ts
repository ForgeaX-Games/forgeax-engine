import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fog = readFileSync(fileURLToPath(new URL('../fog.wgsl', import.meta.url)), 'utf8');

describe('View fog ray', () => {
  it('starts orthographic rays on the camera plane along the view axis', () => {
    expect(fog).toContain('if v.temporalProjection.z > 0.5 {');
    expect(fog).toContain('origin = worldPos - forward * dot(worldPos - v.cameraPos, forward);');
  });

  it('selects the translucent composition from the bound View copy only', () => {
    expect(fog).toContain('let composition = u32(v.fogHeightOpacity.z + 0.5);');
    expect(fog).toContain('if composition == 0u { return color; }');
  });
});
