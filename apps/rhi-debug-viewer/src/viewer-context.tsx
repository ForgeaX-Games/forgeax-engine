// viewer-context.tsx — React Contexts providing the ViewModel + Tape to dockview panels.
//
// ViewModel is the pure structural model (zero GPU). Tape is the deserialized capture
// the TextureViewer needs to bootstrap a WebGPU replay session and render real RT/depth
// pixels. Both are stored in App.tsx useState and exposed here. SelectionContext is
// separate (selection-context.tsx) for cross-panel selection.
//
// Related: plan-strategy D-5 (ViewModel SSOT); dockview 4-panel integration.

import type { Tape } from '@forgeax/engine-rhi-debug';
import { createContext, useContext } from 'react';
import type { ViewModel } from './viewer-model';

export const ViewModelContext = createContext<ViewModel | null>(null);

export function useViewModel(): ViewModel | null {
  return useContext(ViewModelContext);
}

/** The deserialized capture, exposed so the TextureViewer can replay + read back RT pixels. */
export const TapeContext = createContext<Tape | null>(null);

export function useTape(): Tape | null {
  return useContext(TapeContext);
}
