import { describe, expect, it } from 'vitest';
import { createUiDependencyIndex } from '../dev/ui-dependency-index.js';

const TARGET = 'target-guid';
const OTHER = 'other-guid';

describe('failed UI dependency projection', () => {
  it('retains failed source paths and maps only the matching GUID', () => {
    const index = createUiDependencyIndex();
    index.recordSuccess(OTHER, ['other.ui.html', 'other.ui.css', 'other.png']);
    index.recordFailure({
      guid: TARGET,
      sourcePath: 'target.ui.html',
      diagnostics: [
        { sourcePath: 'target.ui.html' },
        { sourcePath: 'target.ui.css' },
        { sourcePath: 'target.png' },
      ],
      revision: 3,
    });

    expect(index.guidsForSource('target.ui.html')).toEqual([TARGET]);
    expect(index.guidsForSource('target.ui.css')).toEqual([TARGET]);
    expect(index.guidsForSource('target.png')).toEqual([TARGET]);
    expect(index.guidsForSource('other.ui.html')).toEqual([OTHER]);
    expect(index.change('target.ui.css', 4)).toEqual({
      guids: [TARGET],
      sourcePath: 'target.ui.css',
      revision: 4,
    });
  });

  it('projects a failed source without a prior successful product', () => {
    const index = createUiDependencyIndex();
    index.recordFailure({
      guid: TARGET,
      sourcePath: 'fresh.ui.html',
      diagnostics: [],
      revision: 1,
    });
    expect(index.guidsForSource('fresh.ui.html')).toEqual([TARGET]);
    expect(index.change('fresh.ui.html', 2)).toEqual({
      guids: [TARGET],
      sourcePath: 'fresh.ui.html',
      revision: 2,
    });
  });
});
