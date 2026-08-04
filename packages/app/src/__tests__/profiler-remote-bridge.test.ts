import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BRIDGE_SOURCE = fileURLToPath(
  new URL('../internal/browser-remote-bridge.ts', import.meta.url),
);
const CREATE_APP_SOURCE = fileURLToPath(new URL('../create-app.ts', import.meta.url));

describe('browser remote profiler bridge', () => {
  const bridge = readFileSync(BRIDGE_SOURCE, 'utf8');
  const createApp = readFileSync(CREATE_APP_SOURCE, 'utf8');

  it('propagates the explicit profiler root through the existing bridge context', () => {
    expect(bridge).toContain('readonly profiler?: unknown');
    expect(bridge).toContain('profiler,');
    expect(bridge).toContain('profiler: profiler');
  });

  it('keeps the bridge opt-in and free of a static remote dependency', () => {
    expect(createApp).toContain('VITE_FORGEAX_ENGINE_BRIDGE');
    expect(createApp).toContain("import('./internal/browser-remote-bridge')");
    expect(bridge).not.toMatch(/^import .*@forgeax\/engine-remote/m);
  });

  it('keeps profiler failures in the JSON-safe eval envelope', () => {
    expect(bridge).toContain("code: typeof e.code === 'string' ? e.code : 'script-runtime-error'");
    expect(bridge).toContain('detail');
    expect(bridge).toContain('JSON.stringify(envelope)');
  });
});
