/// <reference types="vite/client" />

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly importTransport?: unknown;
    readonly shaderManifestUrl?: string;
  };
}
