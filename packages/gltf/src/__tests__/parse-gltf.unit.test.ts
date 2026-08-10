import { describe, expect, it } from 'vitest';
import { parseGltf } from '../parse-gltf.js';

const noopLoader = async (_uri: string) => new ArrayBuffer(0);

async function parseMaterial(material: Record<string, unknown>) {
  const result = await parseGltf(
    {
      asset: { version: '2.0' },
      materials: [material],
    },
    noopLoader,
    '/material-alpha.gltf',
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected material parse to succeed');
  return result.value.materials[0];
}

describe('glTF MASK alpha cutoff parsing', () => {
  it('applies the glTF default cutoff of 0.5', async () => {
    const material = await parseMaterial({
      alphaMode: 'MASK',
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.5] },
    });

    expect(material?.alphaMode).toBe('MASK');
    expect(material?.alphaCutoff).toBe(0.5);
  });

  it.each([0, 0.5, 1])('preserves the explicit cutoff boundary %s', async (cutoff) => {
    const material = await parseMaterial({
      alphaMode: 'MASK',
      alphaCutoff: cutoff,
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.5] },
    });

    expect(material?.alphaCutoff).toBe(cutoff);
  });
});
