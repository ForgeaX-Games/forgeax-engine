import { type DefaultTreeAdapterTypes, parseFragment } from 'parse5';
import { type AuthoringDiagnostic, diagnostic, sourceRange } from './diagnostics.js';
import { UI_AUTHORING_PROFILE, type UiAuthoringCategory } from './profile.js';

type DocumentFragment = DefaultTreeAdapterTypes.DocumentFragment;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

export interface HtmlAuthoringParse {
  readonly sourcePath: string;
  readonly source: string;
  readonly category: UiAuthoringCategory;
  readonly diagnostics: readonly AuthoringDiagnostic[];
  readonly references: readonly {
    readonly value: string;
    readonly range: ReturnType<typeof sourceRange>;
  }[];
}

const voidElements = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const allowedHookNames = new Set(UI_AUTHORING_PROFILE.html.hooks);
const urlAttributes = new Set(UI_AUTHORING_PROFILE.html.urlAttributes);

function locationFor(source: string, node: Element): ReturnType<typeof sourceRange> {
  const location = node.sourceCodeLocation;
  if (location && 'startTag' in location && location.startTag !== undefined) {
    return sourceRange(source, location.startTag.startOffset, location.startTag.endOffset);
  }
  if (location && 'startOffset' in location)
    return sourceRange(source, location.startOffset, location.endOffset);
  return sourceRange(source, 0);
}

function attributeOffset(
  source: string,
  node: Element,
  name: string,
): ReturnType<typeof sourceRange> {
  const location = node.sourceCodeLocation;
  const attr = location && 'attrs' in location ? location.attrs?.[name] : undefined;
  if (attr) return sourceRange(source, attr.startOffset, attr.endOffset);
  return locationFor(source, node);
}

function rangeOfValue(
  source: string,
  node: Element,
  name: string,
  value: string,
): ReturnType<typeof sourceRange> {
  const attrRange = attributeOffset(source, node, name);
  const offset = source.indexOf(value, attrRange.start);
  return offset < 0 ? attrRange : sourceRange(source, offset, offset + Math.max(value.length, 1));
}

function urlCategory(value: string): UiAuthoringCategory {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|data:)/i.test(value)) return 'runtime-bound';
  if (value.startsWith('/') || value.startsWith('../')) return 'normalizable';
  return 'native';
}

function walk(node: ParentNode, visit: (element: Element) => void): void {
  for (const child of node.childNodes) {
    if (child.nodeName !== '#text' && child.nodeName !== '#comment' && 'tagName' in child) {
      visit(child as Element);
      walk(child as ParentNode, visit);
    }
  }
}

function syntaxDiagnostics(source: string, sourcePath: string): AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  const stack: { name: string; index: number }[] = [];
  const tokenPattern = /<\/?([a-z][\w:-]*)(?:\s[^<>]*?)?\/?\s*>/gi;
  for (const match of source.matchAll(tokenPattern)) {
    const name = match[1]?.toLowerCase();
    if (!name || voidElements.has(name) || match[0]?.startsWith('<!')) continue;
    const start = match.index ?? 0;
    if (match[0]?.startsWith('</')) {
      const last = stack.pop();
      if (last?.name !== name) {
        diagnostics.push(
          diagnostic({
            code: 'html-unbalanced-tag',
            severity: 'error',
            sourcePath,
            sourceRange: sourceRange(source, start, start + match[0].length),
            rule: 'html-grammar',
            expected: `closing </${last?.name ?? 'known element'}>`,
            actual: match[0],
            hint: 'Close HTML elements in their opening order.',
          }),
        );
      }
    } else if (!match[0]?.endsWith('/>')) stack.push({ name, index: start });
  }
  for (const entry of stack) {
    diagnostics.push(
      diagnostic({
        code: 'html-unclosed-tag',
        severity: 'error',
        sourcePath,
        sourceRange: sourceRange(
          source,
          entry.index,
          entry.index + Math.max(entry.name.length + 1, 2),
        ),
        rule: 'html-grammar',
        expected: `closing </${entry.name}>`,
        actual: 'end of source',
        hint: `Add a closing </${entry.name}> tag.`,
      }),
    );
  }
  return diagnostics;
}

export function parseHtmlAuthoring(source: string, sourcePath: string): HtmlAuthoringParse {
  const diagnostics: AuthoringDiagnostic[] = syntaxDiagnostics(source, sourcePath);
  const references: { value: string; range: ReturnType<typeof sourceRange> }[] = [];
  let category: UiAuthoringCategory = 'native';
  const parts = new Set<string>();
  let inputWithoutLabel: Element | undefined;
  const fragment = parseFragment(source, { sourceCodeLocationInfo: true }) as DocumentFragment;
  walk(fragment, (element) => {
    const tag = element.tagName.toLowerCase();
    const elementRange = locationFor(source, element);
    if (tag === 'script' || !UI_AUTHORING_PROFILE.html.nativeElements.includes(tag)) {
      category = 'runtime-bound';
      diagnostics.push(
        diagnostic({
          code: 'runtime-html-surface',
          severity: 'error',
          sourcePath,
          sourceRange: elementRange,
          rule: 'html-native-elements',
          expected: 'a supported semantic HTML element',
          actual: `<${tag}>`,
          hint: 'Move executable or custom runtime markup into a framework island.',
        }),
      );
    }
    if (
      tag === 'template' &&
      !element.attrs.some(
        (attr) => attr.name === 'data-ui-template' && attr.value.trim().length > 0,
      )
    ) {
      category = 'runtime-bound';
      diagnostics.push(
        diagnostic({
          code: 'invalid-template',
          severity: 'error',
          sourcePath,
          sourceRange: elementRange,
          rule: 'html-template-hook',
          expected: 'template[data-ui-template] with a non-empty name',
          actual: '<template>',
          hint: 'Name templates with data-ui-template so the consumer can clone them explicitly.',
        }),
      );
    }
    for (const attr of element.attrs) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      const range = attributeOffset(source, element, attr.name);
      if (name.startsWith('on')) {
        category = 'runtime-bound';
        diagnostics.push(
          diagnostic({
            code: 'runtime-event-handler',
            severity: 'error',
            sourcePath,
            sourceRange: range,
            rule: 'html-event-handlers',
            expected: 'data-ui-action with a consumer-side listener',
            actual: name,
            hint: 'Remove inline event handlers and bind behavior from the framework island.',
          }),
        );
      } else if (name === 'style') {
        category = category === 'runtime-bound' ? category : 'normalizable';
        diagnostics.push(
          diagnostic({
            code: 'inline-style',
            severity: 'error',
            sourcePath,
            sourceRange: range,
            rule: 'html-inline-style',
            expected: 'stylesheet-owned declarations',
            actual: value,
            hint: 'Move inline declarations to the companion CSS source.',
          }),
        );
      } else if (name.startsWith('data-ui-') || name === 'data-framework-island') {
        if (!allowedHookNames.has(name) || value.trim().length === 0) {
          category = 'runtime-bound';
          diagnostics.push(
            diagnostic({
              code: 'invalid-ui-hook',
              severity: 'error',
              sourcePath,
              sourceRange: range,
              rule: 'html-ui-hooks',
              expected: 'a supported non-empty ForgeaX UI hook',
              actual: `${name}=${value}`,
              hint: 'Use data-ui-part, data-ui-action, data-ui-template, or data-framework-island with a non-empty value.',
            }),
          );
        }
        if (name === 'data-ui-part' && value.trim().length > 0) {
          if (parts.has(value))
            diagnostics.push(
              diagnostic({
                code: 'duplicate-ui-part',
                severity: 'warning',
                sourcePath,
                sourceRange: range,
                rule: 'html-ui-part-unique',
                expected: 'one element per data-ui-part value',
                actual: value,
                hint: 'Rename one part so scenario selectors remain unambiguous.',
              }),
            );
          parts.add(value);
        }
      } else if (urlAttributes.has(name) && value.length > 0) {
        const urlClass = urlCategory(value);
        if (urlClass !== 'native') {
          category = category === 'runtime-bound' ? category : urlClass;
          diagnostics.push(
            diagnostic({
              code: urlClass === 'runtime-bound' ? 'runtime-url' : 'root-absolute-url',
              severity: 'error',
              sourcePath,
              sourceRange: rangeOfValue(source, element, attr.name, value),
              rule: 'html-companion-url',
              expected: 'a package-relative companion or #fragment URL',
              actual: value,
              hint:
                urlClass === 'runtime-bound'
                  ? 'Use a package-relative companion URL.'
                  : 'Remove the leading root or parent traversal from the URL.',
            }),
          );
        }
        if (!value.startsWith('#'))
          references.push({ value, range: rangeOfValue(source, element, attr.name, value) });
      }
      if (tag === 'input' && name === 'id') inputWithoutLabel = element;
    }
    if (
      tag === 'input' &&
      !element.attrs.some((attr) => attr.name === 'aria-label' || attr.name === 'aria-labelledby')
    )
      inputWithoutLabel = element;
  });
  if (inputWithoutLabel && !source.includes('<label')) {
    diagnostics.push(
      diagnostic({
        code: 'missing-accessible-label',
        severity: 'warning',
        sourcePath,
        sourceRange: locationFor(source, inputWithoutLabel),
        rule: 'html-accessible-label',
        expected: 'label, aria-label, or aria-labelledby',
        actual: inputWithoutLabel.tagName,
        hint: 'Associate the control with an accessible label.',
      }),
    );
  }
  return { sourcePath, source, category, diagnostics, references };
}
