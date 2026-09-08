/** Open service vocabulary projected onto Cordis Context by capability packages. */
// biome-ignore lint/suspicious/noEmptyInterface: domain packages augment this interface
export interface EngineContextServices {}

declare module '@deepseek-ai/cordis' {
  interface Context extends EngineContextServices {}
}

export * from '@deepseek-ai/cordis';
export { createContextCapabilityResolver } from './capability.js';
export {
  bootstrapCatalogLoader,
  CatalogLoader,
  type CatalogLoaderBootstrapOptions,
  type CatalogLoaderBootstrapResult,
  type CatalogLoaderBootstrapValue,
  CatalogLoaderError,
  type CatalogLoaderErrorCode,
  type GamePluginEntry,
  installCatalogLoader,
  type PluginCatalog,
  type PluginCatalogRecord,
  type PluginRealm,
  projectPluginEntries,
} from './loader.js';
export {
  defineToolPlugin,
  isToolPlugin,
  type ToolPlugin,
} from './tool-plugin.js';
