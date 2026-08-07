import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pluginSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

describe('Vite RHI-debug route owner', () => {
  it('does not redeclare the shared production route ledger', () => {
    expect(pluginSource).toContain('@forgeax/engine-rhi-debug/dev-routes');
    expect(pluginSource).not.toMatch(/const (TAPE_ROUTE|TRIGGER_ROUTE|ARTIFACT_ROUTE)\s*=/);
  });
});
