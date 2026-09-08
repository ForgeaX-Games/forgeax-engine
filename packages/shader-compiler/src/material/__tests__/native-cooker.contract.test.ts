import type { AssetGuid, MaterialAsset, MaterialTextureValue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createMaterialNativeCooker, materialCookPublication } from '../native-cooker.js';

const material: MaterialAsset = {
  kind: 'material',
  parent: 'mat-parent' as unknown as AssetGuid,
  passes: [
    {
      name: 'forward',
      program: {
        module: 'game::pbr',
        vertexEntry: 'vs_main',
        fragmentEntry: 'fs_main',
        moduleSlots: { lighting: 'game::lighting' },
      },
      renderState: { blend: 'opaque' },
    },
  ],
  parameters: [{ name: 'roughness', type: 'f32', default: 0.5 }],
  values: {
    roughness: 0.5,
    baseColor: {
      texture: 'tex-base' as unknown as AssetGuid,
      sampler: 'sampler-linear' as unknown as AssetGuid,
      coordinates: { set: 1, transform: { scale: [2, 2] } },
    },
  },
};

const request = {
  guid: 'mat-child',
  sourceClosure: ['materials/parent.material.json', 'materials/child.material.json'],
  profile: 'webgpu/v1',
  compilerVersion: 'compiler/1',
  material,
};

describe('shader-compiler material native cooker', () => {
  it('owns the complete product, record, artifact, and receipt contract', async () => {
    const cooker = createMaterialNativeCooker({
      compile: async () => new TextEncoder().encode('compiled material'),
    });

    const product = await cooker.cook(request);
    const publication = materialCookPublication(product);

    expect(product.payload).toBe(material);
    expect(product.refs).toEqual(['mat-parent', 'tex-base', 'sampler-linear', 'game::pbr']);
    expect(product.receipt).toEqual({
      guid: 'mat-child',
      origin: 'authoredPack',
      status: 'succeeded',
      inputFingerprint: publication?.record.receipt.identity.cookIdentity,
      outputDigest: product.digest,
    });
    expect(product.artifacts['materials/mat-child/shader.wgsl']).toMatchObject({
      path: 'materials/mat-child/shader.wgsl',
      mediaType: 'text/wgsl',
      byteLength: 'compiled material'.length,
      integrity: { algorithm: 'sha256', digest: product.digest },
    });
    expect(publication).toMatchObject({
      cache: 'cold',
      catalog: {
        guid: 'mat-child',
        artifactPath: 'materials/mat-child/shader.wgsl',
        artifactDigest: product.digest,
      },
      record: {
        schemaVersion: 'material-cook/3',
        guid: 'mat-child',
        authored: material,
        resolved: {
          passes: material.passes,
          parameters: material.parameters,
          values: material.values,
        },
        refs: {
          parent: ['mat-parent'],
          textures: ['tex-base'],
          samplers: ['sampler-linear'],
          modules: ['game::pbr'],
        },
      },
    });
    expect(publication?.artifactBytes).toEqual(new TextEncoder().encode('compiled material'));
    expect(JSON.parse(new TextDecoder().decode(publication?.recordBytes)).schemaVersion).toBe(
      'material-cook/3',
    );
    expect(JSON.parse(new TextDecoder().decode(publication?.receiptBytes))).toMatchObject({
      compilerVersion: 'compiler/1',
      identity: {
        cookIdentity: publication?.record.receipt.identity.cookIdentity,
        artifactDigest: product.digest,
      },
      profile: 'webgpu/v1',
      sourceClosure: [...request.sourceClosure].sort(),
    });
  });

  it('reuses the finalized product for an identical specialization', async () => {
    let compileCount = 0;
    const cooker = createMaterialNativeCooker({
      compile: async () => {
        compileCount += 1;
        return new TextEncoder().encode('compiled material');
      },
    });

    const cold = await cooker.cook(request);
    const warm = await cooker.cook(request);
    const publication = materialCookPublication(warm);

    expect(warm).toBe(cold);
    expect(publication?.cache).toBe('hit');
    expect(publication?.key).toBe(materialCookPublication(cold)?.key);
    expect(compileCount).toBe(1);
  });

  it('keeps runtime values out of specialization while tracking pass changes', async () => {
    let compileCount = 0;
    const cooker = createMaterialNativeCooker({
      compile: async () => {
        compileCount += 1;
        return new TextEncoder().encode(`compiled material ${compileCount}`);
      },
    });

    const runtimeVariant = await cooker.cook({
      ...request,
      material: { ...material, values: { ...material.values, roughness: 0.8 } },
    });
    const passVariant = await cooker.cook({
      ...request,
      material: {
        ...material,
        passes: [
          {
            ...(material.passes?.[0] ?? { name: 'forward', program: { module: 'game::pbr' } }),
            program: { module: 'game::other' },
          },
        ],
      },
    });

    expect(materialCookPublication(runtimeVariant)?.key).toBe(
      materialCookPublication(await cooker.cook(request))?.key,
    );
    expect(materialCookPublication(passVariant)?.key).not.toBe(
      materialCookPublication(runtimeVariant)?.key,
    );
    expect(compileCount).toBe(2);
  });

  it('reuses the shader artifact across dependency and path mutations', async () => {
    let compileCount = 0;
    const cooker = createMaterialNativeCooker({
      compile: async () => {
        compileCount += 1;
        return new TextEncoder().encode(`compiled material ${compileCount}`);
      },
    });

    const cold = await cooker.cook({
      ...request,
      moduleSources: { 'game::pbr': '#define_import_path game::pbr\nfn main() {}' },
    });
    const textureVariant = await cooker.cook({
      ...request,
      moduleSources: { 'game::pbr': '#define_import_path game::pbr\nfn main() {}' },
      material: {
        ...material,
        values: {
          ...material.values,
          baseColor: {
            ...(material.values?.baseColor as MaterialTextureValue),
            texture: 'tex-other' as unknown as AssetGuid,
            sampler: 'sampler-other' as unknown as AssetGuid,
          },
        },
      },
    });
    const pathMove = await cooker.cook({
      ...request,
      sourceClosure: ['moved/parent.material.json', 'moved/child.material.json'],
      moduleSources: { 'game::pbr': '#define_import_path game::pbr\nfn main() {}' },
    });
    const sourceMutation = await cooker.cook({
      ...request,
      moduleSources: { 'game::pbr': '#define_import_path game::pbr\nfn changed() {}' },
    });

    expect(compileCount).toBe(2);
    expect(materialCookPublication(textureVariant)?.key).toBe(materialCookPublication(cold)?.key);
    expect(
      materialCookPublication(textureVariant)?.record.receipt.identity.materialPublicationIdentity,
    ).not.toBe(materialCookPublication(cold)?.record.receipt.identity.materialPublicationIdentity);
    expect(materialCookPublication(pathMove)?.key).toBe(materialCookPublication(cold)?.key);
    expect(materialCookPublication(pathMove)?.record.receipt.identity.cookIdentity).toBe(
      materialCookPublication(cold)?.record.receipt.identity.cookIdentity,
    );
    expect(materialCookPublication(sourceMutation)?.key).not.toBe(
      materialCookPublication(cold)?.key,
    );
  });
});
