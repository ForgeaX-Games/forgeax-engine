import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  AssetCodec,
  EquirectAsset,
  FontAsset,
  LoadContext,
  Loader,
  LoaderAsyncResult,
  TextureAsset,
} from '@forgeax/engine-types';
import { AssetError } from '@forgeax/engine-types';
import type { PackLoaderInput } from '../loader-registry';
import { numMipLevels } from '../mipmap-generator';

type PackArtifact = PackLoaderInput['artifacts'][string];

function firstArtifact(input: PackLoaderInput): PackArtifact | undefined {
  return input.artifacts.body ?? Object.values(input.artifacts)[0];
}

function payloadNumber(payload: Record<string, unknown>, key: string, fallback: number): number {
  const value = payload[key];
  return typeof value === 'number' ? value : fallback;
}

function payloadColorSpace(payload: Record<string, unknown>): 'srgb' | 'linear' {
  return payload.colorSpace === 'linear' ? 'linear' : 'srgb';
}

function invalidPackAsset<T>(input: PackLoaderInput, expected: string): LoaderAsyncResult<T> {
  return {
    ok: false,
    error: new AssetError({
      code: 'asset-parse-failed',
      expected,
      hint: `Pack v2 asset ${input.guid} must provide an asset-local artifact`,
      detail: { sourcePath: input.guid },
    }),
  };
}

function codecProfile(codec: AssetCodec | undefined): string | undefined {
  return codec?.profile;
}

function transcodeModel(profile: string): 'etc1s' | 'uastc-ldr' | 'uastc-hdr' | undefined {
  if (profile === 'etc1s') return 'etc1s';
  if (profile === 'uastc' || profile === 'uastc-ldr') return 'uastc-ldr';
  if (profile === 'uastc-hdr') return 'uastc-hdr';
  return undefined;
}

async function loadTexturePack(
  input: PackLoaderInput,
  ctx: LoadContext,
): Promise<LoaderAsyncResult<TextureAsset>> {
  const artifact = firstArtifact(input);
  if (artifact === undefined)
    return invalidPackAsset<TextureAsset>(input, 'texture asset-local image artifact');
  const payload = input.payload;
  const width = payloadNumber(payload, 'width', 0);
  const height = payloadNumber(payload, 'height', 0);
  const colorSpace = payloadColorSpace(payload);
  const codec = artifact.descriptor.assetCodec;
  const profile = codecProfile(codec);
  const model =
    codec?.name === 'basis' && profile !== undefined ? transcodeModel(profile) : undefined;

  if (model !== undefined) {
    try {
      const { parseKtx2, selectTranscodeTarget, transcodeKtx2 } = await import(
        '@forgeax/engine-codec'
      );
      const parsed = await parseKtx2(artifact.bytes);
      if (!parsed.ok)
        return invalidPackAsset<TextureAsset>(input, 'valid Basis KTX2 texture artifact');
      const target = selectTranscodeTarget(
        { model, srgb: colorSpace === 'srgb', channels: 'rgba' },
        ctx.transcodeCaps,
      );
      const transcoded = await transcodeKtx2(parsed.value, target);
      if (!transcoded.ok)
        return invalidPackAsset<TextureAsset>(input, 'transcodable Basis KTX2 texture artifact');
      const data = new Uint8Array(
        transcoded.value.mips.reduce((size, mip) => size + mip.data.length, 0),
      );
      let offset = 0;
      for (const mip of transcoded.value.mips) {
        data.set(mip.data, offset);
        offset += mip.data.length;
      }
      return {
        ok: true,
        value: {
          kind: 'texture',
          width: transcoded.value.width,
          height: transcoded.value.height,
          format: target,
          data,
          colorSpace,
          mipmap: transcoded.value.mips.length > 1,
          mipLevelCount: Math.max(1, transcoded.value.mips.length),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: new AssetError({
          code: 'asset-fetch-failed',
          expected: 'loadable Basis KTX2 texture artifact',
          hint: error instanceof Error ? error.message : String(error),
          detail: { sourcePath: input.guid },
        }),
      };
    }
  }

  const mipmap = payload.mipmap === true;
  return {
    ok: true,
    value: {
      kind: 'texture',
      width,
      height,
      format: (payload.format === 'rgba8unorm-srgb'
        ? 'rgba8unorm-srgb'
        : (payload.format ?? 'rgba8unorm')) as GPUTextureFormat,
      data: artifact.bytes,
      colorSpace,
      mipmap,
      mipLevelCount: mipmap ? numMipLevels({ width, height }) : 1,
    },
  };
}

async function loadEquirectPack(input: PackLoaderInput): Promise<LoaderAsyncResult<EquirectAsset>> {
  const artifact = firstArtifact(input);
  if (artifact === undefined)
    return invalidPackAsset<EquirectAsset>(input, 'equirect asset-local image artifact');
  const payload = input.payload;
  return {
    ok: true,
    value: {
      kind: 'equirect',
      width: payloadNumber(payload, 'width', 0),
      height: payloadNumber(payload, 'height', 0),
      format: (payload.format ?? 'rgba16float') as GPUTextureFormat,
      data: artifact.bytes,
      colorSpace: payloadColorSpace(payload),
    },
  };
}

function parseGlyphs(value: unknown): FontAsset['glyphs'] {
  if (typeof value !== 'object' || value === null) return {};
  const glyphs: FontAsset['glyphs'] = {};
  for (const [codepoint, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const metric = raw as Record<string, unknown>;
    const size = metric.size as Record<string, unknown> | undefined;
    const region = metric.region as Record<string, unknown> | undefined;
    if (
      typeof metric.advance !== 'number' ||
      typeof metric.bearingX !== 'number' ||
      typeof metric.bearingY !== 'number' ||
      typeof size?.w !== 'number' ||
      typeof size.h !== 'number' ||
      typeof region?.x !== 'number' ||
      typeof region.y !== 'number' ||
      typeof region.w !== 'number' ||
      typeof region.h !== 'number'
    ) {
      continue;
    }
    glyphs[Number(codepoint)] = {
      advance: metric.advance,
      bearingX: metric.bearingX,
      bearingY: metric.bearingY,
      size: { w: size.w, h: size.h },
      region: { x: region.x, y: region.y, w: region.w, h: region.h },
    };
  }
  return glyphs;
}

async function loadFontPack(
  input: PackLoaderInput,
  ctx: LoadContext,
): Promise<LoaderAsyncResult<FontAsset>> {
  const payload = input.payload;
  const atlasGuid = payload.atlasGuid;
  const samplerGuid = payload.samplerGuid;
  const common = payload.common;
  if (
    typeof atlasGuid !== 'string' ||
    typeof samplerGuid !== 'string' ||
    typeof common !== 'object' ||
    common === null
  ) {
    return invalidPackAsset<FontAsset>(
      input,
      'font payload with atlasGuid, samplerGuid, and common',
    );
  }
  const parsedAtlas = AssetGuid.parse(atlasGuid);
  const parsedSampler = AssetGuid.parse(samplerGuid);
  if (!parsedAtlas.ok) return { ok: false, error: parsedAtlas.error };
  if (!parsedSampler.ok) return { ok: false, error: parsedSampler.error };
  const atlasResolved = await ctx.resolveRef(atlasGuid);
  if (!atlasResolved.ok) return atlasResolved;
  const samplerResolved = await ctx.resolveRef(samplerGuid);
  if (!samplerResolved.ok) return samplerResolved;
  const commonRecord = common as Record<string, unknown>;
  const commonFields = [
    'lineHeight',
    'base',
    'distanceRange',
    'pxRange',
    'atlasWidth',
    'atlasHeight',
  ];
  if (commonFields.some((key) => typeof commonRecord[key] !== 'number')) {
    return invalidPackAsset<FontAsset>(input, 'font common block with numeric layout fields');
  }
  return {
    ok: true,
    value: {
      kind: 'font',
      atlas: parsedAtlas.value,
      sampler: parsedSampler.value,
      glyphs: parseGlyphs(payload.glyphs),
      common: {
        lineHeight: commonRecord.lineHeight as number,
        base: commonRecord.base as number,
        distanceRange: commonRecord.distanceRange as number,
        pxRange: commonRecord.pxRange as number,
        atlasWidth: commonRecord.atlasWidth as number,
        atlasHeight: commonRecord.atlasHeight as number,
      },
    },
  };
}

export const textureLoader: Loader = {
  kind: 'texture',
  load: () => undefined,
  loadPack: loadTexturePack,
};

export const equirectLoader: Loader = {
  kind: 'equirect',
  load: () => undefined,
  loadPack: loadEquirectPack,
};

export const fontLoader: Loader = {
  kind: 'font',
  load: () => undefined,
  loadPack: loadFontPack,
};

export const PACK_ARTIFACT_LOADERS: readonly Loader[] = [textureLoader, fontLoader, equirectLoader];
