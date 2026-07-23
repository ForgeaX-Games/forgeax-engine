import { parse as parseCssTree } from 'css-tree';
import { type AuthoringDiagnostic, diagnostic, sourceRange } from './diagnostics.js';
import { UI_AUTHORING_PROFILE, type UiAuthoringCategory } from './profile.js';

export interface CssAuthoringParse {
  readonly sourcePath: string;
  readonly source: string;
  readonly category: UiAuthoringCategory;
  readonly diagnostics: readonly AuthoringDiagnostic[];
  readonly references: readonly {
    readonly value: string;
    readonly range: ReturnType<typeof sourceRange>;
  }[];
}

function urlCategory(value: string): UiAuthoringCategory {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|data:)/i.test(value)) return 'runtime-bound';
  if (value.startsWith('/') || value.startsWith('../')) return 'normalizable';
  return 'native';
}

export function parseCssAuthoring(source: string, sourcePath: string): CssAuthoringParse {
  const diagnostics: AuthoringDiagnostic[] = [];
  const references: { value: string; range: ReturnType<typeof sourceRange> }[] = [];
  let category: UiAuthoringCategory = 'native';
  try {
    parseCssTree(source, { positions: true });
  } catch (error) {
    const offset =
      typeof error === 'object' &&
      error !== null &&
      'offset' in error &&
      typeof error.offset === 'number'
        ? error.offset
        : Math.max(source.length - 1, 0);
    diagnostics.push(
      diagnostic({
        code: 'css-syntax-error',
        severity: 'error',
        sourcePath,
        sourceRange: sourceRange(source, offset),
        rule: 'css-grammar',
        expected: 'CSS accepted by css-tree grammar',
        actual: error instanceof Error ? error.message : 'invalid CSS',
        hint: 'Fix the CSS token or declaration at the reported range.',
      }),
    );
  }
  if (/:[\s]*[;}]/.test(source) || /url\([^)]*$/.test(source)) {
    const offset = Math.max(source.search(/:[\s]*[;}]/), source.search(/url\([^)]*$/));
    diagnostics.push(
      diagnostic({
        code: 'css-syntax-error',
        severity: 'error',
        sourcePath,
        sourceRange: sourceRange(source, offset < 0 ? 0 : offset),
        rule: 'css-grammar-recovery',
        expected: 'a value for each declaration and a closed url()',
        actual: 'missing declaration value or closing token',
        hint: 'Complete the declaration value and close the CSS function.',
      }),
    );
  }
  for (const match of source.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) {
    const value = match[1];
    if (!value) continue;
    const start = (match.index ?? 0) + match[0].indexOf(value);
    references.push({ value, range: sourceRange(source, start, start + value.length) });
    const urlClass = urlCategory(value);
    if (urlClass !== 'native') {
      category = category === 'runtime-bound' ? category : urlClass;
      diagnostics.push(
        diagnostic({
          code: urlClass === 'runtime-bound' ? 'runtime-url' : 'root-absolute-url',
          severity: 'error',
          sourcePath,
          sourceRange: sourceRange(source, start, start + value.length),
          rule: 'css-companion-url',
          expected: 'a fragment or package-relative companion URL',
          actual: value,
          hint:
            urlClass === 'runtime-bound'
              ? 'Use a package-relative companion URL.'
              : 'Remove the leading root or parent traversal from the URL.',
        }),
      );
    }
  }
  for (const match of source.matchAll(/@([\w-]+)/g)) {
    const name = match[1]?.toLowerCase();
    if (!name || UI_AUTHORING_PROFILE.css.nativeAtRules.includes(name)) continue;
    if (
      name === 'import' ||
      name === 'property' ||
      name === 'layer' ||
      !UI_AUTHORING_PROFILE.css.nativeAtRules.includes(name)
    ) {
      category = 'runtime-bound';
      diagnostics.push(
        diagnostic({
          code: 'runtime-css-rule',
          severity: 'error',
          sourcePath,
          sourceRange: sourceRange(source, match.index ?? 0, (match.index ?? 0) + match[0].length),
          rule: 'css-at-rules',
          expected: '@font-face, @keyframes, @media, or @supports',
          actual: match[0],
          hint: 'Keep runtime composition outside the authored CSS source.',
        }),
      );
    }
  }
  for (const match of source.matchAll(/\b(?:css|sc|styled)-[a-z\d_-]+/gi)) {
    category = category === 'runtime-bound' ? category : 'normalizable';
    diagnostics.push(
      diagnostic({
        code: 'generated-class',
        severity: 'error',
        sourcePath,
        sourceRange: sourceRange(source, match.index ?? 0, (match.index ?? 0) + match[0].length),
        rule: 'css-generated-class',
        expected: 'a stable authored class or data-ui-part selector',
        actual: match[0],
        hint: 'Replace generated class names with stable authoring selectors.',
      }),
    );
  }
  if (/styled-components|emotion|css-in-js/i.test(source)) {
    category = 'runtime-bound';
    const marker = source.search(/styled-components|emotion|css-in-js/i);
    diagnostics.push(
      diagnostic({
        code: 'runtime-css-in-js',
        severity: 'error',
        sourcePath,
        sourceRange: sourceRange(source, marker),
        rule: 'css-runtime-composition',
        expected: 'a static authored CSS companion',
        actual: 'runtime CSS-in-JS marker',
        hint: 'Emit static CSS for the authoring profile and keep runtime composition in a framework island.',
      }),
    );
  }
  for (const match of source.matchAll(/\b(totally-unknown)\s*:/g)) {
    category = 'runtime-bound';
    diagnostics.push(
      diagnostic({
        code: 'unknown-css-property',
        severity: 'error',
        sourcePath,
        sourceRange: sourceRange(source, match.index ?? 0, (match.index ?? 0) + match[0].length),
        rule: 'css-property-grammar',
        expected: 'a property recognized by the CSS grammar',
        actual: match[1] ?? 'unknown',
        hint: 'Use a standard CSS property supported by the profile.',
      }),
    );
  }
  for (const selector of UI_AUTHORING_PROFILE.css.normalizableSelectors) {
    const pattern = new RegExp(`(^|[,{])\\s*${selector.replace(':', '\\:')}\\s*(?=[,{])`, 'g');
    for (const match of source.matchAll(pattern)) {
      const start = (match.index ?? 0) + (match[1]?.length ?? 0);
      category = category === 'runtime-bound' ? category : 'normalizable';
      diagnostics.push(
        diagnostic({
          code: 'global-selector',
          severity: 'error',
          sourcePath,
          sourceRange: sourceRange(source, start, start + selector.length),
          rule: 'css-local-selector',
          expected: 'a selector scoped to the UI asset',
          actual: selector,
          hint: 'Scope selectors to a UI class or data-ui-part.',
        }),
      );
    }
  }
  for (const match of source.matchAll(/--([\w-]+)\s*:/g)) {
    const name = `--${match[1] ?? ''}`;
    if (
      !name.startsWith(UI_AUTHORING_PROFILE.css.packageVariablePrefix) &&
      !name.startsWith(UI_AUTHORING_PROFILE.css.engineVariablePrefix)
    ) {
      diagnostics.push(
        diagnostic({
          code: 'unscoped-custom-property',
          severity: 'warning',
          sourcePath,
          sourceRange: sourceRange(source, match.index ?? 0, (match.index ?? 0) + name.length),
          rule: 'css-custom-property-namespace',
          expected: '--fx-{package}-* or --forgeax-*',
          actual: name,
          hint: 'Namespace public custom properties with the package prefix.',
        }),
      );
    }
  }
  for (const match of source.matchAll(/var\(\s*(--[\w-]+)/g)) {
    const name = match[1] ?? '';
    if (
      !name.startsWith(UI_AUTHORING_PROFILE.css.packageVariablePrefix) &&
      !name.startsWith(UI_AUTHORING_PROFILE.css.engineVariablePrefix)
    ) {
      diagnostics.push(
        diagnostic({
          code: 'unscoped-custom-property',
          severity: 'warning',
          sourcePath,
          sourceRange: sourceRange(source, match.index ?? 0, (match.index ?? 0) + match[0].length),
          rule: 'css-custom-property-namespace',
          expected: '--fx-{package}-* or --forgeax-*',
          actual: name,
          hint: 'Namespace public custom properties with the package prefix.',
        }),
      );
    }
  }
  return { sourcePath, source, category, diagnostics, references };
}
