import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { pcmRangeFixture } from '../packages/audio-webaudio/src/__tests__/support/pcm-range-fixture';
import { websocketListenerCommands } from '../packages/net-websocket/__tests__/support/ws-listener-commands';
import hostFiles from '../scripts/ci/browser-host-files.json' with { type: 'json' };
import browserLaunch from '../scripts/ci/browser-launch.json' with { type: 'json' };
import { playwrightWithBackgroundPages } from './vitest-browser-provider';

// These contracts use native DOM, WebSocket and Web Audio, without a Renderer.
// Keep Chromium and its interaction/audio policies; do not prepare shader/Pack
// publications or initialize a physical graphics device for this exact roster.
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  // The native project has the same Vitest name. Its live optimized modules
  // must survive Host startup with a different plugin/dependency collection.
  cacheDir: fileURLToPath(new URL('../node_modules/.vite/browser-host', import.meta.url)),
  plugins: [pcmRangeFixture()],
  server: {
    watch: { ignored: ['**/.forgeax-harness/**'] },
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  test: {
    name: 'browser',
    globals: false,
    passWithNoTests: false,
    teardownTimeout: 500,
    include: hostFiles,
    setupFiles: ['config/browser-host-guard.mjs'],
    fileParallelism: false,
    maxWorkers: 1,
    deps: { optimizer: { client: { enabled: false } } },
    browser: {
      enabled: true,
      ui: false,
      commands: websocketListenerCommands,
      provider: playwrightWithBackgroundPages({
        launchOptions: { ...browserLaunch, args: [...browserLaunch.args, '--disable-gpu'] },
      }),
      instances: [{ browser: 'chromium' }],
      headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0' && !!process.env.CI,
    },
  },
});
