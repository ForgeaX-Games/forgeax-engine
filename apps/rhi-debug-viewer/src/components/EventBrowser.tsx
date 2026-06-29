// EventBrowser.tsx — left panel: pass->draw tree + full command stream (w23).
//
// Filters: 'draws only' (default) or 'all commands'. Shows passes as top-level
// collapsible nodes. Within each pass, commands listed in tape order:
//   - Draw commands highlighted with draw type badge.
//   - Non-draw commands dimmed with small icon.
//   - pushDebugGroup / popDebugGroup form collapsible nested sections.
//   - insertDebugMarker shown as inline dimmed markers.
//
// Selection: clicking a draw row sets selectedDrawIdx in Context;
// clicking a non-draw command row sets selectedCommandIdx.
//
// Related: requirements AC-14; plan-strategy D-5; charter P1 (progressive disclosure).

import type { IDockviewPanelProps } from 'dockview-react';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Layers,
  List,
  Minus,
  Play,
  Tag,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSelection } from '../selection-context';
import { commandRowAnchor, drawAnchor, eventBrowserAnchor } from '../selectors';
import { useViewModel } from '../viewer-context';
import type { CommandEntry } from '../viewer-model';

type FilterMode = 'draws-only' | 'all-commands';

/** A segment of consecutive commands within a debug group boundary. */
interface CommandSegment {
  type: 'command';
  command: CommandEntry;
}
interface GroupSegment {
  type: 'group';
  openLabel: string;
  children: CommandTreeItem[];
}
type CommandTreeItem = CommandSegment | GroupSegment;

/** Build a tree with debug group nesting for a flat command array. */
function buildCommandTree(commands: readonly CommandEntry[]): CommandTreeItem[] {
  const result: CommandTreeItem[] = [];
  const stack: CommandTreeItem[][] = [result];

  for (const cmd of commands) {
    const current = stack[stack.length - 1];
    if (!current) continue;

    if (cmd.kind === 'pushDebugGroup' || cmd.kind === 'passPushDebugGroup') {
      const group: GroupSegment = {
        type: 'group',
        openLabel: cmd.groupLabel ?? 'Debug Group',
        children: [],
      };
      current.push(group);
      stack.push(group.children);
    } else if (cmd.kind === 'popDebugGroup' || cmd.kind === 'passPopDebugGroup') {
      if (stack.length > 1) stack.pop();
    } else {
      current.push({ type: 'command', command: cmd });
    }
  }

  return result;
}

function drawKindLabel(kind: string): string {
  switch (kind) {
    case 'drawIndexed':
      return 'DrawIndexed';
    case 'drawIndirect':
      return 'DrawIndirect';
    case 'drawIndexedIndirect':
      return 'DrawIdxIndirect';
    case 'dispatchWorkgroups':
      return 'Dispatch';
    default:
      return 'Draw';
  }
}

function nonDrawIcon(kind: string): string {
  switch (kind) {
    case 'setPipeline':
    case 'setVertexBuffer':
    case 'setIndexBuffer':
    case 'setBindGroup':
      return 'bind';
    case 'copyBufferToBuffer':
    case 'copyBufferToTexture':
    case 'copyTextureToBuffer':
    case 'copyTextureToTexture':
    case 'clearBuffer':
      return 'copy';
    case 'setViewport':
    case 'setScissorRect':
      return 'viewport';
    case 'setBlendConstant':
    case 'setStencilReference':
      return 'state';
    case 'insertDebugMarker':
    case 'passInsertDebugMarker':
      return 'marker';
    default:
      return 'cmd';
  }
}

function CommandRow({
  command,
  onSelect,
}: {
  command: CommandEntry;
  onSelect: (cmd: CommandEntry) => void;
}) {
  const isDraw = command.isDraw;

  return (
    <button
      type="button"
      onClick={() => onSelect(command)}
      className={`w-full text-left px-2 py-0.5 text-xs flex items-center gap-1.5 rounded transition-colors hover:bg-slate-700/50 ${
        isDraw ? 'text-green-300 font-medium' : 'text-slate-500'
      }`}
      {...{ [commandRowAnchor()]: String(command.eventIdx) }}
    >
      {isDraw ? (
        <Play size={10} className="shrink-0 text-green-400" />
      ) : nonDrawIcon(command.kind) === 'marker' ? (
        <Tag size={10} className="shrink-0 text-amber-500/60" />
      ) : nonDrawIcon(command.kind) === 'copy' ? (
        <Minus size={10} className="shrink-0 text-slate-600" />
      ) : (
        <Minus size={10} className="shrink-0 text-slate-600" />
      )}
      <span className="truncate">{isDraw ? drawKindLabel(command.kind) : command.kind}</span>
      {command.markerLabel && (
        <span className="text-amber-500/60 truncate">&quot;{command.markerLabel}&quot;</span>
      )}
    </button>
  );
}

function TreeNode({
  item,
  depth,
  onSelect,
}: {
  item: CommandTreeItem;
  depth: number;
  onSelect: (cmd: CommandEntry) => void;
}) {
  if (item.type === 'command') {
    return (
      <div style={{ paddingLeft: depth * 12 }}>
        <CommandRow command={item.command} onSelect={onSelect} />
      </div>
    );
  }

  // GroupSegment — collapsible debug group
  return <GroupNode group={item} depth={depth} onSelect={onSelect} />;
}

function GroupNode({
  group,
  depth,
  onSelect,
}: {
  group: GroupSegment;
  depth: number;
  onSelect: (cmd: CommandEntry) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div style={{ paddingLeft: depth * 12 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-amber-400/70 hover:text-amber-300 py-0.5 w-full text-left"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span className="truncate">{group.openLabel}</span>
      </button>
      {open && (
        <div>
          {group.children.map((child, idx) => {
            const childKey =
              child.type === 'command' ? `cmd-${child.command.eventIdx}` : `group-${idx}`;
            return <TreeNode key={childKey} item={child} depth={1} onSelect={onSelect} />;
          })}
        </div>
      )}
    </div>
  );
}

export function EventBrowser(_props: IDockviewPanelProps) {
  const vm = useViewModel();
  const { setSelectedDrawIdx, setSelectedCommandIdx } = useSelection();
  const [filterMode, setFilterMode] = useState<FilterMode>('draws-only');
  const [collapsedPasses, setCollapsedPasses] = useState<Set<number>>(new Set());

  const tree = vm?.tree ?? [];
  const commands = vm?.commands ?? [];

  // Build per-pass command ranges and trees
  const passCommandTree = useMemo(() => {
    const map = new Map<number, CommandTreeItem[]>();
    if (commands.length === 0) return map;

    for (let pi = 0; pi < tree.length; pi++) {
      const passNode = tree[pi];
      if (!passNode) continue;
      // Gather commands belonging to this pass
      const passCmds = commands.filter((c) => c.passIdx === passNode.passIdx);
      map.set(passNode.passIdx, buildCommandTree(passCmds));
    }
    return map;
  }, [commands, tree]);

  const togglePass = (passIdx: number) => {
    setCollapsedPasses((prev) => {
      const next = new Set(prev);
      if (next.has(passIdx)) next.delete(passIdx);
      else next.add(passIdx);
      return next;
    });
  };

  const handleCommandSelect = (cmd: CommandEntry) => {
    if (cmd.isDraw) {
      // Find global draw index by scanning commands up to this one
      let drawIdx = 0;
      for (let c = 0; c < cmd.eventIdx; c++) {
        const ce = commands[c];
        if (ce?.isDraw) drawIdx++;
      }
      setSelectedDrawIdx(drawIdx);
    } else {
      setSelectedCommandIdx(cmd.eventIdx);
    }
  };

  if (!vm) {
    return (
      <div className="p-4 h-full flex items-center justify-center">
        <p className="text-xs text-slate-500">No tape loaded</p>
      </div>
    );
  }

  if (tree.length === 0) {
    return (
      <div className="p-4 h-full flex items-center justify-center">
        <p className="text-xs text-slate-500">No events in tape</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-slate-900" {...{ [eventBrowserAnchor()]: filterMode }}>
      {/* Filter toggle header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-700/50 shrink-0">
        <button
          type="button"
          onClick={() => setFilterMode(filterMode === 'draws-only' ? 'all-commands' : 'draws-only')}
          className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ${
            filterMode === 'draws-only'
              ? 'bg-green-800/30 text-green-300 border border-green-700/30'
              : 'bg-slate-800 text-slate-400 border border-slate-700/30 hover:text-slate-300'
          }`}
        >
          {filterMode === 'draws-only' ? <Eye size={12} /> : <EyeOff size={12} />}
          {filterMode === 'draws-only' ? 'Draws Only' : 'All Commands'}
        </button>
        <span className="text-xs text-slate-600">
          {vm.meta.totalDraws} draws, {vm.meta.totalPasses} passes
        </span>
      </div>

      {/* Command list */}
      <div className="flex-1 overflow-y-auto p-1">
        {tree.map((passNode) => {
          const isCollapsed = collapsedPasses.has(passNode.passIdx);
          const passTree = passCommandTree.get(passNode.passIdx) ?? [];

          return (
            <div key={passNode.passIdx}>
              {/* Pass header */}
              <button
                type="button"
                onClick={() => togglePass(passNode.passIdx)}
                className="flex items-center gap-1.5 w-full text-left px-2 py-1 text-xs font-medium text-blue-300/80 hover:text-blue-200 transition-colors"
              >
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                {passNode.kind === 'render' ? (
                  <Layers size={12} className="text-blue-400" />
                ) : (
                  <List size={12} className="text-purple-400" />
                )}
                <span>
                  Pass #{passNode.passIdx} {passNode.kind === 'render' ? '(Render)' : '(Compute)'}
                </span>
                <span className="text-slate-600">({passNode.draws.length} draws)</span>
              </button>

              {/* Pass body */}
              {!isCollapsed && (
                <div className="ml-2 border-l border-slate-700/30 pl-1">
                  {filterMode === 'all-commands' ? (
                    passTree.length > 0 ? (
                      passTree.map((item, idx) => {
                        const itemKey =
                          item.type === 'command' ? `cmd-${item.command.eventIdx}` : `group-${idx}`;
                        return (
                          <TreeNode
                            key={itemKey}
                            item={item}
                            depth={0}
                            onSelect={handleCommandSelect}
                          />
                        );
                      })
                    ) : (
                      <p className="text-xs text-slate-600 px-2 py-1">No commands</p>
                    )
                  ) : passNode.draws.length > 0 ? (
                    passNode.draws.map((d) => (
                      <div key={d.drawIdx} className="pl-0">
                        <button
                          type="button"
                          onClick={() => setSelectedDrawIdx(d.drawIdx)}
                          className="w-full text-left px-2 py-0.5 text-xs flex items-center gap-1.5 rounded transition-colors hover:bg-slate-700/50 text-green-300 font-medium"
                          {...{
                            [commandRowAnchor()]: `draw-${d.drawIdx}`,
                            [drawAnchor()]: String(d.drawIdx),
                          }}
                        >
                          <Play size={10} className="shrink-0 text-green-400" />
                          <span>
                            {drawKindLabel(d.eventKind)} #{d.drawIdx}
                          </span>
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-slate-600 px-2 py-1">No draws</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
