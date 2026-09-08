import { describe, expect, it } from 'vitest';
import { defaultToolDescriptors } from '../catalog.js';
import { createDefaultContributions } from '../contributions.js';

describe('domain preview catalog', () => {
  it('discovers four explicit domain descriptors and no generic preview alias', () => {
    const ids = createDefaultContributions().map((contribution) => contribution.descriptor.id);
    expect(ids).toEqual([
      'project.build',
      'author.plugin-install',
      'material.preview',
      'mesh.preview',
      'vfx.preview',
      'texture.preview',
    ]);
    expect(ids).not.toContain('asset.preview');
    expect(ids).not.toContain('preview.run');
    expect(ids).not.toContain('preview.offline-analysis');
  });

  it('keeps domain descriptors bound to one host realm and GUID-only inputs', () => {
    const domains = defaultToolDescriptors.filter((descriptor) =>
      descriptor.id.endsWith('.preview'),
    );
    expect(domains.map((descriptor) => descriptor.id)).toEqual([
      'material.preview',
      'mesh.preview',
      'vfx.preview',
      'texture.preview',
    ]);
    for (const descriptor of domains) {
      expect(descriptor.realm).toBe('host');
      expect(descriptor.evidence).toEqual(
        expect.arrayContaining(['rhi-tape', 'png', 'profile-capture']),
      );
      expect(descriptor.evidence).toHaveLength(3);
      expect(descriptor.argsSchema.describe).toContain('"required":["guid"]');
      expect(descriptor.argsSchema.describe).not.toContain('"binding"');
    }
  });
});
