// ResourceInspector.buffer-count.test.tsx — AC-05 buffer full listing count (w7).
//
// Asserts that ResourceInspector lists every buffer from createBuffer events
// with no omissions. Each buffer row displays size + decoded usage flags.
// Verifies counts for vertex, index, uniform, and storage buffers.
//
// Related: requirements AC-05; plan-strategy 5.1/5.2 TDD red-green.

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResourceInspector } from '../components/ResourceInspector';
import { SelectionContext } from '../selection-context';
import { ViewModelContext } from '../viewer-context';
import type { ViewModel } from '../viewer-model';

const mockProps = {
  api: {},
  containerApi: {},
  params: {},
  group: {},
  isActive: true,
  isVisible: true,
} as unknown as Parameters<typeof ResourceInspector>[0];

function makeSelection(overrides: { selectedDrawIdx?: number; selectedCommandIdx?: number } = {}) {
  return {
    selectedDrawIdx: overrides.selectedDrawIdx ?? -1,
    selectedCommandIdx: overrides.selectedCommandIdx ?? -1,
    setSelectedDrawIdx: () => {},
    setSelectedCommandIdx: () => {},
  } as const;
}

// --------------------------------------------------------------------------
// AC-05: buffer full listing — 3 buffers (vertex + index + uniform)
// --------------------------------------------------------------------------

function makeThreeBufferVM(): ViewModel {
  return {
    tree: [],
    draws: [],
    meta: { totalDraws: 0, totalPasses: 0, hasCompute: false },
    commands: [],
    resources: new Map([
      [
        'buf-vbo',
        {
          kind: 'createBuffer' as const,
          handleId: 'buf-vbo',
          size: 72,
          usage: 0x0020, // VERTEX
        },
      ],
      [
        'buf-ibo',
        {
          kind: 'createBuffer' as const,
          handleId: 'buf-ibo',
          size: 12,
          usage: 0x0010, // INDEX
        },
      ],
      [
        'buf-ubo',
        {
          kind: 'createBuffer' as const,
          handleId: 'buf-ubo',
          size: 256,
          usage: 0x0040, // UNIFORM
        },
      ],
    ]),
  };
}

const BUFFER_HANDLE_IDS = ['buf-vbo', 'buf-ibo', 'buf-ubo'];

describe('AC-05: buffer full listing count matches createBuffer events', () => {
  it('lists all 3 buffers with no omissions', () => {
    const vm = makeThreeBufferVM();
    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    for (const hid of BUFFER_HANDLE_IDS) {
      expect(container.textContent).toContain(hid);
    }
  });

  it('each buffer row shows size and decoded usage', () => {
    const vm = makeThreeBufferVM();
    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).toContain('size=72');
    expect(container.textContent).toContain('VERTEX');
    expect(container.textContent).toContain('size=12');
    expect(container.textContent).toContain('INDEX');
    expect(container.textContent).toContain('size=256');
    expect(container.textContent).toContain('UNIFORM');
  });

  it('buffer count in DOM matches createBuffer event count', () => {
    const vm = makeThreeBufferVM();
    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Count buffer rows by their handle anchor attribute.
    const bufferRows = Array.from(container.querySelectorAll('[data-forgeax-resource-row]')).filter(
      (el) => BUFFER_HANDLE_IDS.includes(el.getAttribute('data-forgeax-resource-row') ?? ''),
    );

    expect(bufferRows).toHaveLength(3);
  });
});

// --------------------------------------------------------------------------
// AC-05: include storage buffer (4th category)
// --------------------------------------------------------------------------

function makeFourBufferVM(): ViewModel {
  return {
    tree: [],
    draws: [],
    meta: { totalDraws: 0, totalPasses: 0, hasCompute: false },
    commands: [],
    resources: new Map([
      [
        'buf-vbo',
        {
          kind: 'createBuffer' as const,
          handleId: 'buf-vbo',
          size: 72,
          usage: 0x0020, // VERTEX
        },
      ],
      [
        'buf-ibo',
        {
          kind: 'createBuffer' as const,
          handleId: 'buf-ibo',
          size: 12,
          usage: 0x0010, // INDEX
        },
      ],
      [
        'buf-ubo',
        {
          kind: 'createBuffer' as const,
          handleId: 'buf-ubo',
          size: 256,
          usage: 0x0040, // UNIFORM
        },
      ],
      [
        'buf-sbo',
        {
          kind: 'createBuffer' as const,
          handleId: 'buf-sbo',
          size: 1024,
          usage: 0x0080, // STORAGE
        },
      ],
    ]),
  };
}

describe('AC-05: storage buffer included in full listing', () => {
  it('lists storage buffer alongside vertex/index/uniform', () => {
    const vm = makeFourBufferVM();
    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).toContain('buf-sbo');
    expect(container.textContent).toContain('STORAGE');
  });

  it('all 4 buffer rows present', () => {
    const vm = makeFourBufferVM();
    const allHandles = ['buf-vbo', 'buf-ibo', 'buf-ubo', 'buf-sbo'];
    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const bufferRows = Array.from(container.querySelectorAll('[data-forgeax-resource-row]')).filter(
      (el) => allHandles.includes(el.getAttribute('data-forgeax-resource-row') ?? ''),
    );

    expect(bufferRows).toHaveLength(4);
  });
});

// --------------------------------------------------------------------------
// AC-05: no buffers in tape — empty state
// --------------------------------------------------------------------------

function makeNoBufferVM(): ViewModel {
  return {
    tree: [],
    draws: [],
    meta: { totalDraws: 0, totalPasses: 0, hasCompute: false },
    commands: [],
    resources: new Map([
      [
        'sampler-1',
        {
          kind: 'createSampler' as const,
          handleId: 'sampler-1',
          desc: { magFilter: 'linear' as const, minFilter: 'linear' as const },
        },
      ],
    ]),
  };
}

describe('AC-05: no buffers in tape', () => {
  it('no Buffers category when tape has no buffers', () => {
    const vm = makeNoBufferVM();
    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).not.toContain('Buffers');
  });
});
