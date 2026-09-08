import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { RotateCcw, WandSparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { previewCanvasAnchor } from '../selectors';
import type { PreviewError } from '../shader-preview/errors';
import {
  makeShaderPreviewKey,
  type ShaderPreviewArtifact,
  type ShaderPreviewSelection,
  ShaderPreviewSession,
  validateShaderPreviewSelection,
} from '../shader-preview/session';
import { wgslHighlighting, wgslLanguage } from './wgsl-language';

export interface CodeMirrorShaderProps {
  readonly selection: ShaderPreviewSelection;
}

function sourceDiagnostic(view: EditorView, error: PreviewError): Diagnostic {
  const requestedLine = error.line ?? 1;
  const lineNumber = Math.min(Math.max(1, requestedLine), view.state.doc.lines);
  const line = view.state.doc.line(lineNumber);
  const requestedColumn = Math.max(1, error.column ?? 1);
  const from = Math.min(line.to, line.from + requestedColumn - 1);
  const to = Math.min(line.to, Math.max(from, from + 1));
  return {
    from,
    to,
    severity: 'error',
    source: 'WGSL',
    message: `${error.code}: ${error.detail}`,
  };
}

export function CodeMirrorShader({ selection }: CodeMirrorShaderProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const previewCanvas = useRef<HTMLCanvasElement>(null);
  const session = useRef(new ShaderPreviewSession());
  const mounted = useRef(false);
  const requestId = useRef(0);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);
  const [preview, setPreview] = useState<ShaderPreviewArtifact | null>(null);
  const selectionKey = makeShaderPreviewKey(selection);

  useEffect(() => {
    editor.current?.destroy();
    host.current?.replaceChildren();
    if (!host.current || selection.source === '') return;
    editor.current = new EditorView({
      state: EditorState.create({
        doc: selection.source,
        extensions: [
          wgslLanguage,
          wgslHighlighting,
          lineNumbers(),
          lintGutter(),
          EditorView.editable.of(editing),
          EditorState.readOnly.of(!editing),
        ],
      }),
      parent: host.current,
    });
    return () => editor.current?.destroy();
  }, [selection.source, editing]);

  // Abort the in-flight request on unmount. React StrictMode probes effect
  // cleanup during development, so an irreversible session dispose here
  // would poison the committed instance before the first real Apply.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current += 1;
      session.current.abort();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup is keyed by the canonical selection identity.
  useEffect(() => {
    return () => {
      requestId.current += 1;
      session.current.abort();
      setPreview(null);
      setMessage(null);
      setError(null);
      const canvas = previewCanvas.current;
      if (canvas !== null) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [selectionKey]);

  async function apply() {
    const view = editor.current;
    if (!view) return;
    const currentRequestId = ++requestId.current;
    setMessage('Compiling WGSL and rendering a temporary preview...');
    setError(null);
    view.dispatch(setDiagnostics(view.state, []));
    const canvas = previewCanvas.current;
    const result = await session.current.apply(
      selection,
      view.state.doc.toString(),
      canvas === null ? {} : { canvas },
    );
    if (!mounted.current || requestId.current !== currentRequestId || editor.current !== view)
      return;
    if (!result.ok) {
      setPreview(null);
      setError(result.error);
      setMessage(result.error.detail ?? result.error.code);
      view.dispatch(setDiagnostics(view.state, [sourceDiagnostic(view, result.error)]));
      return;
    }
    setPreview(result.value);
    setError(null);
    setMessage(
      `Preview ready (${result.value.provenance}); pixels ${result.value.pixelDigest}; canonical tape unchanged.`,
    );
  }

  function reset() {
    const view = editor.current;
    requestId.current += 1;
    session.current.abort();
    setPreview(null);
    setMessage(null);
    setError(null);
    if (view) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: selection.source } });
      view.dispatch(setDiagnostics(view.state, []));
    }
    const canvas = previewCanvas.current;
    if (canvas !== null) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  const applicability = validateShaderPreviewSelection(selection);
  if (!applicability.ok)
    return (
      <div
        className="text-xs text-muted-foreground space-y-1"
        data-forgeax-preview-error={applicability.error.code}
      >
        <p>
          <span data-forgeax-preview-code>{applicability.error.code}</span>:{' '}
          {applicability.error.detail}
        </p>
        <p data-forgeax-preview-expected>{applicability.error.expected}</p>
        <p data-forgeax-preview-hint>{applicability.error.hint}</p>
      </div>
    );
  return (
    <div
      className="mt-2 space-y-2"
      data-forgeax-shader-editor
      data-forgeax-editor-key={selectionKey}
    >
      <div className="flex items-center gap-2 text-[10px]">
        <span className="font-mono text-muted-foreground">
          {selection.stage} / {selection.entryPoint}
        </span>
        <button
          type="button"
          onClick={() => setEditing((value) => !value)}
          className="forgeax-button-quiet h-6 px-2 text-[10px]"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
        {editing && (
          <button
            type="button"
            onClick={() => void apply()}
            className="forgeax-button-primary h-6 px-2 text-[10px]"
          >
            <WandSparkles size={11} /> Apply
          </button>
        )}
        {editing && (
          <button
            type="button"
            onClick={reset}
            className="forgeax-button-quiet h-6 px-2 text-[10px]"
          >
            <RotateCcw size={11} /> Reset
          </button>
        )}
      </div>
      {editing && (
        <p className="text-[10px] text-brand">
          Preview only. No tape, model, replay, or canonical pixels are written.
        </p>
      )}
      <div ref={host} className="max-h-64 overflow-auto rounded-lg border border-border text-xs" />
      <canvas
        ref={previewCanvas}
        className={preview === null ? 'hidden' : 'mt-2 h-48 w-48 rounded border border-brand/50'}
        {...(preview === null ? {} : { [previewCanvasAnchor()]: '' })}
        aria-label="Viewer-private shader preview"
      />
      {preview !== null && (
        <p className="text-[10px] text-brand">
          preview provenance · {preview.width}x{preview.height} · {preview.pixelDigest}
        </p>
      )}
      {message && (
        <div
          className="text-[10px] text-muted-foreground space-y-0.5"
          role="status"
          data-forgeax-preview-error={error?.code}
        >
          <p>{message}</p>
          {error !== null && (
            <>
              <p data-forgeax-preview-code>{error.code}</p>
              <p data-forgeax-preview-detail>{error.detail}</p>
              <p data-forgeax-preview-expected>{error.expected}</p>
              <p data-forgeax-preview-hint>{error.hint}</p>
              {error.line !== undefined && (
                <p data-forgeax-preview-line={String(error.line)}>line {error.line}</p>
              )}
              {error.column !== undefined && (
                <p data-forgeax-preview-column={String(error.column)}>column {error.column}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
