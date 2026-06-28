// selection-context.tsx — React Context for shared selection state (w22).
//
// Lightweight React Context (not zustand, per charter P4 dependency count control).
// Drives all four panel components: selectedDrawIdx or selectedCommandIdx
// determines what panels 2/3/4 display.
//
// When selectedDrawIdx is set (>= 0):
//   - PipelineState shows the draw's pipeline state (7 stages).
//   - TextureViewer shows the draw's attachments (color RTs + depth + bound).
//   - ResourceInspector highlights resources referenced by the draw.
//
// When selectedCommandIdx is set (non-draw command selected, AC-26):
//   - PipelineState shows default text (no pipeline state for non-draw command).
//   - TextureViewer shows default text (no texture state for non-draw command).
//   - ResourceInspector still shows src/dst resource handles.
//
// Related: requirements AC-25/AC-26; plan-strategy D-5.

import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useState } from 'react';

export interface SelectionState {
  /** Selected draw index (-1 = none). */
  readonly selectedDrawIdx: number;
  /** Selected command index (-1 = none). */
  readonly selectedCommandIdx: number;
  /** Set the selected draw index (clears selectedCommandIdx). */
  setSelectedDrawIdx: (idx: number) => void;
  /** Set the selected command index (clears selectedDrawIdx, for non-draw commands). */
  setSelectedCommandIdx: (idx: number) => void;
}

export const SelectionContext = createContext<SelectionState>({
  selectedDrawIdx: -1,
  selectedCommandIdx: -1,
  setSelectedDrawIdx: () => {},
  setSelectedCommandIdx: () => {},
});

export function useSelection(): SelectionState {
  return useContext(SelectionContext);
}

export function SelectionProvider({ children }: { readonly children: ReactNode }) {
  const [selectedDrawIdx, setSelectedDrawIdxRaw] = useState(-1);
  const [selectedCommandIdx, setSelectedCommandIdxRaw] = useState(-1);

  const value: SelectionState = useMemo(
    () => ({
      selectedDrawIdx,
      selectedCommandIdx,
      setSelectedDrawIdx: (idx: number) => {
        setSelectedDrawIdxRaw(idx);
        setSelectedCommandIdxRaw(-1);
      },
      setSelectedCommandIdx: (idx: number) => {
        setSelectedCommandIdxRaw(idx);
        setSelectedDrawIdxRaw(-1);
      },
    }),
    [selectedDrawIdx, selectedCommandIdx],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}
