import type { ImportProduct } from '@forgeax/engine-types';
import type { UiAsset } from '../asset.js';

export type UiArtifactPayload = UiAsset;

function isUiArtifactPayload(value: unknown): value is UiArtifactPayload {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.guid === 'string' &&
    typeof candidate.html === 'string' &&
    typeof candidate.css === 'string'
  );
}

export interface UiFinalizedArtifact {
  readonly path: string;
  readonly mimeType: string;
}

export interface UiFinalizedAsset {
  readonly asset: UiArtifactPayload;
  readonly artifacts: readonly UiFinalizedArtifact[];
}

export interface UiArtifactFinalizeError {
  readonly code: 'ui-artifact-token-unresolved' | 'ui-artifact-payload-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly token?: string; readonly guid?: string };
}

export type UiArtifactFinalizeResult =
  | { readonly ok: true; readonly value: UiFinalizedAsset }
  | { readonly ok: false; readonly error: UiArtifactFinalizeError };

export interface UiArtifactFinalizeOptions {
  readonly artifactUrl: (artifact: {
    readonly path: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }) => string;
}

const TOKEN = /ui-token:([^\s"')>]+)/g;

export function uiArtifactMimeType(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  if (lower.endsWith('.woff')) return 'font/woff';
  return undefined;
}

export function rewriteUiSourceTokens(
  source: string,
  urls: ReadonlyMap<string, string>,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly token: string } {
  const rewritten = source.replace(TOKEN, (full, path: string) => urls.get(path) ?? full);
  const unresolved = rewritten.match(TOKEN);
  return unresolved?.[0] === undefined
    ? { ok: true, value: rewritten }
    : { ok: false, token: unresolved[0] };
}

export function finalizeUiArtifact(
  product: Pick<ImportProduct<unknown>, 'assets'>,
  options: UiArtifactFinalizeOptions,
): UiArtifactFinalizeResult {
  const asset = product.assets[0];
  if (asset === undefined || asset.kind !== 'ui' || !isUiArtifactPayload(asset.payload)) {
    return {
      ok: false,
      error: {
        code: 'ui-artifact-payload-invalid',
        expected: 'one ui ImportedAsset with guid, html, and css payload',
        hint: 'Return a validated UI asset before finalizing transport artifacts.',
        detail: {},
      },
    };
  }
  const payload = asset.payload;
  const urls = new Map(
    Object.entries(asset.artifacts).map(([path, artifact]) => [
      path,
      options.artifactUrl({ path, mimeType: artifact.mediaType, bytes: artifact.bytes }),
    ]),
  );
  const finalized = { ...payload };
  for (const field of ['html', 'css'] as const) {
    const rewritten = rewriteUiSourceTokens(finalized[field], urls);
    if (!rewritten.ok) {
      return {
        ok: false,
        error: {
          code: 'ui-artifact-token-unresolved',
          expected: 'every ui-token reference to resolve to an imported artifact',
          hint: 'Add the referenced companion artifact to the ImportProduct before transport.',
          detail: { token: rewritten.token, guid: asset.guid },
        },
      };
    }
    finalized[field] = rewritten.value;
  }
  return {
    ok: true,
    value: {
      asset: finalized,
      artifacts: Object.entries(asset.artifacts).map(([path, artifact]) => ({
        path,
        mimeType: artifact.mediaType,
      })),
    },
  };
}
