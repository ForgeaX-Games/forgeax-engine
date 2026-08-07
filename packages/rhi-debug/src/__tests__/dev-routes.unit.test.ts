import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { RHI_DEBUG_DEV_ROUTES } from '../dev-routes';

const browserSource = readFileSync(new URL('../capture-browser.ts', import.meta.url), 'utf8');
const cliSource = readFileSync(new URL('../cli.ts', import.meta.url), 'utf8');

describe('RHI-debug dev route owner', () => {
  it('keeps one node-free route vocabulary for production clients', () => {
    expect(RHI_DEBUG_DEV_ROUTES).toEqual({
      tape: '/__forgeax-debug/tape',
      trigger: '/__forgeax-debug/trigger',
      artifact: '/__forgeax-debug/artifact',
    });
    expect(browserSource).not.toMatch(/const TAPE_ROUTE\s*=/);
    expect(cliSource).not.toMatch(/fetch\(`\$\{devUrl\}\/__forgeax-debug\/trigger`/);
  });
});
