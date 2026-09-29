import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverTemplateCatalog,
  type TemplateDescriptor,
  validateTemplateDescriptor,
} from '../templates/catalog.js';

const empty: TemplateDescriptor = {
  id: 'empty',
  purpose: 'minimal project',
  defaultIdentity: { name: 'empty-game', packageName: '@local/empty-game' },
  journeys: ['typecheck', 'unit'],
};

describe('template descriptor discovery', () => {
  it('requires stable identity, purpose, defaults, and verification journeys', () => {
    expect(validateTemplateDescriptor(empty)).toEqual({ ok: true, value: empty });
    expect(validateTemplateDescriptor({ ...empty, journeys: [] })).toMatchObject({
      ok: false,
      error: { code: 'template-journey-missing' },
    });
  });

  it('rejects duplicate ids and orphan template directories', async () => {
    await expect(
      discoverTemplateCatalog({
        root: 'fixtures/templates',
        descriptors: [empty, empty],
        directories: ['empty', 'orphan'],
      }),
    ).rejects.toMatchObject({
      code: 'template-catalog-invalid',
      detail: { reason: expect.stringContaining('duplicate') },
    });
  });

  it('discovers the checked-in template set from template.json only', async () => {
    const catalog = await discoverTemplateCatalog({
      root: resolve(import.meta.dirname, '../../../../templates'),
    });

    expect(catalog.descriptors.map((descriptor) => descriptor.id)).toEqual(['empty', 'game-3d']);
  });
});
