declare module 'css-tree' {
  export function parse(source: string, options?: { readonly positions?: boolean }): unknown;
}
