// viewer-context.tsx — React Context providing ViewModel to dockview panels (M7).
//
// ViewModel is stored in App.tsx useState and exposed through this context.
// All four panels consume useViewModel() to read ViewModel data.
// SelectionContext is separate (selection-context.tsx) for cross-panel selection.
//
// Related: plan-strategy D-5 (ViewModel SSOT); dockview 4-panel integration.

import { createContext, useContext } from 'react';
import type { ViewModel } from './viewer-model';

export const ViewModelContext = createContext<ViewModel | null>(null);

export function useViewModel(): ViewModel | null {
  return useContext(ViewModelContext);
}
