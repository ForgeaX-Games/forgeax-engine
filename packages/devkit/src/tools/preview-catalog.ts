import type { PluginCatalog, ToolPlugin } from '@forgeax/engine-plugin';
import { bindPreviewHost, type NativePreviewHost } from '@forgeax/engine-preview';
import materialPreviewPlugin from '@forgeax/engine-preview/material';
import meshPreviewPlugin from '@forgeax/engine-preview/mesh';
import texturePreviewPlugin from '@forgeax/engine-preview/texture';
import vfxPreviewPlugin from '@forgeax/engine-preview/vfx';
import type { ToolDescriptor } from '@forgeax/engine-tool-runtime';

export const nativePreviewPlugins = [
  ['@forgeax/engine-preview/material', materialPreviewPlugin],
  ['@forgeax/engine-preview/mesh', meshPreviewPlugin],
  ['@forgeax/engine-preview/vfx', vfxPreviewPlugin],
  ['@forgeax/engine-preview/texture', texturePreviewPlugin],
] as const;

export const nativePreviewTools = nativePreviewPlugins.flatMap(([, plugin]) => plugin.tools);
export const nativePreviewDescriptors: readonly ToolDescriptor[] = nativePreviewTools.map(
  ({ descriptor }) => descriptor,
);

export function createNativePreviewCatalog(
  host: NativePreviewHost,
  selectedName?: string,
): PluginCatalog {
  return new Map(
    nativePreviewPlugins
      .filter(([name]) => selectedName === undefined || name === selectedName)
      .map(([name, plugin]) => [
        name,
        {
          realm: 'host' as const,
          load: async () => ({
            default: bindPreviewHost(plugin as ToolPlugin, host),
          }),
        },
      ]),
  );
}
