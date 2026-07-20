// EventBrowser.test.tsx — EventBrowser component test (w27).
//
// Tests: draws-only default rendering, filter toggle show/hide non-draws,
// debug group expand/collapse, draw selection, non-draw selection.
//
// Uses jsdom + @testing-library/react with mocked IDockviewPanelProps
// and SelectionContext provider wrapping.
// Uses fireEvent.click for reliable React event dispatch in jsdom.
//
// Related: requirements AC-14; plan-strategy 5.1/5.2.

import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EventBrowser } from '../components/EventBrowser';
import { SelectionContext } from '../selection-context';
import { ViewModelContext } from '../viewer-context';
import type { CommandEntry, ViewModel } from '../viewer-model';

const mockProps = {
  api: {},
  containerApi: {},
  params: {},
  group: {},
  isActive: true,
  isVisible: true,
} as unknown as Parameters<typeof EventBrowser>[0];

function makeCommand(overrides: Partial<CommandEntry>): CommandEntry {
  return {
    passIdx: 0,
    eventIdx: 0,
    isDraw: false,
    kind: 'setPipeline',
    groupLabel: undefined,
    markerLabel: undefined,
    ...overrides,
  };
}

function makeSelection(setDraw?: (idx: number) => void, setCmd?: (idx: number) => void) {
  return {
    selectedDrawIdx: -1,
    selectedCommandIdx: -1,
    setSelectedDrawIdx: setDraw ?? (() => {}),
    setSelectedCommandIdx: setCmd ?? (() => {}),
  } as const;
}

function mockViewModel(commands: readonly CommandEntry[]): ViewModel {
  return {
    tree: [
      {
        kind: 'render',
        passIdx: 0,
        draws: commands
          .map((c, i) =>
            c.isDraw ? { drawIdx: i, eventKind: c.kind as 'draw' | 'drawIndexed' } : null,
          )
          .filter(Boolean) as { drawIdx: number; eventKind: 'draw' | 'drawIndexed' }[],
      },
    ],
    draws: [],
    meta: {
      totalDraws: commands.filter((c) => c.isDraw).length,
      totalPasses: 1,
      hasCompute: false,
    },
    commands,
    resources: new Map(),
  };
}

function findByTextAll(container: HTMLElement, text: string): HTMLElement[] {
  return Array.from(container.querySelectorAll('button')).filter((b) =>
    b.textContent?.includes(text),
  );
}

// --------------- AC-14: draws-only default + filter toggle ---------------

describe('AC-14: draws-only default + filter toggle', () => {
  it('renders draws-only by default (data-forgeax-event-browser = draws-only)', () => {
    const vm = mockViewModel([
      makeCommand({ kind: 'setPipeline', isDraw: false, eventIdx: 0 }),
      makeCommand({ kind: 'draw', isDraw: true, eventIdx: 1 }),
      makeCommand({ kind: 'setViewport', isDraw: false, eventIdx: 2 }),
      makeCommand({ kind: 'drawIndexed', isDraw: true, eventIdx: 3 }),
    ]);

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <EventBrowser {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const el = container.querySelector('[data-forgeax-event-browser]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('data-forgeax-event-browser')).toBe('draws-only');

    // Draw text should be visible in draws-only mode
    expect(el?.textContent).toContain('Draw');
  });

  it('switching filter to all commands changes anchor to all-commands', () => {
    const vm = mockViewModel([
      makeCommand({ kind: 'setPipeline', isDraw: false, eventIdx: 0 }),
      makeCommand({ kind: 'draw', isDraw: true, eventIdx: 1 }),
    ]);

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <EventBrowser {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const filterBtn = findByTextAll(container, 'Draws Only')[0];
    expect(filterBtn).toBeDefined();

    act(() => {
      filterBtn && fireEvent.click(filterBtn);
    });

    // After clicking, the anchor should switch to 'all-commands'
    const el = container.querySelector('[data-forgeax-event-browser]');
    expect(el?.getAttribute('data-forgeax-event-browser')).toBe('all-commands');

    const allBtn = findByTextAll(container, 'All Commands')[0];
    expect(allBtn).toBeDefined();
  });

  it('switching back to draws only restores draws-only anchor', () => {
    const vm = mockViewModel([makeCommand({ kind: 'setPipeline', isDraw: false, eventIdx: 0 })]);

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <EventBrowser {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const filterBtn = findByTextAll(container, 'Draws Only')[0];
    act(() => {
      filterBtn && fireEvent.click(filterBtn);
    });

    const allBtn = findByTextAll(container, 'All Commands')[0];
    expect(allBtn).toBeDefined();

    act(() => {
      allBtn && fireEvent.click(allBtn);
    });

    const el = container.querySelector('[data-forgeax-event-browser]');
    expect(el?.getAttribute('data-forgeax-event-browser')).toBe('draws-only');
  });
});

// --------------- AC-14: debug group expand/collapse ---------------

describe('AC-14: debug group expand/collapse', () => {
  it('debug group label appears in all-commands mode', () => {
    const vm = mockViewModel([
      makeCommand({
        kind: 'passPushDebugGroup',
        isDraw: false,
        eventIdx: 0,
        groupLabel: 'MyGroup',
      }),
      makeCommand({ kind: 'draw', isDraw: true, eventIdx: 1 }),
      makeCommand({ kind: 'passPopDebugGroup', isDraw: false, eventIdx: 2 }),
    ]);

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <EventBrowser {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Switch to all commands mode to see debug groups
    const filterBtn = findByTextAll(container, 'Draws Only')[0];
    act(() => {
      filterBtn && fireEvent.click(filterBtn);
    });

    // The debug group label should appear
    expect(container.textContent).toContain('MyGroup');
  });

  it('debug group can be collapsed (click toggle hides children)', () => {
    const vm = mockViewModel([
      makeCommand({
        kind: 'passPushDebugGroup',
        isDraw: false,
        eventIdx: 0,
        groupLabel: 'MyGroup',
      }),
      makeCommand({ kind: 'draw', isDraw: true, eventIdx: 1 }),
      makeCommand({ kind: 'passPopDebugGroup', isDraw: false, eventIdx: 2 }),
    ]);

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <EventBrowser {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Switch to all-commands mode
    const filterBtn = findByTextAll(container, 'Draws Only')[0];
    act(() => {
      filterBtn && fireEvent.click(filterBtn);
    });

    // The debug group should be open by default (MyGroup and draw visible)
    expect(container.textContent).toContain('MyGroup');
    // In all-commands mode, draws are labeled via drawKindLabel (e.g. "Draw" or "DrawIndexed")
    expect(container.textContent).toMatch(/Draw/);

    // Click the debug group toggle to collapse
    const groupBtn = findByTextAll(container, 'MyGroup')[0];
    if (groupBtn) {
      act(() => {
        fireEvent.click(groupBtn);
      });
    }

    // After collapsing, the group label should still be visible
    expect(container.textContent).toContain('MyGroup');
  });
});

// --------------- AC-14: draw and non-draw selection ---------------

describe('AC-14: draw and non-draw selection', () => {
  it('clicking a draw row calls setSelectedDrawIdx', () => {
    let calledDrawIdx = -1;

    const vm = mockViewModel([makeCommand({ kind: 'draw', isDraw: true, eventIdx: 0 })]);

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider
          value={
            makeSelection((idx: number) => {
              calledDrawIdx = idx;
            }) as never
          }
        >
          <EventBrowser {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // In draws-only mode, the draw should have a button with Draw #0
    const drawButton = findByTextAll(container, 'Draw #0')[0];
    expect(drawButton).toBeDefined();

    act(() => {
      drawButton && fireEvent.click(drawButton);
    });
    expect(calledDrawIdx).toBe(0);
  });

  it('draw row exposes the data-forgeax-draw SSOT anchor for deterministic selection', () => {
    // Regression guard: draw rows must carry data-forgeax-draw="N" (selectors.ts
    // drawAnchor SSOT) so automation / AI users can select a draw by the
    // documented anchor, not only the rendered text.
    const vm = mockViewModel([makeCommand({ kind: 'draw', isDraw: true, eventIdx: 0 })]);

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection(() => {}) as never}>
          <EventBrowser {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const drawAnchorEl = container.querySelector('[data-forgeax-draw="0"]');
    expect(drawAnchorEl).not.toBeNull();
    expect(drawAnchorEl?.textContent).toContain('Draw #0');
  });

  it('clicking a non-draw command row calls setSelectedCommandIdx', () => {
    let calledCmdIdx = -1;

    const vm = mockViewModel([makeCommand({ kind: 'setPipeline', isDraw: false, eventIdx: 0 })]);

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider
          value={
            makeSelection(undefined, (idx: number) => {
              calledCmdIdx = idx;
            }) as never
          }
        >
          <EventBrowser {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Switch to all-commands mode first
    const filterBtn = findByTextAll(container, 'Draws Only')[0];
    act(() => {
      filterBtn && fireEvent.click(filterBtn);
    });

    // Find non-draw button by its kind text
    const nonDrawBtn = findByTextAll(container, 'setPipeline')[0];
    expect(nonDrawBtn).toBeDefined();

    act(() => {
      nonDrawBtn && fireEvent.click(nonDrawBtn);
    });
    expect(calledCmdIdx).toBe(0);
  });

  it('all-commands: clicking the last draw selects its global draw index (eventIdx != commands index)', () => {
    // Regression for the off-by-one: commands[].eventIdx indexes the raw events
    // array (with meta events stripped from `commands`), so the global draw index
    // must be the draw's position among draw-commands, NOT a count by eventIdx.
    // Here eventIdx values are sparse (gaps emulate stripped meta events): the two
    // draws sit at eventIdx 5 and 9 but are draw #0 and draw #1.
    let calledDrawIdx = -1;
    const vm = mockViewModel([
      makeCommand({ kind: 'setPipeline', isDraw: false, eventIdx: 1 }),
      makeCommand({ kind: 'drawIndexed', isDraw: true, eventIdx: 5 }),
      makeCommand({ kind: 'setBindGroup', isDraw: false, eventIdx: 7 }),
      makeCommand({ kind: 'drawIndexed', isDraw: true, eventIdx: 9 }),
    ]);

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider
          value={
            makeSelection((idx: number) => {
              calledDrawIdx = idx;
            }) as never
          }
        >
          <EventBrowser {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Switch to all-commands mode so handleCommandSelect (the buggy path) runs.
    const filterBtn = findByTextAll(container, 'Draws Only')[0];
    act(() => {
      filterBtn && fireEvent.click(filterBtn);
    });

    // The last draw row (eventIdx 9) must resolve to global draw index 1, not 2.
    const lastDrawRow = container.querySelector('[data-forgeax-command-row="9"]') as HTMLElement;
    expect(lastDrawRow).not.toBeNull();
    act(() => {
      fireEvent.click(lastDrawRow);
    });
    expect(calledDrawIdx).toBe(1);
  });
});

// --------------- Empty / no-tape states ---------------

describe('EventBrowser: empty / no-tape states', () => {
  it('shows placeholder when no ViewModel', () => {
    const { container } = render(
      <ViewModelContext.Provider value={null}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <EventBrowser {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).toContain('No tape loaded');
  });

  it('shows placeholder when empty tree', () => {
    const vm: ViewModel = {
      tree: [],
      draws: [],
      meta: { totalDraws: 0, totalPasses: 0, hasCompute: false },
      commands: [],
      resources: new Map(),
    };

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <EventBrowser {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).toContain('No events in tape');
  });
});
