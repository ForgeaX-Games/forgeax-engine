import type { SourceLocation, ValidationError } from './html.js';
export type CssValidation =
  | { readonly ok: true; readonly value: { readonly css: string } }
  | { readonly ok: false; readonly error: ValidationError };
function location(source: string, index: number): SourceLocation {
  const before = source.slice(0, index);
  return {
    start: index,
    end: index + 1,
    line: before.split('\n').length,
    column: index - before.lastIndexOf('\n'),
  };
}
export function validateCssSource(source: string): CssValidation {
  const remote = /@import\b|url\(\s*["']?(?:[a-z][a-z0-9+.-]*:|\/\/|\/|\.\.\/)/i.exec(source);
  if (remote?.index !== undefined)
    return {
      ok: false,
      error: {
        code: 'unsafe-html',
        message: 'Remote or escaping CSS URL is not allowed',
        location: location(source, remote.index),
      },
    };
  return { ok: true, value: { css: source } };
}

export function cssAssetUrls(source: string): readonly string[] {
  const urls: string[] = [];
  const pattern = /url\(\s*["']?([^"')\s]+)["']?\s*\)/gi;
  for (const match of source.matchAll(pattern)) {
    const value = match[1];
    if (value !== undefined) urls.push(value);
  }
  return urls;
}
