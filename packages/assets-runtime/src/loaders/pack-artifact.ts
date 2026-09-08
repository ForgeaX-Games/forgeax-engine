import type { CodecError, TranscodeModel } from '@forgeax/engine-codec';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  AssetCodec,
  AssetCodecFailureDetail,
  EquirectAsset,
  FontAsset,
  LoadContext,
  Loader,
  LoaderAsyncResult,
  RenderPipelineAsset,
  TextureAsset,
  TilesetAsset,
} from '@forgeax/engine-types';
import { AssetError } from '@forgeax/engine-types';
import type { PackLoaderInput } from '../loader-registry';
import { numMipLevels } from '../mipmap-generator';

type PackArtifact = PackLoaderInput['artifacts'][string];

type CodecFailureProjection = {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
};

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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return finiteNumber(value) && Number.isInteger(value) && value > 0;
}

function validRenderPipelineConfig(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false;
  const passCount = value.passCount;
  if (passCount !== undefined && !positiveInteger(passCount)) return false;
  const clusterGrid = value.clusterGrid;
  if (clusterGrid !== undefined) {
    if (
      !record(clusterGrid) ||
      !['x', 'y', 'z'].every((axis) => {
        const size = clusterGrid[axis];
        return positiveInteger(size) && size <= 64;
      })
    ) {
      return false;
    }
  }
  const ssao = value.ssao;
  if (ssao !== undefined && (!record(ssao) || typeof ssao.enabled !== 'boolean')) return false;
  const postEffects = value.postEffects;
  return (
    postEffects === undefined ||
    (Array.isArray(postEffects) &&
      postEffects.every((effect) => typeof effect === 'string' && effect.length > 0))
  );
}

function validTilesetRegion(value: unknown, atlasCount: number): boolean {
  if (!record(value)) return false;
  const { x, y, width, height, atlasIndex } = value;
  return (
    finiteNumber(x) &&
    finiteNumber(y) &&
    positiveInteger(width) &&
    positiveInteger(height) &&
    (atlasIndex === undefined ||
      (typeof atlasIndex === 'number' &&
        Number.isInteger(atlasIndex) &&
        atlasIndex >= 0 &&
        atlasIndex < atlasCount))
  );
}

function validTilesetTile(value: unknown, regionCount: number): boolean {
  if (!record(value)) return false;
  const regionIndex = value.regionIndex;
  return (
    typeof regionIndex === 'number' &&
    Number.isInteger(regionIndex) &&
    regionIndex >= 0 &&
    regionIndex < regionCount
  );
}

function validAtlasSize(value: unknown): boolean {
  return record(value) && positiveInteger(value.pixelWidth) && positiveInteger(value.pixelHeight);
}

function readJsonArtifact(
  input: PackLoaderInput,
  kind: string,
): Record<string, unknown> | undefined {
  const artifact = firstArtifact(input);
  if (artifact === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(artifact.bytes));
    return record(value) && value.kind === kind ? value : undefined;
  } catch {
    return undefined;
  }
}

function renderPipelineDescriptor(value: Record<string, unknown>): RenderPipelineAsset | undefined {
  if (value.kind !== 'render-pipeline') return undefined;
  const pipelineId = value.pipelineId;
  if (typeof pipelineId !== 'string' || pipelineId.trim().length === 0) return undefined;
  const config = value.config;
  if (config !== undefined && !validRenderPipelineConfig(config)) return undefined;
  return {
    kind: 'render-pipeline',
    pipelineId,
    ...(config === undefined
      ? {}
      : { config: config as NonNullable<RenderPipelineAsset['config']> }),
  };
}

function tilesetDescriptor(
  value: Record<string, unknown>,
  refs: readonly string[],
): TilesetAsset | undefined {
  if (value.kind !== 'tileset') return undefined;
  const rawAtlases = value.atlases;
  if (!Array.isArray(rawAtlases) || rawAtlases.length === 0) return undefined;
  if (!rawAtlases.every((atlas) => typeof atlas === 'string' && atlas.length > 0)) return undefined;
  const atlases = rawAtlases as string[];
  if (atlases.length !== refs.length || atlases.some((guid, index) => guid !== refs[index])) {
    return undefined;
  }
  const { tileWidth, tileHeight, columns, rows, regions, tiles, atlasSizes } = value;
  if (
    typeof tileWidth !== 'number' ||
    tileWidth <= 0 ||
    typeof tileHeight !== 'number' ||
    tileHeight <= 0 ||
    typeof columns !== 'number' ||
    !Number.isInteger(columns) ||
    columns <= 0 ||
    typeof rows !== 'number' ||
    !Number.isInteger(rows) ||
    rows <= 0 ||
    !Array.isArray(regions) ||
    !regions.every((region) => record(region) && validTilesetRegion(region, atlases.length)) ||
    !Array.isArray(tiles) ||
    !tiles.every((tile) => validTilesetTile(tile, regions.length)) ||
    (atlasSizes !== undefined &&
      (!Array.isArray(atlasSizes) ||
        atlasSizes.length !== atlases.length ||
        !atlasSizes.every((size) => validAtlasSize(size))))
  ) {
    return undefined;
  }
  return {
    kind: 'tileset',
    atlases: [...atlases],
    tileWidth,
    tileHeight,
    columns,
    rows,
    regions: regions as TilesetAsset['regions'],
    tiles: tiles as TilesetAsset['tiles'],
    ...(Array.isArray(atlasSizes)
      ? { atlasSizes: atlasSizes as NonNullable<TilesetAsset['atlasSizes']> }
      : {}),
  };
}

function codecProfile(codec: AssetCodec | undefined): string | undefined {
  return codec?.profile;
}

export type CodecContextFailure =
  | {
      readonly code: 'basis-profile-unsupported';
      readonly detail: { readonly profile: string };
    }
  | {
      readonly code: 'ktx2-color-space-mismatch';
      readonly detail: {
        readonly authoredColorSpace: 'srgb' | 'linear';
        readonly dfdColorSpace: 'srgb' | 'linear' | 'unknown';
      };
    };

function projectCodecFailureDetail(
  input: PackLoaderInput,
  codec: AssetCodec,
  caps: LoadContext['transcodeCaps'],
  failure: CodecFailureProjection,
  targetFormat?: GPUTextureFormat,
): AssetCodecFailureDetail {
  return {
    sourcePath: input.guid,
    codecCode: failure.code,
    codecExpected: failure.expected,
    codecHint: failure.hint,
    codecDetail: failure.detail,
    container: codec.container ?? 'basis',
    ...(codec.profile === undefined ? {} : { profile: codec.profile }),
    ...(targetFormat === undefined ? {} : { targetFormat }),
    capabilities: caps,
  };
}

function codecFailure(
  input: PackLoaderInput,
  codec: AssetCodec,
  caps: LoadContext['transcodeCaps'],
  failure: CodecError['error'],
  targetFormat?: GPUTextureFormat,
): AssetError {
  const detail = projectCodecFailureDetail(input, codec, caps, failure, targetFormat);
  return new AssetError({
    code: 'asset-parse-failed',
    expected: failure.expected,
    hint: failure.hint,
    detail,
  });
}

function codecContextFailure(
  input: PackLoaderInput,
  codec: AssetCodec,
  caps: LoadContext['transcodeCaps'],
  failure: CodecContextFailure,
  expected: string,
  hint: string,
  targetFormat?: GPUTextureFormat,
): AssetError {
  const detail = projectCodecFailureDetail(
    input,
    codec,
    caps,
    {
      code: failure.code,
      expected,
      hint,
      detail: failure.detail,
    },
    targetFormat,
  );
  return new AssetError({
    code: 'asset-parse-failed',
    expected,
    hint,
    detail,
  });
}

function transcodeModel(profile: string): TranscodeModel | undefined {
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

  if (codec?.name === 'basis' && codec.container === 'basis') {
    const basisCodec = codec;
    if (model === undefined) {
      return {
        ok: false,
        error: codecContextFailure(
          input,
          basisCodec,
          ctx.transcodeCaps,
          {
            code: 'basis-profile-unsupported',
            detail: { profile: codec.profile ?? 'missing' },
          },
          'raw Basis artifact with an explicit ETC1S or UASTC-LDR profile',
          'set assetCodec.profile to etc1s or uastc-ldr and re-cook the source',
        ),
      };
    }
    try {
      const { selectTranscodeTarget, transcodeBasis } = await import('@forgeax/engine-codec');
      const target = selectTranscodeTarget(
        { model, srgb: colorSpace === 'srgb', channels: 'rgba' },
        ctx.transcodeCaps,
      );
      const transcoded = await transcodeBasis(artifact.bytes, target);
      if (!transcoded.ok) {
        return {
          ok: false,
          error: codecFailure(input, basisCodec, ctx.transcodeCaps, transcoded.error, target),
        };
      }
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
          expected: 'loadable raw Basis texture artifact',
          hint: error instanceof Error ? error.message : String(error),
          detail: {
            sourcePath: input.guid,
            codecCode: 'runtime-loader-exception',
            codecExpected: 'loadable raw Basis texture artifact',
            codecHint: error instanceof Error ? error.message : String(error),
            codecDetail: { reason: 'runtime-loader-exception' },
            container: basisCodec.container ?? 'basis',
            ...(basisCodec.profile === undefined ? {} : { profile: basisCodec.profile }),
            capabilities: ctx.transcodeCaps,
          },
        }),
      };
    }
  }

  if (model !== undefined && codec !== undefined) {
    const ktx2Codec = codec;
    try {
      const { ktx2ColorSpace, parseKtx2, selectTranscodeTarget, transcodeKtx2 } = await import(
        '@forgeax/engine-codec'
      );
      const parsed = await parseKtx2(artifact.bytes);
      if (!parsed.ok) {
        return {
          ok: false,
          error: codecFailure(input, ktx2Codec, ctx.transcodeCaps, parsed.error),
        };
      }
      const projectedColorSpace = ktx2ColorSpace(parsed.value);
      if (projectedColorSpace === undefined || projectedColorSpace !== colorSpace) {
        return {
          ok: false,
          error: codecContextFailure(
            input,
            ktx2Codec,
            ctx.transcodeCaps,
            {
              code: 'ktx2-color-space-mismatch',
              detail: {
                authoredColorSpace: colorSpace,
                dfdColorSpace: projectedColorSpace ?? 'unknown',
              },
            },
            'Basis KTX2 DFD transfer function matching the texture colorSpace',
            'align the texture payload colorSpace with the KTX2 DFD and re-cook the source',
          ),
        };
      }
      const target = selectTranscodeTarget(
        { model, srgb: colorSpace === 'srgb', channels: 'rgba' },
        ctx.transcodeCaps,
      );
      const transcoded = await transcodeKtx2(parsed.value, target);
      if (!transcoded.ok) {
        return {
          ok: false,
          error: codecFailure(input, ktx2Codec, ctx.transcodeCaps, transcoded.error, target),
        };
      }
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
      if (error instanceof AssetError) return { ok: false, error };
      return {
        ok: false,
        error: new AssetError({
          code: 'asset-fetch-failed',
          expected: 'loadable Basis KTX2 texture artifact',
          hint: error instanceof Error ? error.message : String(error),
          detail: {
            sourcePath: input.guid,
            codecCode: 'runtime-loader-exception',
            codecExpected: 'loadable Basis KTX2 texture artifact',
            codecHint: error instanceof Error ? error.message : String(error),
            codecDetail: { reason: 'runtime-loader-exception' },
            container: ktx2Codec.container ?? 'ktx2',
            ...(ktx2Codec.profile === undefined ? {} : { profile: ktx2Codec.profile }),
            capabilities: ctx.transcodeCaps,
          },
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
      format: (payload.format ??
        (colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm')) as GPUTextureFormat,
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

export const renderPipelineLoader: Loader = {
  kind: 'render-pipeline',
  load: (payload) => renderPipelineDescriptor({ ...payload, kind: 'render-pipeline' }),
  loadPack: async (input) => {
    if (firstArtifact(input) === undefined) {
      const value = renderPipelineDescriptor({ ...input.payload, kind: 'render-pipeline' });
      return value === undefined
        ? invalidPackAsset<RenderPipelineAsset>(input, 'a valid render-pipeline descriptor')
        : { ok: true, value };
    }
    const payload = readJsonArtifact(input, 'render-pipeline');
    const value = payload === undefined ? undefined : renderPipelineDescriptor(payload);
    return payload === undefined
      ? invalidPackAsset<RenderPipelineAsset>(input, 'render-pipeline JSON descriptor artifact')
      : value === undefined
        ? invalidPackAsset<RenderPipelineAsset>(input, 'a complete render-pipeline descriptor')
        : { ok: true, value };
  },
};

export const tilesetLoader: Loader = {
  kind: 'tileset',
  load: (payload, refs) => {
    const rawAtlases = payload.atlases;
    const resolved = Array.isArray(rawAtlases)
      ? rawAtlases.map((value) => (typeof value === 'number' ? refs?.[value] : value))
      : undefined;
    return resolved === undefined || resolved.some((value) => typeof value !== 'string')
      ? undefined
      : tilesetDescriptor({ ...payload, kind: 'tileset', atlases: resolved }, resolved);
  },
  loadPack: async (input) => {
    if (firstArtifact(input) === undefined) {
      const value = tilesetDescriptor({ ...input.payload, kind: 'tileset' }, input.refs);
      return value === undefined
        ? invalidPackAsset<TilesetAsset>(input, 'a valid tileset descriptor')
        : { ok: true, value };
    }
    const payload = readJsonArtifact(input, 'tileset');
    const value = payload === undefined ? undefined : tilesetDescriptor(payload, input.refs);
    return payload === undefined
      ? invalidPackAsset<TilesetAsset>(input, 'tileset JSON descriptor artifact')
      : value === undefined
        ? invalidPackAsset<TilesetAsset>(input, 'a tileset descriptor matching envelope refs')
        : { ok: true, value };
  },
};

export const PACK_ARTIFACT_LOADERS: readonly Loader[] = [
  textureLoader,
  fontLoader,
  equirectLoader,
  renderPipelineLoader,
  tilesetLoader,
];
