import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataUriBase64Payload, decodeBase64 } from '../data-uri.js';
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

describe('glTF COLOR_0 importer carrier', () => {
  it('publishes normalized VEC3 FLOAT colors as importer-owned RGBA', async () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/color-0/float-vec3.gltf', import.meta.url), 'utf8'),
    ) as {
      readonly buffers: readonly { readonly uri: string }[];
      readonly meshes: readonly {
        readonly primitives: readonly { readonly attributes: Record<string, number> }[];
      }[];
      readonly accessors: readonly unknown[];
      readonly bufferViews: readonly unknown[];
    };
    const uri = fixture.buffers[0]?.uri;
    if (uri === undefined) throw new Error('fixture buffer is missing');
    const payload = dataUriBase64Payload(uri);
    if (payload === undefined) throw new Error('fixture buffer must be a data URI');
    const result = await parseGltf(
      fixture,
      async () => {
        const bytes = decodeBase64(payload);
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        return buffer;
      },
      '/fixtures/color-0/float-vec3.gltf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mesh = result.value.meshes[0] as unknown as {
      readonly colors0?: Float32Array;
    };
    expect(Array.from(mesh.colors0 ?? [])).toEqual([0, 0.5, 1, 1, 1, 0.25, 0, 1]);
  });

  it('keeps an absent COLOR_0 distinct from a present-invalid accessor', async () => {
    const source = JSON.parse(
      readFileSync(new URL('./fixtures/color-0/float-vec3.gltf', import.meta.url), 'utf8'),
    ) as {
      readonly asset: { readonly version: string };
      readonly buffers: readonly unknown[];
      readonly bufferViews: readonly unknown[];
      readonly accessors: readonly unknown[];
      readonly meshes: readonly {
        readonly primitives: readonly { readonly attributes: Record<string, number> }[];
      }[];
    };
    const sourcePrimitive = source.meshes[0]?.primitives[0];
    if (sourcePrimitive === undefined) throw new Error('fixture primitive is missing');
    const plain = await parseGltf(
      {
        ...source,
        meshes: [
          {
            primitives: [{ attributes: { POSITION: sourcePrimitive.attributes.POSITION ?? 0 } }],
          },
        ],
      },
      noopLoader,
      '/fixtures/color-0/absent.gltf',
    );
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(
      (plain.value.meshes[0] as unknown as { readonly colors0?: unknown }).colors0,
    ).toBeUndefined();

    const invalid = await parseGltf(
      {
        ...source,
        meshes: [
          {
            primitives: [
              {
                attributes: {
                  POSITION: sourcePrimitive.attributes.POSITION ?? 0,
                  COLOR_0: 9,
                },
              },
            ],
          },
        ],
      },
      noopLoader,
      '/fixtures/color-0/present-invalid.gltf',
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.detail).toMatchObject({ semantic: 'COLOR_0', accessorIndex: 9 });
  });
});
