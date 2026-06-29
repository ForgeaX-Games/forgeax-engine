// TreePanel.tsx — collapsible pass/draw tree rendered from ViewModel.
//
// Reads ViewModel pass tree structure and renders pass nodes with kind badge
// (render/compute), expandable to show draw child rows. Each draw row carries
// a data-forgeax-draw anchor and a data-forgeax-selected marker on the active
// draw. Clicking a draw row calls onSelectDraw with the draw index.
//
// Empty state: "No draw calls in tape" text (AC-11).
//
// Imports data-forgeax-* constants from selectors.ts (AC-13).
//
// Related: AC-11/AC-12/AC-13; plan-strategy D-5 (selectors SSOT).

import { useCallback, useState } from 'react';
import { drawAnchor, passAnchor, selectedAnchor } from '../selectors';
import type { PassNode, ViewModel } from '../viewer-model';

export interface TreePanelProps {
  readonly viewModel: ViewModel;
  readonly selectedDrawIdx: number;
  readonly onSelectDraw: (drawIdx: number) => void;
}

type ExpandedState = Record<number, boolean>;

export function TreePanel({ viewModel, selectedDrawIdx, onSelectDraw }: TreePanelProps) {
  // Default: auto-expand first pass (AC-12)
  const [expanded, setExpanded] = useState<ExpandedState>(() => {
    const init: ExpandedState = {};
    if (viewModel.tree.length > 0) {
      init[viewModel.tree[0]?.passIdx ?? 0] = true;
    }
    return init;
  });

  const toggleExpand = useCallback((passIdx: number) => {
    setExpanded((prev) => ({ ...prev, [passIdx]: !prev[passIdx] }));
  }, []);

  if (viewModel.tree.length === 0) {
    return (
      <div className="text-muted-foreground dark:text-muted-foreground text-sm italic py-4">
        No draw calls in tape
      </div>
    );
  }

  return (
    <div className="space-y-1 font-mono text-sm">
      {viewModel.tree.map((node) => (
        <PassNodeRow
          key={node.passIdx}
          node={node}
          isExpanded={expanded[node.passIdx] === true}
          onToggle={() => toggleExpand(node.passIdx)}
          selectedDrawIdx={selectedDrawIdx}
          onSelectDraw={onSelectDraw}
        />
      ))}
    </div>
  );
}

function PassNodeRow({
  node,
  isExpanded,
  onToggle,
  selectedDrawIdx,
  onSelectDraw,
}: {
  readonly node: PassNode;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
  readonly selectedDrawIdx: number;
  readonly onSelectDraw: (drawIdx: number) => void;
}) {
  const kindBadge = node.kind === 'compute' ? 'bg-info/15 text-info' : 'bg-brand/15 text-brand';

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted dark:hover:bg-muted cursor-pointer select-none w-full text-left bg-inherit border-0"
        {...{ [passAnchor()]: String(node.passIdx) }}
      >
        <span className="w-4 text-center text-muted-foreground">{isExpanded ? '▼' : '▶'}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${kindBadge}`}>
          {node.kind}
        </span>
        <span className="text-foreground">Pass {node.passIdx}</span>
        <span className="text-muted-foreground text-xs">
          ({node.draws.length} {node.draws.length === 1 ? 'call' : 'calls'})
        </span>
      </button>

      {isExpanded && (
        <div className="ml-6 border-l border-border dark:border-border pl-4">
          {node.draws.map((drawItem) => {
            const isSelected = drawItem.drawIdx === selectedDrawIdx;
            return (
              <button
                type="button"
                key={drawItem.drawIdx}
                onClick={() => onSelectDraw(drawItem.drawIdx)}
                className={`
                  py-1 px-2 rounded cursor-pointer select-none text-xs w-full text-left bg-inherit border-0
                  ${isSelected ? 'bg-brand/15 text-brand' : 'hover:bg-muted text-muted-foreground'}
                `}
                {...{ [drawAnchor()]: String(drawItem.drawIdx) }}
                {...(isSelected ? { [selectedAnchor()]: 'true' } : {})}
              >
                <span className="text-muted-foreground w-16 inline-block">#{drawItem.drawIdx}</span>
                <span>
                  {drawItem.eventKind === 'dispatchWorkgroups' ? 'dispatch' : drawItem.eventKind}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
