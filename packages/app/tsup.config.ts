import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts'],
  external: [
    // @forgeax/engine-rhi-debug is imported via dynamic import() only
    // (FORGEAX_ENGINE_RHI_DEBUG=1 path). Its barrel carries Node.js built-in imports
    // (fs, path, crypto) that are unavailable in browser/neutral platform
    // builds. Marking it as external keeps the dynamic import intact while
    // avoiding esbuild resolution of its transitive Node.js deps.
    '@forgeax/engine-rhi-debug',
  ],
});
