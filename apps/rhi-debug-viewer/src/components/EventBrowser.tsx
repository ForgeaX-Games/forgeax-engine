import { ChevronDown, ChevronRight, List, Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSelection } from '../selection-context';
import { commandRowAnchor, eventBrowserAnchor, passAnchor, selectedAnchor } from '../selectors';
import { useViewModel } from '../viewer-context';

interface PanelProps {
  readonly className?: string;
}

export function EventBrowser(_props?: PanelProps) {
  const model = useViewModel();
  const { selectedWorkIndex, selectCommand, selectWork } = useSelection();
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [mode, setMode] = useState<'works-only' | 'all-commands'>('works-only');

  const passes = model?.passes ?? [];
  const works = model?.works ?? [];
  const commands = model?.commands ?? [];
  const workByPass = useMemo(() => {
    const result = new Map<number, (typeof works)[number][]>();
    for (const work of works) {
      const list = result.get(work.passIndex) ?? [];
      list.push(work);
      result.set(work.passIndex, list);
    }
    return result;
  }, [works]);
  const commandsByPass = useMemo(() => {
    const result = new Map<number, (typeof commands)[number][]>();
    for (const command of commands) {
      const list = result.get(command.passIndex) ?? [];
      list.push(command);
      result.set(command.passIndex, list);
    }
    return result;
  }, [commands]);

  if (!model) {
    return (
      <div className="forgeax-panel grid place-items-center text-xs text-muted-foreground">
        <div className="text-center">
          <p className="font-medium text-foreground">No tape loaded</p>
          <p className="mt-1">Import or drop one v7 .rhitape</p>
        </div>
      </div>
    );
  }

  const toggle = (passIndex: number) => {
    const next = new Set(collapsed);
    if (next.has(passIndex)) next.delete(passIndex);
    else next.add(passIndex);
    setCollapsed(next);
  };

  return (
    <section className="forgeax-panel flex flex-col" {...{ [eventBrowserAnchor()]: mode }}>
      <header className="forgeax-panel-header">
        <span>Event Browser</span>
        <span className="forgeax-segmented">
          <button
            type="button"
            className={mode === 'works-only' ? 'forgeax-segment-active' : 'forgeax-segment'}
            onClick={() => setMode('works-only')}
          >
            Works only
          </button>
          <button
            type="button"
            className={mode === 'all-commands' ? 'forgeax-segment-active' : 'forgeax-segment'}
            onClick={() => setMode('all-commands')}
          >
            All commands
          </button>
        </span>
      </header>
      <div className="flex-1 overflow-auto p-1.5">
        {passes.map((pass) => {
          const passWorks = workByPass.get(pass.passIndex) ?? [];
          const isCollapsed = collapsed.has(pass.passIndex);
          return (
            <div key={pass.passIndex}>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-brand transition-colors hover:bg-muted/60"
                onClick={() => toggle(pass.passIndex)}
                {...{ [passAnchor()]: String(pass.passIndex) }}
              >
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <List size={12} />
                <span>
                  {pass.kind === 'render' ? 'Render' : 'Compute'} pass #{pass.passIndex}
                </span>
                <span className="text-muted-foreground">
                  (
                  {mode === 'works-only'
                    ? passWorks.length
                    : (commandsByPass.get(pass.passIndex)?.length ?? 0)}
                  )
                </span>
              </button>
              {!isCollapsed && (
                <div className="ml-3 border-l border-border/80 pl-1.5">
                  {(mode === 'works-only'
                    ? passWorks.map((work) => ({
                        kind: 'work' as const,
                        work,
                        command: commands[work.commandIndex],
                      }))
                    : (commandsByPass.get(pass.passIndex) ?? []).map((command) => ({
                        kind: 'command' as const,
                        command,
                        work: works.find(
                          (candidate) => candidate.eventIndex === command.eventIndex,
                        ),
                      }))
                  ).map((entry) => {
                    const work = entry.work;
                    const command = entry.command;
                    const selected = work !== undefined && selectedWorkIndex === work.workIndex;
                    return (
                      <button
                        type="button"
                        key={command?.eventIndex ?? work?.workIndex}
                        className={
                          selected
                            ? 'flex w-full min-w-0 items-center gap-1.5 rounded-md border border-brand/20 bg-brand/10 px-2 py-1.5 text-left text-xs text-brand'
                            : 'flex w-full min-w-0 items-center gap-1.5 rounded-md border border-transparent px-2 py-1.5 text-left text-xs text-success transition-colors hover:border-border/70 hover:bg-muted/60'
                        }
                        onClick={() => {
                          if (work !== undefined)
                            selectWork(work.workIndex, work.eventIndex, work.passIndex);
                          else if (command !== undefined)
                            selectCommand(command.eventIndex, command.passIndex);
                        }}
                        {...{
                          [commandRowAnchor()]: String(
                            command?.eventIndex ?? work?.eventIndex ?? -1,
                          ),
                          ...(work === undefined
                            ? {}
                            : {
                                'data-forgeax-work-index': String(work.workIndex),
                                ...(selected ? { [selectedAnchor()]: 'true' } : {}),
                              }),
                        }}
                      >
                        {work === undefined ? <List size={10} /> : <Play size={10} />}
                        <span className="shrink-0 font-medium">
                          {work === undefined
                            ? `event ${command?.eventIndex ?? -1}`
                            : `#${work.workIndex} ${work.kind}`}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {command?.kind ?? 'work'}
                        </span>
                        {command !== undefined && command.group.length > 0 && (
                          <span className="truncate">{command.group.join(' / ')}</span>
                        )}
                        {command?.marker !== undefined && (
                          <span className="truncate">{command.marker}</span>
                        )}
                        {command !== undefined && (
                          <span className="truncate font-mono text-[10px] text-muted-foreground">
                            {JSON.stringify(command.params)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {(mode === 'works-only'
                    ? passWorks.length
                    : (commandsByPass.get(pass.passIndex)?.length ?? 0)) === 0 && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">No commands</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {passes.length === 0 && (
          <p className="p-2 text-xs text-muted-foreground">No events in tape</p>
        )}
        {commands.length > 0 && (
          <button
            type="button"
            className="sr-only"
            onClick={() => selectCommand(commands[0]?.eventIndex ?? 0)}
            {...{ [commandRowAnchor()]: '0' }}
          >
            command
          </button>
        )}
      </div>
    </section>
  );
}
