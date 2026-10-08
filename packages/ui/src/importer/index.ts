import {
  type ImportContext,
  ImportError,
  type ImportedArtifactBody,
  type ImportProductFinalizeOptions,
  type ImportProductFinalizeResult,
  type ImportResult,
} from '@forgeax/engine-types';
import type { UiAsset } from '../asset.js';
import { classifyUiAuthoring, validateUiAuthoring } from '../authoring/validate.js';
import { isUiLocalization, type UiLocalization } from '../localization/resources.js';
import { finalizeUiArtifact, uiArtifactMimeType } from './finalize.js';

export { cssAssetUrls, validateCssSource } from './css.js';
export {
  finalizeUiArtifact,
  rewriteUiSourceTokens,
  type UiArtifactFinalizeError,
  type UiArtifactFinalizeOptions,
  type UiArtifactFinalizeResult,
  type UiArtifactPayload,
  type UiFinalizedArtifact,
  type UiFinalizedAsset,
  uiArtifactMimeType,
} from './finalize.js';
export { htmlAssetUrls, validateHtmlSource } from './html.js';

export interface UiSource {
  readonly guid: string;
  readonly html: string;
  readonly css: string;
  readonly localization?: UiLocalization;
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

function validationFailure(
  diagnostics: readonly import('@forgeax/engine-types').ImportDiagnostic[],
): ImportResult<UiAsset> {
  return {
    ok: false,
    error: new ImportError({
      code: 'source-validation-failed',
      expected: 'HTML, CSS, and companions within the UiAuthoringProfile',
      hint: 'Inspect err.detail.diagnostics and fix each source-located error.',
      detail: { diagnostics },
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

export function importUiSource(source: UiSource): ImportResult<UiAsset> {
  if (source.localization !== undefined && !isUiLocalization(source.localization))
    return importFailure('invalid localization resources');
  const classification = classifyUiAuthoring({
    sourcePath: `${source.guid}.ui.html`,
    html: source.html,
    css: source.css,
  });
  if (classification.blocking) return validationFailure(classification.diagnostics);
  return {
    ok: true,
    value: {
      assets: [
        {
          guid: source.guid,
          kind: 'ui',
          payload: {
            guid: source.guid,
            html: source.html,
            css: source.css,
            ...(source.localization === undefined ? {} : { localization: source.localization }),
          },
          refs: [],
          artifacts: {},
        },
      ],
      sourceDependencies: [],
    },
  };
}
export function createUiImporter(): {
  readonly key: 'ui';
  import(context: ImportContext): Promise<ImportResult<UiAsset>>;
  finalize(
    product: import('@forgeax/engine-types').ImportProduct<unknown>,
    options: ImportProductFinalizeOptions,
  ): ImportProductFinalizeResult;
} {
  return {
    key: 'ui',
    async import(context) {
      const source = await context.readSource();
      if (!source.ok) return importFailure(`unable to read UI source: ${String(source.error)}`);
      const htmlText = new TextDecoder().decode(source.value);
      const guid = context.subAssets[0]?.guid;
      if (guid === undefined) return importFailure('meta.subAssets must declare one UI GUID');
      const fileName = context.source.slice(context.source.lastIndexOf('/') + 1);
      const cssPath = fileName.replace(/\.ui\.html$/i, '.ui.css');
      const cssRead = await context.readSibling(cssPath);
      if (!cssRead.ok) return importFailure(`missing UI stylesheet companion: ${cssPath}`);
      const cssText = new TextDecoder().decode(cssRead.value);
      const companions = new Map<string, Uint8Array>();
      const validation = await validateUiAuthoring({
        sourcePath: context.source,
        html: htmlText,
        css: cssText,
        readCompanion: async (path) => {
          const read = await context.readSibling(path);
          if (read.ok) companions.set(path, read.value);
          return read.ok
            ? { ok: true as const }
            : {
                ok: false as const,
                path,
                reason:
                  'reason' in read.error.detail ? read.error.detail.reason : read.error.message,
              };
        },
      });
      if (!validation.ok) {
        if ('diagnostics' in validation.error.detail)
          return validationFailure(validation.error.detail.diagnostics);
        return importFailure(validation.error.message);
      }
      let localization: UiLocalization | undefined;
      const localizationPath = context.importSettings.localization;
      if (localizationPath !== undefined) {
        const path =
          typeof localizationPath === 'string' ? relativePath(localizationPath) : undefined;
        if (!path || path !== localizationPath || /[:\\]/.test(path) || !path.endsWith('.json'))
          return importFailure('importSettings.localization must name a relative JSON companion');
        const read = await context.readSibling(path);
        if (!read.ok) return importFailure(`missing UI localization companion: ${path}`);
        try {
          if (read.value.byteLength > 1_048_576) throw new Error('resource exceeds 1 MiB');
          const parsed: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(read.value),
          );
          if (!isUiLocalization(parsed))
            throw new Error(
              'expected string-valued i18next resources with fallbackLng and defaultNS',
            );
          localization = parsed;
        } catch (error) {
          return validationFailure([
            {
              code: 'ui-localization-invalid',
              severity: 'error',
              sourcePath: path,
              sourceRange: { start: 0, end: 1, line: 1, column: 1 },
              rule: 'ui-localization-json',
              expected: 'valid i18next JSON resources, at most 1 MiB and 16 levels',
              actual: String(error),
              hint: 'Repair this JSON companion, then reimport the owning UI asset.',
            },
          ]);
        }
      }
      const unique = [...new Set(validation.value.references)];
      const artifacts: Record<string, ImportedArtifactBody> = {};
      const dependencies = [
        context.source,
        cssPath,
        ...(typeof localizationPath === 'string' ? [localizationPath] : []),
      ];
      let htmlOut = htmlText;
      let cssOut = cssText;
      for (const reference of unique) {
        const path = relativePath(reference);
        if (path === undefined) return importFailure(`unsafe UI companion URL: ${reference}`);
        const bytes = companions.get(reference.split(/[?#]/, 1)[0] ?? '');
        if (bytes === undefined) return importFailure(`missing UI companion: ${path}`);
        dependencies.push(path);
        artifacts[path] = {
          mediaType: uiArtifactMimeType(path) ?? 'application/octet-stream',
          bytes,
        };
        const token = `ui-token:${path}`;
        htmlOut = htmlOut.replaceAll(reference, token);
        cssOut = cssOut.replaceAll(reference, token);
      }
      return {
        ok: true,
        value: {
          assets: [
            {
              guid,
              kind: 'ui',
              payload: {
                guid,
                html: htmlOut,
                css: cssOut,
                ...(localization === undefined ? {} : { localization }),
              },
              refs: [],
              artifacts,
            },
          ],
          sourceDependencies: dependencies,
        },
      };
    },
    finalize(product, options) {
      return finalizeUiArtifact(product, options);
    },
  };
}
