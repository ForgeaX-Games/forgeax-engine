// App.tsx — top-level React component managing ViewModel state and layout.
//
// Responsibilities:
//   1. ViewModel state via useState<ViewModel | TapeLoadError | null>(null).
//   2. Tape load via DropZone -> tape-source -> deserializeTape -> buildViewModel.
//   3. window.__forgeaxViewer = vm (same object reference, zero-copy per AC-14/D-4).
//   4. Default selection: auto-expand first pass + auto-select first draw (AC-12).
//   5. Selected draw index passed down to child panels.
//   6. Error state renders ErrorBanner; empty/loaded state renders tree + panels.
//
// Components are read-only ViewModel consumers (C9 Pipeline Isolation).
//
// Related: AC-01/AC-12/AC-14; plan-strategy D-4/D-6/D-10.

import type { Tape } from '@forgeax/engine-rhi-debug';
import { useCallback, useMemo, useState } from 'react';
import { BindingsPanel } from './components/BindingsPanel';
import { DropZone } from './components/DropZone';
import { ErrorBanner } from './components/ErrorBanner';
import { RtPanel } from './components/RtPanel';
import { TreePanel } from './components/TreePanel';
import { loadStatusAnchor } from './selectors';
import type { TapeLoadError } from './tape-source';
import { loadTapeFromFiles } from './tape-source';
import type { ViewModel } from './viewer-model';
import { buildViewModel } from './viewer-model';

type AppState =
  | { status: 'empty' }
  | { status: 'loaded'; viewModel: ViewModel }
  | { status: 'parse-error'; error: TapeLoadError };

export function App() {
  const [state, setState] = useState<AppState>({ status: 'empty' });
  const [selectedDrawIdx, setSelectedDrawIdx] = useState<number>(0);
  // tape is kept so RtPanel can call ensureReplaySession(tape)
  const [tape, setTape] = useState<Tape | null>(null);

  // Derive selected draw info from ViewModel
  const selectedDraw = useMemo(() => {
    if (state.status !== 'loaded') return null;
    const vm = state.viewModel;
    if (selectedDrawIdx < 0 || selectedDrawIdx >= vm.draws.length) return null;
    return vm.draws[selectedDrawIdx] ?? null;
  }, [state, selectedDrawIdx]);

  const handleFiles = useCallback(async (files: File[]) => {
    setState({ status: 'empty' });

    const result = await loadTapeFromFiles(files);
    if (!result.ok) {
      setState({ status: 'parse-error', error: result.error });
      return;
    }

    const tape = result.value;
    setTape(tape);
    const vm = buildViewModel(tape);

    // D-4 zero-copy: expose the same object reference (AC-14)
    (window as unknown as Record<string, unknown>).__forgeaxViewer = vm;

    setState({ status: 'loaded', viewModel: vm });

    // AC-12: default auto-select first draw
    if (vm.draws.length > 0) {
      setSelectedDrawIdx(0);
    }
  }, []);

  return (
    <div
      className="min-h-screen bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
      {...{ [loadStatusAnchor()]: state.status === 'empty' ? 'empty' : undefined }}
    >
      <header className="border-b border-slate-200 dark:border-slate-800 px-6 py-4">
        <h1 className="text-lg font-semibold">RHI Debug Viewer</h1>
      </header>

      <main className="p-6 space-y-6">
        {/* Error banner for parse errors */}
        {state.status === 'parse-error' && <ErrorBanner error={state.error} />}

        {/* Drop zone always visible; disabled when tape already loaded */}
        <DropZone onFiles={handleFiles} disabled={false} />

        {/* Loaded state: tree + panels */}
        {state.status === 'loaded' && (
          <div
            className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-6"
            {...{ [loadStatusAnchor()]: 'loaded' }}
          >
            <div className="space-y-4">
              <TreePanel
                viewModel={state.viewModel}
                selectedDrawIdx={selectedDrawIdx}
                onSelectDraw={setSelectedDrawIdx}
              />
            </div>
            <div className="space-y-4">
              {selectedDraw && <BindingsPanel draw={selectedDraw} />}
              <RtPanel selectedDrawIdx={selectedDrawIdx} tape={tape} viewModel={state.viewModel} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
