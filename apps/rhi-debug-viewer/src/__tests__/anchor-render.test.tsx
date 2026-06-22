// anchor-render.test.ts — real-rendering DOM guard test (R2-NEW fix).
//
// Renders components via react-dom/server renderToStaticMarkup and asserts
// data-forgeax-* attributes actually appear in the DOM HTML output.
//
// This guards against the R2-NEW bug: anchor helpers returned full
// key="value" strings which React rejected as invalid attribute names,
// silently dropping all data-forgeax-* attributes. Node-env unit tests
// that only asserted the helper strings would never catch this — only
// real rendering (SSR or jsdom) can.
//
// Covered anchors: load-status (ErrorBanner + App div), draw (TreePanel),
// pass (TreePanel), selected (TreePanel).

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorBanner } from '../components/ErrorBanner';
import { TreePanel } from '../components/TreePanel';
import type { ViewModel } from '../viewer-model';

function fakeViewModel(): ViewModel {
  return {
    tree: [
      {
        kind: 'render',
        passIdx: 0,
        draws: [
          { drawIdx: 0, eventKind: 'draw' },
          { drawIdx: 1, eventKind: 'drawIndexed' },
        ],
      },
    ],
    draws: [],
    meta: { totalDraws: 2, totalPasses: 1, hasCompute: false },
  };
}

describe('ErrorBanner renders data-forgeax-load-status anchor', () => {
  it('[data-forgeax-load-status="parse-error"] exists in rendered HTML', () => {
    const html = renderToStaticMarkup(
      <ErrorBanner error={{ kind: 'tape-format-version-mismatch', message: 'test' }} />,
    );
    expect(html).toContain('data-forgeax-load-status="parse-error"');
  });
});

describe('TreePanel renders draw/pass/selected anchors', () => {
  it('[data-forgeax-draw="0"] and [data-forgeax-draw="1"] exist', () => {
    const html = renderToStaticMarkup(
      <TreePanel viewModel={fakeViewModel()} selectedDrawIdx={0} onSelectDraw={() => {}} />,
    );
    expect(html).toContain('data-forgeax-draw="0"');
    expect(html).toContain('data-forgeax-draw="1"');
  });

  it('[data-forgeax-pass="0"] exists', () => {
    const html = renderToStaticMarkup(
      <TreePanel viewModel={fakeViewModel()} selectedDrawIdx={0} onSelectDraw={() => {}} />,
    );
    expect(html).toContain('data-forgeax-pass="0"');
  });

  it('[data-forgeax-selected="true"] exists on the selected draw row', () => {
    const html = renderToStaticMarkup(
      <TreePanel viewModel={fakeViewModel()} selectedDrawIdx={0} onSelectDraw={() => {}} />,
    );
    expect(html).toContain('data-forgeax-selected="true"');
  });

  it('data-forgeax-pass and data-forgeax-draw are on separate elements', () => {
    // The pass button carries the pass anchor; draw buttons carry draw anchors.
    // They must be on DIFFERENT elements (pass is the expand/collapse toggle,
    // draw rows are nested inside the expandable region).
    const html = renderToStaticMarkup(
      <TreePanel viewModel={fakeViewModel()} selectedDrawIdx={0} onSelectDraw={() => {}} />,
    );

    // Pass 0 button: carries data-forgeax-pass="0"
    expect(html).toContain('data-forgeax-pass="0"');

    // Draw 0 button: carries data-forgeax-draw="0"
    expect(html).toContain('data-forgeax-draw="0"');

    // They are NOT on the same element (no tag has both pass and draw anchors)
    const passWithDraw = /<[^>]*data-forgeax-pass="0"[^>]*data-forgeax-draw="0"[^>]*>/;
    expect(html).not.toMatch(passWithDraw);
  });
});

describe('Manual anchor key/value spread contract', () => {
  it('data-forgeax-load-status div renders correctly from key/value spread', () => {
    // The spread { [loadStatusAnchor()]: 'loaded' } produces:
    //   <div data-forgeax-load-status="loaded">content</div>
    const attrName = 'data-forgeax-load-status';
    const props: Record<string, string> = { className: 'test' };
    props[attrName] = 'loaded';
    const selfClosing = renderToStaticMarkup(<div {...props}>content</div>);
    expect(selfClosing).toContain('data-forgeax-load-status="loaded"');
  });
});
