// App.tsx — top-level React component managing ViewModel state and dockview layout.
//
// Responsibilities:
//   1. ViewModel state via useState<ViewModel | TapeLoadError | null>(null).
//   2. Tape load via DropZone -> tape-source -> deserializeTape -> buildViewModel.
//   3. window.__forgeaxViewer = vm (same object reference, zero-copy per AC-14/D-4).
//   4. Dockview 4-panel workspace replacing the old fixed grid (w20).
//   5. Layout persistence via localStorage + Reset Layout button (w21).
//   6. Error state renders ErrorBanner; empty/loaded state renders dockview + drop zone.

import type { DockviewApi, DockviewReadyEvent } from 'dockview-react';
import { DockviewReact } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DropZone } from './components/DropZone';
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
import { ViewModelContext } from './viewer-context';
import type { ViewModel } from './viewer-model';
import { buildViewModel } from './viewer-model';

const components = {
  eventBrowser: EventBrowser,
  pipelineState: PipelineState,
  textureViewer: TextureViewer,
  resourceInspector: ResourceInspector,
};

/** Default 4-panel RenderDoc-style layout (requirements 3.6):
 *  EventBrowser left, PipelineState+TextureViewer stacked top-right,
 *  ResourceInspector bottom-right. */
function applyDefaultLayout(api: DockviewApi) {
  api.addPanel({
    id: 'eventBrowser',
    component: 'eventBrowser',
    title: 'Event Browser',
  });
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
  | { status: 'loaded'; viewModel: ViewModel }
  | { status: 'parse-error'; error: TapeLoadError };

export function App() {
  const [state, setState] = useState<AppState>({ status: 'empty' });
  const apiRef = useRef<DockviewApi | null>(null);
  const persistDisposeRef = useRef<(() => void) | null>(null);

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

    setState({ status: 'loaded', viewModel: vm });
  }, []);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;

    // Wire layout persistence (load saved or apply default + auto-save)
    const dispose = wireLayoutPersistence(event.api, () => {
      applyDefaultLayout(event.api);
    });
    persistDisposeRef.current = dispose;
  }, []);

  // Cleanup persistence subscription on unmount or re-ready
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

  return (
    <div
      className="min-h-screen bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
      {...{ [loadStatusAnchor()]: state.status === 'empty' ? 'empty' : undefined }}
    >
      <header className="border-b border-slate-200 dark:border-slate-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">RHI Debug Viewer</h1>
        <button
          type="button"
          onClick={handleResetLayout}
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        >
          Reset Layout
        </button>
      </header>

      <main className="h-[calc(100vh-3.5rem)] flex flex-col p-4 gap-4">
        {state.status === 'parse-error' && <ErrorBanner error={state.error} />}

        <DropZone onFiles={handleFiles} disabled={false} />

        <div
          className="flex-1 min-h-0"
          {...{ [loadStatusAnchor()]: state.status === 'loaded' ? 'loaded' : 'empty' }}
        >
          <div className="dockview-theme-abyss" style={{ width: '100%', height: '100%' }}>
            <ViewModelContext.Provider value={state.status === 'loaded' ? state.viewModel : null}>
              <SelectionProvider>
                <DockviewReact onReady={onReady} components={components} />
              </SelectionProvider>
            </ViewModelContext.Provider>
          </div>
        </div>
      </main>
    </div>
  );
}
