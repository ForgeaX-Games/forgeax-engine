// App.tsx — top-level React component managing ViewModel + Tape state and dockview layout.
//
// Responsibilities:
//   1. ViewModel + Tape state (Tape is needed by TextureViewer for real RT/depth render).
//   2. Tape load via loadTapeFromFiles -> deserializeTape -> buildViewModel.
//   3. window.__forgeaxViewer = vm (same object reference, zero-copy per AC-14/D-4).
//   4. Dockview 4-panel workspace.
//   5. Layout persistence via localStorage + Reset Layout button.
//   6. Full-screen drag-drop (drop a tape pair anywhere) + compact header Import button,
//      so the dock owns the full main area.
//   7. Monitor/matrix-style dark theme via globals.css design tokens.

import type { DockviewApi, DockviewReadyEvent } from 'dockview-react';
import { DockviewReact } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import type { Tape } from '@forgeax/engine-rhi-debug';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DropOverlay } from './components/DropZone';
import { ErrorBanner } from './components/ErrorBanner';
import { EventBrowser } from './components/EventBrowser';
import { PipelineState } from './components/PipelineState';
import { ResourceInspector } from './components/ResourceInspector';
import { TextureViewer } from './components/TextureViewer';
import { resetToDefaultLayout, wireLayoutPersistence } from './layout-persistence';
import { SelectionProvider } from './selection-context';
import { loadStatusAnchor } from './selectors';
import type { TapeLoadError } from './tape-source';
import { loadTapeFromFiles } from './tape-source';
import { TapeContext, ViewModelContext } from './viewer-context';
import type { ViewModel } from './viewer-model';
import { buildViewModel } from './viewer-model';

const components = {
  eventBrowser: EventBrowser,
  pipelineState: PipelineState,
  textureViewer: TextureViewer,
  resourceInspector: ResourceInspector,
};

/** Default 4-panel RenderDoc-style layout: EventBrowser left, PipelineState +
 *  TextureViewer stacked top-right, ResourceInspector bottom-right. */
function applyDefaultLayout(api: DockviewApi) {
  api.addPanel({ id: 'eventBrowser', component: 'eventBrowser', title: 'Event Browser' });
  api.addPanel({
    id: 'pipelineState',
    component: 'pipelineState',
    title: 'Pipeline State',
    position: { referencePanel: 'eventBrowser', direction: 'right' },
  });
  const pipelineGroup = api.getPanel('pipelineState')?.group;
  if (pipelineGroup) {
    api.addPanel({
      id: 'textureViewer',
      component: 'textureViewer',
      title: 'Texture Viewer',
      position: { referenceGroup: pipelineGroup },
    });
    api.addPanel({
      id: 'resourceInspector',
      component: 'resourceInspector',
      title: 'Resource Inspector',
      position: { referenceGroup: pipelineGroup, direction: 'below' },
    });
  }
}

type AppState =
  | { status: 'empty' }
  | { status: 'loaded'; viewModel: ViewModel; tape: Tape }
  | { status: 'parse-error'; error: TapeLoadError };

export function App() {
  const [state, setState] = useState<AppState>({ status: 'empty' });
  const [isDragOver, setIsDragOver] = useState(false);
  const apiRef = useRef<DockviewApi | null>(null);
  const persistDisposeRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: File[]) => {
    setState({ status: 'empty' });

    const result = await loadTapeFromFiles(files);
    if (!result.ok) {
      setState({ status: 'parse-error', error: result.error });
      return;
    }

    const tape = result.value;
    const vm = buildViewModel(tape);

    (window as unknown as Record<string, unknown>).__forgeaxViewer = vm;

    setState({ status: 'loaded', viewModel: vm, tape });
  }, []);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    const dispose = wireLayoutPersistence(event.api, () => {
      applyDefaultLayout(event.api);
    });
    persistDisposeRef.current = dispose;
  }, []);

  useEffect(() => {
    return () => {
      if (persistDisposeRef.current) {
        persistDisposeRef.current();
        persistDisposeRef.current = null;
      }
    };
  }, []);

  const handleResetLayout = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    resetToDefaultLayout(api, () => {
      applyDefaultLayout(api);
    });
  }, []);

  // Full-screen drag-drop: dropping a tape pair anywhere loads it.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Only clear when leaving the window (relatedTarget null), not on child enter.
    if (e.relatedTarget === null) setIsDragOver(false);
  }, []);
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) handleFiles(files);
    },
    [handleFiles],
  );

  const handleImportClick = useCallback(() => fileInputRef.current?.click(), []);
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) handleFiles(files);
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [handleFiles],
  );

  const loaded = state.status === 'loaded';

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: full-window file drop target (drag-drop only, not click/keyboard); import-by-click is the header button
    <div
      className="dark min-h-screen h-screen flex flex-col bg-background text-foreground"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      {...{ [loadStatusAnchor()]: state.status === 'empty' ? 'empty' : undefined }}
    >
      <header className="border-b border-border px-4 py-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-brand" />
          <h1 className="text-sm font-semibold tracking-tight">RHI Debug Viewer</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleResetLayout}
            className="px-2.5 py-1 text-xs font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            Reset Layout
          </button>
          <button
            type="button"
            onClick={handleImportClick}
            className="px-2.5 py-1 text-xs font-medium rounded-md bg-brand text-brand-foreground hover:opacity-90 transition-opacity"
          >
            Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".tape.bin,.json"
            multiple
            onChange={handleInputChange}
            className="hidden"
            aria-label="Select tape files"
          />
        </div>
      </header>

      {state.status === 'parse-error' && (
        <div className="px-4 pt-3 shrink-0">
          <ErrorBanner error={state.error} />
        </div>
      )}

      <main className="flex-1 min-h-0 p-2">
        <div className="h-full w-full" {...{ [loadStatusAnchor()]: loaded ? 'loaded' : 'empty' }}>
          {loaded ? (
            <div className="dockview-theme-forgeax h-full w-full">
              <ViewModelContext.Provider value={state.viewModel}>
                <TapeContext.Provider value={state.tape}>
                  <SelectionProvider>
                    <DockviewReact onReady={onReady} components={components} />
                  </SelectionProvider>
                </TapeContext.Provider>
              </ViewModelContext.Provider>
            </div>
          ) : (
            <div className="h-full w-full flex flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-muted-foreground">
                Drop a <code className="text-xs bg-muted px-1 rounded">frame-N.tape.bin</code> +{' '}
                <code className="text-xs bg-muted px-1 rounded">frame-N.report.json</code> pair
                anywhere
              </p>
              <button
                type="button"
                onClick={handleImportClick}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand text-brand-foreground hover:opacity-90 transition-opacity"
              >
                Import a capture
              </button>
            </div>
          )}
        </div>
      </main>

      {isDragOver && <DropOverlay />}
    </div>
  );
}
