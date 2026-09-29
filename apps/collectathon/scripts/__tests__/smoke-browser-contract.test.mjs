import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = readFileSync(fileURLToPath(new URL('../smoke-browser.mjs', import.meta.url)), 'utf8');

describe('collectathon browser smoke contract', () => {
  it('waits for the scoped Pack producer before opening Chrome', () => {
    expect(script).toMatch(/const MAX_VITE_READINESS_TIMEOUT_MS = 180_000;/);
    expect(script).toMatch(/FORGEAX_COLLECTATHON_VITE_READINESS_TIMEOUT_MS \?\? '180000'/);
    expect(script).toMatch(/const PACK_CATALOG_PATH = '\/__pack\/scopes\/collectathon\/1\/catalog\.json';/);
    expect(script).toMatch(/const waitForScopedPackCatalog = async \(baseUrl\)/);
    expect(script).toMatch(/snapshot\?\.authority !== 'authoritative'/);
    expect(script).toMatch(/await waitForScopedPackCatalog\(portUrl\);/);
  });
});
