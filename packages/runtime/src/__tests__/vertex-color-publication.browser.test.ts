import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyVertexColorPublication } from './vertex-color-publication.fixture';

declare module 'vitest/browser' {
  interface BrowserCommands {
    startVertexColorPublication(): Promise<{ url: string; guid: string }>;
    stopVertexColorPublication(url: string): Promise<void>;
  }
}
it('renders cooked vertex colors after JSON transport and geometry changes on WebGPU', async () => {
  const server = await commands.startVertexColorPublication();
  try {
    await verifyVertexColorPublication({
      ...server,
      shaderManifestUrl: '/shaders/manifest.json',
      warmupFrames: import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 8 : 60,
    });
  } finally {
    await commands.stopVertexColorPublication(server.url);
  }
}, 120_000);
