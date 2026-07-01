// CodeMirrorShader.tsx -- F2 WGSL editor: opt-in edit mode + apply/reset + inline
// compile diagnostics (M3/w15 + w16).
//
// Default state is read-only syntax-highlighted display, identical to the F1
// widget. Clicking "Edit" enters edit mode: the editor becomes writable, a
// line-number gutter + lint gutter appear, the border switches to the brand
// accent, and a banner makes the boundary unmistakable -- "Edit mode -- preview
// only, does not write to tape". Edit is hidden by default so an AI user does not
// misread the viewer as a programmable shader-authoring surface (charter F1).
//
// Apply (w16): recompiles the edited WGSL through the independent compile/render
// path (compile-and-render.ts, D-1) and paints the recompiled draw onto a local
// preview canvas. Failures surface as inline CodeMirror diagnostics keyed by the
// error phase (D-3 line-number priority):
//   - parse        -> line + col located, gutter marker + tooltip, source 'naga'
//   - validate     -> message only, no line number (naga has none), source 'naga'
//   - gpu-compile  -> compilerMessages[].lineNum located, source 'gpu'
//   - pipeline     -> message only (layout-incompatible), preview kept, source 'gpu'
// Reset restores the original source + original commitThroughDraw render; clicking
// Reset before any Apply is a no-op (requirements edge case). edit never writes
// the tape / replay inspect (OOS-1). No undo/redo stack (OOS-4).
//
// Related: requirements AC-02/AC-03; plan-strategy D-1/D-3 + sequence 3.2.

import type { Diagnostic } from '@codemirror/lint';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { renderRtToCanvas } from '@forgeax/engine-rhi-debug/rt-to-canvas';
import { Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type CompileError, compileAndRenderShader, type EditStage } from '../compile-and-render';
import { ensureReplaySession } from '../replay-session';
import { useSelection } from '../selection-context';
import { useTape } from '../viewer-context';
import { wgslHighlighting, wgslLanguage } from './wgsl-language';

// ============================================================================
// CompileError -> CodeMirror diagnostics (D-3 priority)
// ============================================================================

type ApplyStatus = 'idle' | 'compiling' | 'ok' | 'error';

/**
 * Translate a CompileError into CodeMirror lint diagnostics. Line-number-bearing
 * phases (parse, gpu-compile) locate to a doc line; line-less phases (validate,
 * pipeline) attach a whole-document message. lineNum is 1-based.
 */
function compileErrorToDiagnostics(view: EditorView, error: CompileError): Diagnostic[] {
  const doc = view.state.doc;

  const lineRange = (lineNum: number | undefined): { from: number; to: number } => {
    if (lineNum === undefined || lineNum < 1 || lineNum > doc.lines) {
      return { from: 0, to: Math.min(doc.length, doc.line(1).to) };
    }
    const line = doc.line(lineNum);
    return { from: line.from, to: line.to };
  };

  switch (error.phase) {
    case 'parse': {
      const { from, to } = lineRange(error.error.lineNum);
      return [{ from, to, severity: 'error', source: 'naga', message: error.error.message }];
    }
    case 'validate': {
      // D-3: naga validate has no source position -> message only on line 1.
      const { from, to } = lineRange(undefined);
      return [
        {
          from,
          to,
          severity: 'error',
          source: 'naga',
          message: `validation: ${error.error.message}`,
        },
      ];
    }
    case 'gpu-compile': {
      const detail = error.error.detail;
      const messages =
        detail !== undefined && 'compilerMessages' in detail ? detail.compilerMessages : [];
      if (messages.length === 0) {
        const { from, to } = lineRange(undefined);
        return [{ from, to, severity: 'error', source: 'gpu', message: error.error.hint }];
      }
      return messages.map((m) => {
        // GPUCompilationMessage.lineNum is 1-based; 0 means "no specific line".
        const { from, to } = lineRange(m.lineNum > 0 ? m.lineNum : undefined);
        return {
          from,
          to,
          severity: m.type === 'error' ? 'error' : 'warning',
          source: 'gpu',
          message: m.message,
        } satisfies Diagnostic;
      });
    }
    case 'pipeline': {
      const { from, to } = lineRange(undefined);
      return [
        {
          from,
          to,
          severity: 'error',
          source: 'gpu',
          message: `pipeline incompatible (old preview kept): ${error.error.hint}`,
        },
      ];
    }
    default: {
      const { from, to } = lineRange(undefined);
      return [{ from, to, severity: 'error', source: 'viewer', message: error.message }];
    }
  }
}

function errorSummary(error: CompileError): string {
  switch (error.phase) {
    case 'parse':
    case 'validate':
      return error.error.message;
    case 'gpu-compile':
    case 'pipeline':
      return error.error.hint;
    default:
      return error.message;
  }
}

// ============================================================================
// React props
// ============================================================================

export interface CodeMirrorShaderProps {
  /** WGSL source code to display (the recorded shader for this stage). */
  wgslCode: string;
  /** Which pipeline stage this editor targets (decides the module swap on apply). */
  stage: EditStage;
}

// ============================================================================
// Component
// ============================================================================

export function CodeMirrorShader({ wgslCode, stage }: CodeMirrorShaderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [applyStatus, setApplyStatus] = useState<ApplyStatus>('idle');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const tape = useTape();
  const { selectedDrawIdx } = useSelection();

  // Rebuild the CodeMirror instance whenever the source or the edit mode flips.
  // Read-only: highlight only. Edit: writable + line-number gutter + lint gutter,
  // same WGSL highlighting retained.
  useEffect(() => {
    if (!containerRef.current) return;

    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }
    containerRef.current.innerHTML = '';

    const extensions = editMode
      ? [wgslLanguage, wgslHighlighting, lineNumbers(), lintGutter(), EditorView.editable.of(true)]
      : [
          wgslLanguage,
          wgslHighlighting,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ];

    const state = EditorState.create({ doc: wgslCode, extensions });
    viewRef.current = new EditorView({ state, parent: containerRef.current });

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [wgslCode, editMode]);

  const clearDiagnostics = (view: EditorView) => {
    view.dispatch(setDiagnostics(view.state, []));
  };

  async function handleApply() {
    const view = viewRef.current;
    if (!view || !tape || selectedDrawIdx < 0) return;
    if (typeof navigator === 'undefined' || navigator.gpu === undefined) {
      setApplyStatus('error');
      setStatusMessage('WebGPU not available');
      return;
    }
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    setApplyStatus('compiling');
    setStatusMessage(null);
    clearDiagnostics(view);

    const sessionResult = await ensureReplaySession(tape);
    if (!sessionResult.ok) {
      setApplyStatus('error');
      setStatusMessage(sessionResult.error.message);
      return;
    }
    const { replay, device } = sessionResult.value;

    // Set up the live handle map for the selected draw on the ORIGINAL shader
    // (D-1 precondition). compileAndRenderShader swaps only the pipeline.
    replay.reset();
    const commit = await replay.commitThroughDraw(selectedDrawIdx);
    if (!commit.ok) {
      setApplyStatus('error');
      setStatusMessage(`replay failed: ${commit.error.code}`);
      return;
    }

    const newWgsl = view.state.doc.toString();
    const result = await compileAndRenderShader(newWgsl, {
      replay,
      device,
      events: tape.events,
      drawIdx: selectedDrawIdx,
      stage,
      canvas,
    });

    if (result.ok) {
      setApplyStatus('ok');
      setStatusMessage(null);
      clearDiagnostics(view);
      return;
    }

    setApplyStatus('error');
    setStatusMessage(errorSummary(result.error));
    view.dispatch(setDiagnostics(view.state, compileErrorToDiagnostics(view, result.error)));
  }

  async function handleReset() {
    const view = viewRef.current;
    if (!view) return;

    // Restore the original source + clear diagnostics.
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: wgslCode },
    });
    clearDiagnostics(view);
    setStatusMessage(null);

    // If nothing was applied yet, there is no preview to restore (no-op).
    if (applyStatus !== 'ok' && applyStatus !== 'error') {
      setApplyStatus('idle');
      return;
    }

    setApplyStatus('idle');

    // Restore the original render via the original commitThroughDraw path.
    const canvas = previewCanvasRef.current;
    if (!tape || selectedDrawIdx < 0 || !canvas) return;
    if (typeof navigator === 'undefined' || navigator.gpu === undefined) return;
    const sessionResult = await ensureReplaySession(tape);
    if (!sessionResult.ok) return;
    const { replay, device } = sessionResult.value;
    replay.reset();
    const commit = await replay.commitThroughDraw(selectedDrawIdx);
    if (!commit.ok) return;
    await renderRtToCanvas(replay, selectedDrawIdx, device, canvas);
  }

  if (!wgslCode) {
    return (
      <div className="mt-1 p-2 bg-muted rounded text-xs text-muted-foreground font-mono italic">
        No WGSL source
      </div>
    );
  }

  return (
    <div className="mt-1" data-forgeax-shader-editor data-forgeax-edit-mode={editMode}>
      <div className="flex items-center justify-between mb-1">
        {editMode ? (
          <span
            className="text-[10px] uppercase tracking-wide text-brand font-mono"
            data-forgeax-edit-banner
          >
            Edit mode — preview only, does not write to tape
          </span>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => setEditMode((v) => !v)}
          className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-muted text-muted-foreground"
          data-forgeax-edit-toggle={editMode ? 'on' : 'off'}
          title={editMode ? 'Exit edit mode' : 'Edit WGSL (preview only)'}
        >
          {editMode ? <X size={11} /> : <Pencil size={11} />}
          {editMode ? 'Done' : 'Edit'}
        </button>
      </div>

      <div
        ref={containerRef}
        className={`rounded overflow-auto max-h-96 text-xs border ${
          editMode ? 'border-brand' : 'border-border'
        }`}
      />

      {editMode && (
        <div className="mt-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleApply}
              disabled={applyStatus === 'compiling' || selectedDrawIdx < 0}
              className="text-[10px] px-2 py-0.5 rounded bg-brand text-brand-foreground disabled:opacity-50"
              data-forgeax-shader-apply
            >
              {applyStatus === 'compiling' ? 'Compiling…' : 'Apply'}
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-muted text-muted-foreground"
              data-forgeax-shader-reset
            >
              Reset
            </button>
            <span
              className="text-[10px] text-muted-foreground"
              data-forgeax-shader-apply-status={applyStatus}
            >
              {selectedDrawIdx < 0 ? 'select a draw to preview' : applyStatus}
            </span>
          </div>
          {statusMessage && (
            <div
              className="mt-1 text-[10px] text-destructive font-mono break-words"
              data-forgeax-shader-error
            >
              {statusMessage}
            </div>
          )}
          <canvas
            ref={previewCanvasRef}
            className="mt-1 w-full max-h-64 object-contain border border-border rounded bg-black"
            data-forgeax-shader-preview-canvas
          />
        </div>
      )}
    </div>
  );
}
