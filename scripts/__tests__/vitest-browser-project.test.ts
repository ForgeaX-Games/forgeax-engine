import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const browserProjectSource = resolve(process.cwd(), 'config/vitest-browser-project.ts');

describe('shared browser shader manifest', () => {
  it('keeps the point-shadow engine entry in the real browser manifest owner', () => {
    const source = readFileSync(browserProjectSource, 'utf8');
    expect(source).toMatch(
      /forgeaxShader\(\{\s*engineEntries:\s*\{\s*pointShadows:\s*true,\s*hdrpSsao:\s*true\s*\},\s*materialPackages\s*\}\)/,
    );
  });
});
