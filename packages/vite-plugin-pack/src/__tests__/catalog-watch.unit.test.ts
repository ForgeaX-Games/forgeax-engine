import type { PackIndexEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { calculateCatalogDelta } from '../catalog-watch.js';

const entry = (guid: string, relativeUrl = `/assets/${guid}.bin`): PackIndexEntry => ({
  guid,
  kind: 'texture',
  relativeUrl,
  sourcePath: `${guid}.png`,
});

describe('catalog-watch', () => {
  it('derives the final-state GUID diff with normalized removals', () => {
    const delta = calculateCatalogDelta(
      [
        entry('019e2cc6-0c86-79da-aa76-b0984c86d45a'),
        entry('019e2cc6-0c86-79da-aa76-b0984c86d45b'),
      ],
      [
        {
          ...entry('019e2cc6-0c86-79da-aa76-b0984c86d45a'),
          guid: '019E2CC6-0C86-79DA-AA76-B0984C86D45A',
        },
        entry('019e2cc6-0c86-79da-aa76-b0984c86d45c'),
      ],
    );

    expect(delta).toEqual({
      added: [entry('019e2cc6-0c86-79da-aa76-b0984c86d45c')],
      changed: [],
      removed: ['019e2cc6-0c86-79da-aa76-b0984c86d45b'],
    });
  });

  it('reports changed rows without putting a GUID in more than one set', () => {
    const guid = '019e2cc6-0c86-79da-aa76-b0984c86d45a';
    const delta = calculateCatalogDelta([entry(guid)], [entry(guid, '/assets/rebuilt.bin')]);

    expect(delta).toEqual({
      added: [],
      changed: [entry(guid, '/assets/rebuilt.bin')],
      removed: [],
    });
  });

  it('does not emit a delta when the final projection is unchanged', () => {
    expect(
      calculateCatalogDelta(
        [entry('019e2cc6-0c86-79da-aa76-b0984c86d45a')],
        [entry('019e2cc6-0c86-79da-aa76-b0984c86d45a')],
      ),
    ).toBeUndefined();
  });
});
