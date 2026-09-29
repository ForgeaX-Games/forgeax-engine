import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { installPublicationPrograms } from '../programs';

it('rejects conflicting programs atomically and preserves the installed shader', () => {
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  const assets = new AssetRegistry(shaders);
  const first = { key: 'forgeax::publication-test', shader: { source: 'first', paramSchema: [] } };
  installPublicationPrograms(assets, [first]);
  expect(() =>
    installPublicationPrograms(assets, [
      { key: 'forgeax::new-test', shader: { source: 'new', paramSchema: [] } },
      { ...first, shader: { ...first.shader, source: 'conflict' } },
    ]),
  ).toThrow('conflicting immutable shader');
  expect(shaders.findMaterialArtifact('forgeax::new-test').ok).toBe(false);
  expect(shaders.findMaterialArtifact(first.key).unwrap().source).toBe('first');
  expect(() => installPublicationPrograms(assets, [first, first])).toThrow('duplicate');
  expect(() =>
    installPublicationPrograms(assets, [
      { ...first, artifact: { key: 'wrong', bytes: new Uint8Array() } },
    ]),
  ).toThrow('mismatched');
});
