import { type ImportDiagnostic, ImportError } from '@forgeax/engine-types';
import { parseCssAuthoring } from './css.js';
import { hasBlockingDiagnostics, serializeDiagnostics } from './diagnostics.js';
import { parseHtmlAuthoring } from './html.js';
import { pickClassification, UI_AUTHORING_PROFILE, type UiAuthoringCategory } from './profile.js';

export * from './css.js';
export * from './diagnostics.js';
export * from './html.js';
export * from './profile.js';

export interface UiAuthoringInput {
  readonly sourcePath: string;
  readonly html: string;
  readonly css: string;
  readonly readCompanion?: (
    path: string,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly path: string; readonly reason: string }
  >;
}

export interface UiAuthoringValue {
  readonly html: string;
  readonly css: string;
  readonly category: UiAuthoringCategory;
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly references: readonly string[];
}

export type UiAuthoringResult =
  | { readonly ok: true; readonly value: UiAuthoringValue }
  | { readonly ok: false; readonly error: ImportError };

export interface UiAuthoringClassification {
  readonly category: UiAuthoringCategory;
  readonly blocking: boolean;
  readonly diagnostics: readonly ImportDiagnostic[];
}

export function classifyUiAuthoring(
  input: Omit<UiAuthoringInput, 'readCompanion'>,
): UiAuthoringClassification {
  const html = parseHtmlAuthoring(input.html, input.sourcePath);
  const css = parseCssAuthoring(input.css, input.sourcePath.replace(/\.html?$/i, '.css'));
  const diagnostics = [...html.diagnostics, ...css.diagnostics];
  const category = pickClassification(
    { category: html.category, blocking: html.category !== 'native' },
    { category: css.category, blocking: css.category !== 'native' },
  );
  return {
    category: category.category,
    blocking: hasBlockingDiagnostics(diagnostics),
    diagnostics,
  };
}

export async function validateUiAuthoring(input: UiAuthoringInput): Promise<UiAuthoringResult> {
  const html = parseHtmlAuthoring(input.html, input.sourcePath);
  const css = parseCssAuthoring(input.css, input.sourcePath.replace(/\.html?$/i, '.css'));
  const diagnostics: ImportDiagnostic[] = [...html.diagnostics, ...css.diagnostics];
  const references = [...html.references, ...css.references];
  if (input.readCompanion) {
    for (const reference of references) {
      const path = reference.value.split(/[?#]/, 1)[0] ?? '';
      if (!path || path.startsWith('#')) continue;
      const companion = await input.readCompanion(path);
      if (!companion.ok) {
        diagnostics.push({
          code: 'companion-missing',
          severity: 'error',
          sourcePath: input.sourcePath,
          sourceRange: reference.range,
          rule: 'companion-readable',
          expected: 'a readable package-relative companion',
          actual: path,
          hint: 'Add the companion file at the attempted path and rerun validation.',
          relatedLocations: [
            { sourcePath: path, sourceRange: { start: 0, end: 1, line: 1, column: 1 } },
          ],
        });
      }
    }
  }
  const classification = pickClassification(
    { category: html.category, blocking: html.category !== 'native' },
    { category: css.category, blocking: css.category !== 'native' },
  );
  if (hasBlockingDiagnostics(diagnostics)) {
    return {
      ok: false,
      error: new ImportError({
        code: 'source-validation-failed',
        expected: 'HTML, CSS, and companions within the UiAuthoringProfile',
        hint: 'Inspect err.detail.diagnostics and fix each error before importing.',
        detail: { diagnostics },
      }),
    };
  }
  return {
    ok: true,
    value: {
      html: input.html,
      css: input.css,
      category: classification.category,
      diagnostics,
      references: references.map((entry) => entry.value),
    },
  };
}

export { serializeDiagnostics, UI_AUTHORING_PROFILE };
