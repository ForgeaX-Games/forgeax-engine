export interface SourceLocation {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}
export interface ValidationError {
  readonly code: 'unsafe-html' | 'invalid-template' | 'invalid-url';
  readonly message: string;
  readonly location: SourceLocation;
}
export type HtmlValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: ValidationError };

function location(source: string, index: number): SourceLocation {
  const before = source.slice(0, index);
  const line = before.split('\n').length;
  return { start: index, end: index + 1, line, column: index - before.lastIndexOf('\n') };
}
export function validateHtmlSource(source: string): HtmlValidation {
  const patterns = [
    /<\/?script\b/i,
    /\bon[a-z]+\s*=/i,
    /\bstyle\s*=/i,
    /<template\b(?![^>]*\bdata-ui-template\s*=)/i,
    /\b(?:href|src)\s*=\s*["'](?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match?.index !== undefined)
      return {
        ok: false,
        error: {
          code: 'unsafe-html',
          message: `Unsafe HTML token: ${match[0]}`,
          location: location(source, match.index),
        },
      };
  }
  return { ok: true, value: source };
}

/** Return local URL references in author HTML, excluding fragment links. */
export function htmlAssetUrls(source: string): readonly string[] {
  const urls: string[] = [];
  const pattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of source.matchAll(pattern)) {
    const value = match[1];
    if (value !== undefined && !value.startsWith('#')) urls.push(value);
  }
  return urls;
}
