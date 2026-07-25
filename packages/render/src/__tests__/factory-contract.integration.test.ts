import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { constructRenderer } from '../construct-renderer';

describe('factory contract', () => {
  it('resolves a renderer for a host canvas and rejects missing input', async () => {
    const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ schemaVersion: '1.0.0', entries: [] }))}`;
    await expect(
      constructRenderer({ getContext: () => null }, { rhi }, { shaderManifestUrl: manifest }),
    ).resolves.toMatchObject({
      backend: 'webgpu',
    });
    await expect(constructRenderer(undefined, { rhi })).rejects.toBeInstanceOf(Error);
  });
});
