// apps/hello/shadow-opt-out -- ambient declarations.
//
// `@forgeax/engine-vite-plugin-shader` transforms `*.wgsl` modules into a
// `{ hash, wgsl }` JS module. The cutout-shadow demo imports its
// custom shadow shader directly to feed `registerMaterialShader`.

declare module '*.wgsl' {
  const value: { readonly hash: string; readonly wgsl: string };
  export default value;
}

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
