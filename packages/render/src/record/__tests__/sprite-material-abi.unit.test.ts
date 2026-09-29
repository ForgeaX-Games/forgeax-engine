import type { BindGroupEntry, Buffer, Sampler, TextureView } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { assembleMaterialWithSkylightEntries } from '../../ibl/skylight-bind-group';
import {
  BUILTIN_USER_REGION_TEXTURE_FIELDS,
  defaultViewForUserRegionField,
} from '../main-pass-material';
import type { PipelineState } from '../render-context';

describe('sprite Standard material ABI', () => {
  it('uses the dedicated neutral anisotropy fallback instead of white', () => {
    const white = {} as TextureView;
    const anisotropy = {} as TextureView;
    const pipelineState = {
      defaultWhiteTextureView: white,
      defaultAnisotropyTextureView: anisotropy,
      defaultNormalTextureView: {} as TextureView,
      fallbackTextureView: {} as TextureView,
    } as PipelineState;

    expect(defaultViewForUserRegionField('anisotropyTexture', pipelineState)).toBe(anisotropy);
    expect(defaultViewForUserRegionField('baseColorTexture', pipelineState)).toBe(
      pipelineState.fallbackTextureView,
    );
  });

  it('covers transmission and thickness before IBL injection', () => {
    const sampler = {} as Sampler;
    const white = {} as TextureView;
    const pipelineState = {
      materialUniformBuffer: { buffer: {} },
      defaultSampler: sampler,
      defaultWhiteTextureView: white,
      defaultNormalTextureView: {} as TextureView,
      fallbackTextureView: {} as TextureView,
    } as PipelineState;
    const spriteTexture = {} as TextureView;

    // Sprite no longer owns a parallel material-entry builder. Preserve the
    // shared user-region/IBL layout gate; actual sampler selection is covered
    // by the source-derived 60-frame Sprite raster smoke in both tone lanes.
    const entries: BindGroupEntry[] = [
      { binding: 0, resource: { kind: 'buffer', value: { buffer: {} as Buffer } } },
    ];
    for (const [index, field] of BUILTIN_USER_REGION_TEXTURE_FIELDS.entries()) {
      entries.push(
        { binding: 1 + index * 2, resource: { kind: 'sampler', value: sampler } },
        {
          binding: 2 + index * 2,
          resource: {
            kind: 'textureView',
            value:
              field === 'baseColorTexture'
                ? spriteTexture
                : defaultViewForUserRegionField(field, pipelineState),
          },
        },
      );
    }

    const userEnd = 1 + BUILTIN_USER_REGION_TEXTURE_FIELDS.length * 2;
    expect(entries.map((entry) => entry.binding)).toEqual(
      Array.from({ length: userEnd }, (_, index) => index),
    );
    expect(entries[13]).toMatchObject({ binding: 13, resource: { kind: 'sampler' } });
    expect(entries[14]).toMatchObject({ binding: 14, resource: { kind: 'textureView' } });
    expect(entries[2]?.resource).toMatchObject({ kind: 'textureView', value: spriteTexture });
    expect(entries).toHaveLength(userEnd);

    const merged = assembleMaterialWithSkylightEntries(entries, {
      irradianceView: {} as TextureView,
      irradianceSampler: sampler,
      prefilterView: {} as TextureView,
      prefilterSampler: sampler,
      brdfLutView: {} as TextureView,
      intensityBuffer: {} as Buffer,
    });
    expect(merged[userEnd]).toMatchObject({
      binding: userEnd,
      resource: { kind: 'textureView' },
    });
    expect(merged[userEnd + 6]).toMatchObject({
      binding: userEnd + 6,
      resource: { kind: 'sampler', value: sampler },
    });
    expect(merged[userEnd + 7]).toMatchObject({
      binding: userEnd + 7,
      resource: { kind: 'textureView' },
    });
    expect(merged).toHaveLength(userEnd + 9);
    expect(merged.find((entry) => entry.binding === 47)?.resource.kind).toBe('textureView');

    const complete = [
      ...merged,
      {
        binding: 46,
        resource: { kind: 'buffer' as const, value: { buffer: {} as Buffer } },
      },
    ];
    expect(complete).toHaveLength(userEnd + 10);
    expect(complete.find((entry) => entry.binding === 46)).toMatchObject({
      binding: 46,
      resource: { kind: 'buffer' },
    });

    const backdrop = {} as TextureView;
    const active = assembleMaterialWithSkylightEntries(
      entries,
      {
        irradianceView: {} as TextureView,
        irradianceSampler: sampler,
        prefilterView: {} as TextureView,
        prefilterSampler: sampler,
        brdfLutView: {} as TextureView,
        intensityBuffer: {} as Buffer,
      },
      { sampler, backdropView: backdrop },
    );
    expect(active[userEnd + 7]).toMatchObject({
      binding: userEnd + 7,
      resource: { kind: 'textureView', value: backdrop },
    });
  });
});
