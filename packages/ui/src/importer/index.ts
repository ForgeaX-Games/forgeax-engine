import {
  type ImportContext,
  ImportError,
  type ImportedArtifact,
  type ImportResult,
} from '@forgeax/engine-types';
import type { UiAsset } from '../asset.js';
import { cssAssetUrls, validateCssSource } from './css.js';
import { htmlAssetUrls, validateHtmlSource } from './html.js';

export { cssAssetUrls, validateCssSource } from './css.js';
export { htmlAssetUrls, validateHtmlSource } from './html.js';

export interface UiSource {
  readonly guid: string;
  readonly html: string;
  readonly css: string;
}

function importFailure(reason: string): ImportResult<UiAsset> {
  return {
    ok: false,
    error: new ImportError({
      code: 'import-internal-error',
      expected: 'a valid UI author source and readable local companions',
      hint: 'Fix the UI source or add the referenced companion file.',
      detail: { reason },
    }),
  };
}

function relativePath(reference: string): string | undefined {
  const clean = reference.split(/[?#]/, 1)[0] ?? '';
  if (clean.length === 0 || clean.startsWith('/') || clean.startsWith('\\')) return undefined;
  const parts = clean.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

function mimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  if (lower.endsWith('.woff')) return 'font/woff';
  return 'application/octet-stream';
}

export function importUiSource(source: UiSource): ImportResult<UiAsset> {
  const html = validateHtmlSource(source.html);
  if (!html.ok)
    return importFailure(
      `${html.error.message} at ${html.error.location.line}:${html.error.location.column}`,
    );
  const css = validateCssSource(source.css);
  if (!css.ok)
    return importFailure(
      `${css.error.message} at ${css.error.location.line}:${css.error.location.column}`,
    );
  return {
    ok: true,
    value: {
      assets: [
        {
          guid: source.guid,
          kind: 'ui',
          payload: { guid: source.guid, html: html.value, css: css.value.css },
          refs: [],
        },
      ],
      artifacts: [],
      sourceDependencies: [],
    },
  };
}
export function createUiImporter(): {
  import(context: ImportContext): Promise<ImportResult<UiAsset>>;
} {
  return {
    async import(context) {
      const source = await context.readSource();
      if (!source.ok) return importFailure(`unable to read UI source: ${String(source.error)}`);
      const htmlText = new TextDecoder().decode(source.value);
      const guid = context.subAssets[0]?.guid;
      if (guid === undefined) return importFailure('meta.subAssets must declare one UI GUID');
      const html = validateHtmlSource(htmlText);
      if (!html.ok)
        return importFailure(
          `${html.error.message} at ${html.error.location.line}:${html.error.location.column}`,
        );

      const fileName = context.source.slice(context.source.lastIndexOf('/') + 1);
      const cssPath = fileName.replace(/\.ui\.html$/i, '.ui.css');
      const cssRead = await context.readSibling(cssPath);
      if (!cssRead.ok) return importFailure(`missing UI stylesheet companion: ${cssPath}`);
      const cssText = new TextDecoder().decode(cssRead.value);
      const css = validateCssSource(cssText);
      if (!css.ok)
        return importFailure(
          `${css.error.message} at ${css.error.location.line}:${css.error.location.column}`,
        );

      const references = [...htmlAssetUrls(html.value), ...cssAssetUrls(css.value.css)];
      const unique = [...new Set(references)];
      const artifacts: ImportedArtifact[] = [];
      const dependencies = [context.source, cssPath];
      let htmlOut = html.value;
      let cssOut = css.value.css;
      for (const reference of unique) {
        const path = relativePath(reference);
        if (path === undefined) return importFailure(`unsafe UI companion URL: ${reference}`);
        const read = await context.readSibling(path);
        if (!read.ok) return importFailure(`missing UI companion: ${path}`);
        dependencies.push(path);
        artifacts.push({ path, mimeType: mimeType(path), bytes: read.value });
        const token = `ui-token:${path}`;
        htmlOut = htmlOut.replaceAll(reference, token);
        cssOut = cssOut.replaceAll(reference, token);
      }
      return {
        ok: true,
        value: {
          assets: [{ guid, kind: 'ui', payload: { guid, html: htmlOut, css: cssOut }, refs: [] }],
          artifacts,
          sourceDependencies: dependencies,
        },
      };
    },
  };
}
