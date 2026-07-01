// CodeMirrorWidget.test.tsx — CodeMirrorWidget render smoke test (w5).
//
// Tests:
//   1. Non-empty wgslCode renders CodeMirror .cm-editor DOM element.
//   2. Empty wgslCode shows placeholder text, no .cm-editor.
//   3. WGSL tokens are syntax-highlighted: CodeMirror 6 wraps tokens in
//      spans with cm-prefix classes, and syntaxHighlighting injects a
//      <style> element containing our custom highlight colors. Regression
//      gate for the defect where syntaxHighlighting() was missing from
//      EditorState extensions.
//
// Uses jsdom + @testing-library/react.

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeMirrorWidget } from '../components/CodeMirrorWidget';

const sampleWgsl = `@group(0) @binding(0) var<uniform> params: Params;

@vertex
fn main(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4f {
  return vec4f(0.0, 0.0, 0.0, 1.0);
}`;

describe('CodeMirrorWidget', () => {
  it('renders .cm-editor when wgslCode is non-empty', () => {
    const { container } = render(<CodeMirrorWidget wgslCode={sampleWgsl} />);

    // CodeMirror EditorView creates a .cm-editor element
    const cmEditor = container.querySelector('.cm-editor');
    expect(cmEditor).not.toBeNull();
  });

  it('shows placeholder when wgslCode is empty', () => {
    const { container } = render(<CodeMirrorWidget wgslCode="" />);

    // No .cm-editor element for empty code
    const cmEditor = container.querySelector('.cm-editor');
    expect(cmEditor).toBeNull();

    // Placeholder text is visible
    expect(container.textContent).toContain('No WGSL source');
  });

  it('renders syntax-highlighted spans for WGSL tokens', () => {
    const { container } = render(<CodeMirrorWidget wgslCode={sampleWgsl} />);

    // CodeMirror 6 wraps each token in a <span> with a cm-prefix
    // class (e.g. cm-keyword, cm-variableName). Verify spans exist.
    const cmLine = container.querySelector('.cm-line');
    expect(cmLine).not.toBeNull();
    if (!cmLine) return; // length-guarded above, satisfy TS narrowing

    const cm6Spans = cmLine.querySelectorAll('span[class]');
    expect(cm6Spans.length).toBeGreaterThan(0);

    // syntaxHighlighting injects a <style> element with our custom
    // highlight colors. Confirm at least one of our color hex values
    // is present in the document.
    const allStyles = Array.from(document.querySelectorAll('style'));
    const styleTexts = allStyles.map((s) => s.textContent ?? '');
    const hasHighlightColor = styleTexts.some(
      (t) => t.includes('#c678dd') || t.includes('#e5c07b') || t.includes('#98c379'),
    );
    expect(hasHighlightColor).toBe(true);
  });
});
