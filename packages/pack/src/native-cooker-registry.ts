import { createHash } from 'node:crypto';
import type {
  ArtifactDescriptor,
  AssetCodec,
  AssetStageError,
  CookProduct,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

export interface NativeCookArtifact {
  readonly mediaType: string;
  readonly assetCodec?: AssetCodec;
  readonly bytes: Uint8Array;
}

export interface NativeCookDraft<P = unknown> {
  readonly guid: string;
  readonly payload: P;
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, NativeCookArtifact>>;
  readonly inputFingerprint: string;
}

export interface NativeCooker<P = unknown, I = unknown> {
  readonly key: string;
  cook(input: I): NativeCookDraft<P> | Promise<NativeCookDraft<P>>;
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function digestDraft<P>(draft: NativeCookDraft<P>): string {
  const bytes = JSON.stringify(
    canonicalize({
      guid: draft.guid,
      payload: draft.payload,
      refs: draft.refs,
      artifacts: draft.artifacts,
    }),
  );
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

type NativeCookErrorDetail = Extract<
  AssetStageError['detail'],
  { readonly guid: string; readonly producer: string }
>;

function failure(key: string, detail: NativeCookErrorDetail): Result<never, AssetStageError> {
  return err({
    stage: 'native-cook',
    code: 'native-cook-failed',
    expected: 'a registered native cooker to produce a complete draft',
    hint: 'register the cooker or repair its draft, then rerun recovery',
    detail,
    recovery: { action: `rerun native cooker ${key}`, retryable: true },
  });
}

/** Injectable build-time table for native authored Pack producers. */
export class NativeCookerRegistry {
  private readonly cookers = new Map<string, NativeCooker>();

  register(cooker: NativeCooker): void {
    if (typeof cooker.key !== 'string' || cooker.key.length === 0) {
      throw new TypeError('NativeCookerRegistry.register: key must be a non-empty string');
    }
    if (typeof cooker.cook !== 'function') {
      throw new TypeError(`NativeCookerRegistry.register: cooker ${cooker.key} must expose cook`);
    }
    this.cookers.set(cooker.key, cooker);
  }

  get(key: string): NativeCooker | undefined {
    return this.cookers.get(key);
  }

  registeredCookers(): readonly string[] {
    return [...this.cookers.keys()];
  }

  async runDraft<P = unknown, I = unknown>(
    key: string,
    input: I,
  ): Promise<Result<NativeCookDraft<P>, AssetStageError>> {
    const cooker = this.cookers.get(key) as NativeCooker<P, I> | undefined;
    if (cooker === undefined) {
      return failure(key, { guid: 'unknown', producer: key });
    }
    let draft: NativeCookDraft<P>;
    try {
      draft = await cooker.cook(input);
    } catch (error) {
      return failure(key, { guid: 'unknown', producer: String(error) });
    }
    if (
      draft.guid.length === 0 ||
      draft.inputFingerprint.length === 0 ||
      !Array.isArray(draft.refs) ||
      typeof draft.payload !== 'object' ||
      draft.payload === null ||
      typeof draft.artifacts !== 'object' ||
      draft.artifacts === null ||
      Object.entries(draft.artifacts).some(
        ([, artifact]) =>
          artifact === null ||
          typeof artifact !== 'object' ||
          typeof artifact.mediaType !== 'string' ||
          artifact.mediaType.length === 0 ||
          !(artifact.bytes instanceof Uint8Array),
      )
    ) {
      return failure(key, { guid: draft.guid || 'unknown', producer: key });
    }
    return ok(draft);
  }

  async run<P = unknown, I = unknown>(
    key: string,
    input: I,
  ): Promise<Result<CookProduct<P>, AssetStageError>> {
    const draftResult = await this.runDraft<P, I>(key, input);
    if (!draftResult.ok) return draftResult;
    const draft = draftResult.value;
    const digest = digestDraft(draft);
    const artifacts: Record<string, ArtifactDescriptor> = {};
    for (const [path, artifact] of Object.entries(draft.artifacts)) {
      artifacts[path] = {
        path,
        mediaType: artifact.mediaType,
        ...(artifact.assetCodec === undefined ? {} : { assetCodec: artifact.assetCodec }),
        byteLength: artifact.bytes.byteLength,
      };
    }
    const receipt = {
      guid: draft.guid,
      origin: 'authoredPack' as const,
      status: 'succeeded' as const,
      inputFingerprint: draft.inputFingerprint,
      outputDigest: digest,
    };
    const product: CookProduct<P> = {
      guid: draft.guid,
      payload: draft.payload,
      refs: draft.refs,
      artifacts,
      digest,
      receipt,
    };
    return ok(product);
  }
}
