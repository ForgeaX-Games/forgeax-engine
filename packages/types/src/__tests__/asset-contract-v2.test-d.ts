import { describe, expectTypeOf, it } from 'vitest';
import type {
  ArtifactDescriptor,
  AssetCodec,
  AssetEnvelopeV2,
  ContentEncoding,
  Integrity,
  PackV2,
} from '../asset.js';

describe('Pack v2 asset contract', () => {
  it('keeps media type, asset codec, and outer encoding as separate facts', () => {
    expectTypeOf<ArtifactDescriptor['mediaType']>().toBeString();
    expectTypeOf<AssetCodec['name']>().toBeString();
    expectTypeOf<ContentEncoding>().toEqualTypeOf<'identity' | 'zstd'>();
    expectTypeOf<Integrity['algorithm']>().toEqualTypeOf<'sha256'>();
    expectTypeOf<ArtifactDescriptor['integrity']>().toEqualTypeOf<Integrity | undefined>();
  });

  it('uses an asset-local artifact map inside the v2 envelope', () => {
    expectTypeOf<AssetEnvelopeV2['artifacts']>().toEqualTypeOf<
      Readonly<Record<string, ArtifactDescriptor>>
    >();
    expectTypeOf<PackV2['schemaVersion']>().toEqualTypeOf<'2.0.0'>();
    expectTypeOf<PackV2['assets'][number]>().toMatchTypeOf<AssetEnvelopeV2>();
  });
});
