import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const sourcePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'recorder-core.ts',
);

describe('recorder-core source surface', () => {
  test('keeps tape-format exports owned by tape-format', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const forwardingExports = source.match(
      /^\s*export(?: type)? \{[^}]+\} from ['"]\.\/tape-format['"];\s*$/gm,
    );

    expect(forwardingExports).toEqual(null);
  });
});
