import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyContinuousLines } from './continuous-lines.fixture';

it('renders continuous and dashed lines and proves RHI replay in Browser WebGPU', async () => {
  await verifyContinuousLines({
    shaderManifestUrl: '/shaders/manifest.json',
    save: async (name, bytes) => {
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      await commands.writeFile(
        `artifacts/continuous-lines/browser/${name}`,
        btoa(binary),
        'base64',
      );
    },
  });
}, 120_000);
