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
    // @forgeax/engine-remote/server is imported via dynamic import() only
    // (createApp dev-mode serve path, feat-20260629 M4). It depends on `ws`,
    // which pulls Node built-ins (stream / zlib / events). Mark external so the
    // dynamic import stays intact and ws never enters the app bundle (physical
    // isolation: the runtime/app bundle must not carry the remote WS payload).
    '@forgeax/engine-remote',
    '@forgeax/engine-remote/server',
  ],
});
