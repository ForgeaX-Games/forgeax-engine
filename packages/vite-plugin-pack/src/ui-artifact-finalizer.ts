import type { ImportedArtifact, ImportProduct, PackIndexEntry } from '@forgeax/engine-types';
import { productArtifactsByPath } from './import-products.js';

export interface UiArtifactPayload {
  readonly guid: string;
  readonly html: string;
  readonly css: string;
  readonly actions?: Readonly<Record<string, string>>;
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
  readonly artifactUrl: (artifact: ImportedArtifact) => string;
}

const TOKEN = /ui-token:([^\s"')>]+)/g;

export function uiArtifactMimeType(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.woff2')) return 'font/woff2';
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

export function createUiCatalogRow(input: {
  readonly guid: string;
  readonly sourcePath: string;
  readonly relativeUrl: string;
}): PackIndexEntry {
  return {
    guid: input.guid,
    kind: 'ui',
    sourcePath: input.sourcePath,
    relativeUrl: input.relativeUrl,
  };
}

/**
 * Remove stale source/DDC rows for UI GUIDs after production finalization.
 * A workspace may contain both the author sidecar and a previously generated
 * `.pack.json`; the shipped catalog must expose only the finalized `.ui.json`
 * payload for each primary UI GUID.
 */
export function dedupeFinalizedUiEntries(
  entries: readonly PackIndexEntry[],
  finalizedUrls: ReadonlyMap<string, string>,
): PackIndexEntry[] {
  return entries.filter((entry) => {
    const finalizedUrl = finalizedUrls.get(entry.guid.toLowerCase());
    return (
      finalizedUrl === undefined || (entry.kind === 'ui' && entry.relativeUrl === finalizedUrl)
    );
  });
}

function rewrite(
  value: string,
  artifacts: ReadonlyMap<string, ImportedArtifact>,
  url: UiArtifactFinalizeOptions['artifactUrl'],
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly token: string } {
  const urls = new Map<string, string>();
  for (const [path, artifact] of artifacts) urls.set(path, url(artifact));
  return rewriteUiSourceTokens(value, urls);
}

export function finalizeUiArtifact(
  product: ImportProduct<UiArtifactPayload>,
  options: UiArtifactFinalizeOptions,
): UiArtifactFinalizeResult {
  const asset = product.assets[0];
  if (asset === undefined || asset.kind !== 'ui') {
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
  const artifacts = productArtifactsByPath(product);
  const html = rewrite(payload.html, artifacts, options.artifactUrl);
  const css = rewrite(payload.css, artifacts, options.artifactUrl);
  if (!html.ok) {
    return {
      ok: false,
      error: {
        code: 'ui-artifact-token-unresolved',
        expected: 'every ui-token reference to resolve to an imported artifact',
        hint: 'Add the referenced companion artifact to the ImportProduct before transport.',
        detail: { token: html.token, guid: asset.guid },
      },
    };
  }
  if (!css.ok) {
    return {
      ok: false,
      error: {
        code: 'ui-artifact-token-unresolved',
        expected: 'every ui-token reference to resolve to an imported artifact',
        hint: 'Add the referenced companion artifact to the ImportProduct before transport.',
        detail: { token: css.token, guid: asset.guid },
      },
    };
  }
  return {
    ok: true,
    value: {
      asset: {
        ...payload,
        html: html.value,
        css: css.value,
      },
      artifacts: product.artifacts.map(({ path, mimeType }) => ({ path, mimeType })),
    },
  };
}
