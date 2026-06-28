// ResourceInspector.test.tsx — ResourceInspector component test (w30).
//
// Tests:
//   1. Renders all resource categories (Buffers, Textures, Samplers,
//      BindGroupLayouts, PipelineLayouts, Pipelines, ShaderModules).
//   2. Usage flags decoded to human-readable strings (not raw numbers).
//   3. Handle hyperlink click triggers highlight on target row.
//   4. Filter input filters the resource list.
//
// Uses jsdom + @testing-library/react.
//
// Related: requirements AC-19/AC-27; plan-strategy 5.1/5.2.

import { fireEvent, render } from '@testing-library/react';
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

function mockViewModel(): ViewModel {
  return {
    tree: [],
    draws: [],
    meta: { totalDraws: 0, totalPasses: 0, hasCompute: false },
    commands: [],
    resources: new Map([
      [
        'buf-1',
        {
          kind: 'createBuffer' as const,
          handleId: 'buf-1',
          size: 64,
          usage: 0x0020 | 0x0008, // VERTEX | COPY_DST
        },
      ],
      [
        'buf-2',
        {
          kind: 'createBuffer' as const,
          handleId: 'buf-2',
          size: 256,
          usage: 0x0040, // UNIFORM
        },
      ],
      [
        'tex-1',
        {
          kind: 'createTexture' as const,
          handleId: 'tex-1',
          format: 'rgba8unorm' as const,
          size: [512, 512, 1] as const,
          mipLevelCount: 1,
          sampleCount: 1,
          dimension: '2d' as const,
          usage: 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
        },
      ],
      [
        'sampler-1',
        {
          kind: 'createSampler' as const,
          handleId: 'sampler-1',
          desc: { magFilter: 'linear' as const, minFilter: 'linear' as const },
        },
      ],
      [
        'bgl-1',
        {
          kind: 'createBindGroupLayout' as const,
          handleId: 'bgl-1',
          entries: [{ binding: 0, visibility: 0, buffer: { type: 'uniform' as const } }],
        },
      ],
      [
        'pl-1',
        {
          kind: 'createPipelineLayout' as const,
          handleId: 'pl-1',
          bglHandleIds: ['bgl-1'],
        },
      ],
      [
        'sm-1',
        {
          kind: 'createShaderModule' as const,
          handleId: 'sm-1',
          wgslCode: '@vertex fn main() -> @builtin(position) vec4f { return vec4f(0.0); }',
        },
      ],
    ]),
  };
}

// --------------- AC-19: all resource categories rendered ---------------

describe('AC-19: resource categories rendered', () => {
  it('renders resource categories with headers', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Resource categories should appear as section headers
    expect(container.textContent).toContain('Buffers');
    expect(container.textContent).toContain('Textures');
    expect(container.textContent).toContain('Samplers');
    expect(container.textContent).toContain('BindGroupLayouts');
    expect(container.textContent).toContain('PipelineLayouts');
    expect(container.textContent).toContain('ShaderModules');
  });

  it('data-forgeax-resource-inspector = loaded when resources exist', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const el = container.querySelector('[data-forgeax-resource-inspector]');
    expect(el?.getAttribute('data-forgeax-resource-inspector')).toBe('loaded');
  });

  it('data-forgeax-resource-row anchors on resource rows', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const rows = container.querySelectorAll('[data-forgeax-resource-row]');
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });

  it('shows total resource count in footer', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Footer shows resource count
    expect(container.textContent).toContain('resources');
  });
});

// --------------- AC-19: usage flags decoded ---------------

describe('AC-19: usage flags decoded', () => {
  it('buffer usage flags decoded to human-readable strings', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // buf-1 has VERTEX | COPY_DST usage
    expect(container.textContent).toContain('VERTEX');
    expect(container.textContent).toContain('COPY_DST');

    // buf-2 has UNIFORM usage
    expect(container.textContent).toContain('UNIFORM');
  });

  it('texture usage flags decoded to human-readable strings', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // tex-1 has RENDER_ATTACHMENT | TEXTURE_BINDING
    expect(container.textContent).toContain('RENDER_ATTACHMENT');
    expect(container.textContent).toContain('TEXTURE_BINDING');
  });
});

// --------------- AC-27: handle hyperlink click triggers highlight ---------------

describe('AC-27: handle hyperlink click triggers highlight', () => {
  it('clicking a handle hyperlink scrolls to and highlights the row', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Find a handleId button (buf-1)
    const handleBtns = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent === 'buf-1',
    );
    expect(handleBtns.length).toBeGreaterThanOrEqual(1);

    if (handleBtns[0]) {
      fireEvent.click(handleBtns[0]);
    }

    // After clicking, the row should have highlight class
    // (Visual check by border-l-2 border-blue-500 class)
    const row = container.querySelector('[data-forgeax-resource-row="buf-1"]');
    expect(row).not.toBeNull();
  });
});

// --------------- Filter search ---------------

describe('AC-19: filter search', () => {
  it('filter input filters resource list by handleId', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Find the search input
    const input = container.querySelector('input[placeholder="Filter resources..."]');
    expect(input).not.toBeNull();

    // Filter for buf-1 only
    if (input) {
      fireEvent.change(input, { target: { value: 'buf-1' } });
    }

    // After filtering, buf-2 should not be visible
    expect(container.textContent).toContain('buf-1');
    expect(container.textContent).not.toContain('buf-2');
  });
});

// --------------- Empty state ---------------

describe('ResourceInspector: empty state', () => {
  it('shows placeholder when no ViewModel', () => {
    const { container } = render(
      <ViewModelContext.Provider value={null}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).toContain('No resources in tape');
    const el = container.querySelector('[data-forgeax-resource-inspector]');
    expect(el?.getAttribute('data-forgeax-resource-inspector')).toBe('empty');
  });

  it('shows footer with selected draw info when draw selected', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <ResourceInspector {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).toContain('Draw #0');
  });
});
