import { describe, expect, it } from 'vitest';
import { reflectVfxLayout } from '../reflection.js';

describe('VFX Data Interface reflection', () => {
  it('derives managed requirements from explicit imports in deterministic order', () => {
    const result = reflectVfxLayout({
      root: `
        #import forgeax_vfx::data::scene_depth
        #import forgeax_vfx::data::camera
        #import forgeax_vfx::data::noise
      `,
      imports: {
        'game::impact': '#import forgeax_vfx::data::channel',
      },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        dataInterfaces: [
          { token: 'vfx:camera', kind: 'camera', binding: 8, bindingType: 'uniform' },
          {
            token: 'vfx:scene-depth',
            kind: 'scene-depth',
            binding: 9,
            bindingType: 'sampled-depth',
          },
          { token: 'vfx:noise', kind: 'noise', binding: 10, bindingType: 'sampled-float' },
          { token: 'vfx:channel', kind: 'channel', binding: 11, bindingType: 'storage-read' },
        ],
      },
    });
  });

  it('does not create a requirement from an undeclared resource name', () => {
    const result = reflectVfxLayout({ root: 'var<private> hidden_resource: u32;' });
    expect(result).toMatchObject({ ok: true, value: { dataInterfaces: [] } });
  });
});
