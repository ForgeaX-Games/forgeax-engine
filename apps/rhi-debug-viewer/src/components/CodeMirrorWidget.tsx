// CodeMirrorWidget.tsx — read-only CodeMirror wrapper with WGSL syntax highlighting.
//
// M1 (F1): read-only CodeMirror instance for displaying WGSL shader source.
// Accepts `wgslCode: string` prop, renders syntax-highlighted code via the shared
// WGSL StreamLanguage tokenizer (wgsl-language.ts). Empty string shows a
// placeholder instead of an empty editor.
//
// F2 edit mode + lint diagnostics live in CodeMirrorShader.tsx; this widget stays
// read-only display.

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { wgslHighlighting, wgslLanguage } from './wgsl-language';

// ============================================================================
// React props
// ============================================================================

export interface CodeMirrorWidgetProps {
  /** WGSL source code to display. Empty string shows placeholder. */
  wgslCode: string;
}

// ============================================================================
// Component
// ============================================================================

export function CodeMirrorWidget({ wgslCode }: CodeMirrorWidgetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Destroy previous instance
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    containerRef.current.innerHTML = '';

    const state = EditorState.create({
      doc: wgslCode,
      extensions: [
        wgslLanguage,
        wgslHighlighting,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ],
    });

    viewRef.current = new EditorView({
      state,
      parent: containerRef.current,
    });

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [wgslCode]);

  if (!wgslCode) {
    return (
      <div className="mt-1 p-2 bg-muted rounded text-xs text-muted-foreground font-mono italic">
        No WGSL source
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mt-1 rounded overflow-auto max-h-96 border border-border text-xs"
    />
  );
}
