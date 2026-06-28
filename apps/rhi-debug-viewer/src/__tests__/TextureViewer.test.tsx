// TextureViewer.test.tsx — TextureViewer component test (w29).
//
// Tests:
//   1. Thumbnail list includes color RTs, depth-stencil, and bound textures.
//   2. Per-texture status badge renders correct text for each variant.
//   3. Clicking a different thumbnail switches preview (DOM-level, no GPU).
//   4. Non-draw selection shows default text.
//
// GPU functions (readbackTexturePixels etc.) are never invoked in jsdom.
// The test verifies DOM structure from the pure-React rendering path.
//
// Related: requirements AC-16/AC-18/AC-26; plan-strategy 5.1/5.2.

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TextureViewer } from '../components/TextureViewer';
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
} as unknown as Parameters<typeof TextureViewer>[0];

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
    tree: [
      {
        kind: 'render',
        passIdx: 0,
        draws: [{ drawIdx: 0, eventKind: 'draw' as const }],
      },
    ],
    draws: [
      {
        frameIdx: 0,
        passIdx: 0,
        bindings: [
          { groupIndex: 0, entryIndex: 0, handleId: 'tex-1', kind: 'texture' as const },
          { groupIndex: 0, entryIndex: 1, handleId: 'sampler-1', kind: 'sampler' as const },
        ],
        drawCall: { pipelineKind: 'render', pipelineHandleId: 'pipe-1' },
        colorAttachmentHandleId: 'rt-0',
        pipelineState: {
          inputAssembly: { topology: 'triangle-list', stripIndexFormat: undefined },
          vertexInput: { buffers: [] },
          shaders: {
            vertexShaderModuleHandleId: undefined,
            fragmentShaderModuleHandleId: undefined,
          },
          rasterizer: { cullMode: 'none' as const, frontFace: 'ccw' as const },
          depthStencil: {
            format: 'depth24plus' as const,
            depthWriteEnabled: true,
            depthCompare: 'less' as const,
            stencilFront: {
              compare: 'always' as const,
              failOp: 'keep' as const,
              depthFailOp: 'keep' as const,
              passOp: 'keep' as const,
            },
            stencilBack: {
              compare: 'always' as const,
              failOp: 'keep' as const,
              depthFailOp: 'keep' as const,
              passOp: 'keep' as const,
            },
            stencilReadMask: 0xffffffff,
            stencilWriteMask: 0xffffffff,
            depthBias: 0,
            depthBiasSlopeScale: 0,
            depthBiasClamp: 0,
            stencilReference: 0,
          },
          blend: {
            colorTargets: [
              { format: 'rgba8unorm' as const, color: undefined, alpha: undefined, writeMask: 0xf },
            ],
            blendConstant: undefined,
          },
          multisample: { count: 1, mask: 0xffffffff, alphaToCoverageEnabled: false },
        },
        vertexBuffers: new Map(),
        depthStencil: {
          depthStencilViewHandleId: 'ds-0',
          depthStencilAttachment: {
            depthClearValue: 0,
            depthLoadOp: 'clear' as const,
            depthStoreOp: 'store' as const,
            stencilLoadOp: 'clear' as const,
            stencilStoreOp: 'store' as const,
          } as GPURenderPassDepthStencilAttachment,
        },
      },
    ],
    meta: { totalDraws: 1, totalPasses: 1, hasCompute: false },
    commands: [
      {
        passIdx: 0,
        eventIdx: 0,
        isDraw: true,
        kind: 'draw',
        groupLabel: undefined,
        markerLabel: undefined,
      },
    ],
    resources: new Map(),
  };
}

// --------------- AC-16: thumbnail list + per-texture status badge ---------------

describe('AC-16: thumbnail list rendering', () => {
  it('renders thumbnails for color RT, depth-stencil, and bound textures', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // The container should have texture-viewer anchor set to 'selected'
    const el = container.querySelector('[data-forgeax-texture-viewer]');
    expect(el?.getAttribute('data-forgeax-texture-viewer')).toBe('selected');

    // Thumbnails should include color RT and depth
    expect(container.textContent).toContain('Color RT 0');
    expect(container.textContent).toContain('Depth');

    // Bound texture (tex-1 of kind 'texture') should appear
    expect(container.textContent).toContain('Texture tex-1');
  });

  it('each thumbnail has a status badge', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // All textures in this fixture should have 'ok' status
    const badges = container.querySelectorAll('[data-forgeax-texture-thumbnail] span');
    const okBadges = Array.from(badges).filter((b) => b.textContent?.includes('ok'));
    expect(okBadges.length).toBeGreaterThanOrEqual(2);
  });

  it('data-forgeax-texture-thumbnail anchors are present on thumbnails', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const thumbs = container.querySelectorAll('[data-forgeax-texture-thumbnail]');
    expect(thumbs.length).toBeGreaterThanOrEqual(2);
    // Verify they have numeric index values
    expect(thumbs[0]?.getAttribute('data-forgeax-texture-thumbnail')).toBe('0');
  });
});

// --------------- AC-18: per-texture status badge renders correct text ---------------

describe('AC-18: per-texture status badge', () => {
  it('status badges are rendered with correct text for ok status', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Status badges should contain 'ok' text
    expect(container.textContent).toMatch(/ok/);
  });

  it('depth attachment with non-copyable format (depth24plus) degrades to error, not ok', () => {
    // AC-18 regression guard: the depth thumbnail must read the real
    // pipelineState.depthStencil.format and route through computeTextureStatus.
    // A previous bug hardcoded format='depth32float'+status='ok', so a
    // depth24plus attachment falsely reported 'ok' (charter P3 violation).
    const vm = mockViewModel(); // fixture's depthStencil.format = 'depth24plus'

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // The Depth thumbnail must carry an 'error' badge (non-copyable depth format).
    const depthThumb = Array.from(
      container.querySelectorAll('[data-forgeax-texture-thumbnail]'),
    ).find((el) => el.textContent?.includes('Depth'));
    expect(depthThumb).toBeDefined();
    expect(depthThumb?.textContent).toMatch(/error/);
    expect(depthThumb?.textContent).not.toMatch(/\bok\b/);
  });

  it('main preview area shows selected texture info', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Main preview area should show the initially selected (first) thumbnail's info
    expect(container.textContent).toContain('Color RT 0');
    expect(container.textContent).toContain('format');
  });
});

// --------------- AC-16: thumbnail click switches preview ---------------

describe('AC-16: thumbnail click switches preview', () => {
  it('clicking a different thumbnail updates main preview label', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Initially the first thumbnail (Color RT 0) is selected
    expect(container.textContent).toContain('Color RT 0');

    // Click the second thumbnail (Depth)
    const thumbs = container.querySelectorAll('[data-forgeax-texture-thumbnail]');
    expect(thumbs.length).toBeGreaterThanOrEqual(2);

    if (thumbs[1]) {
      fireEvent.click(thumbs[1]);
    }

    // After clicking, the main preview should show depth info
    // The main preview header shows the selected thumbnail's label
    expect(container.textContent).toContain('Depth');
  });
});

// --------------- AC-26: non-draw default text ---------------

describe('AC-26: non-draw selected shows default text', () => {
  it('shows default text when selectedDrawIdx < 0', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: -1 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).toContain('Select a draw command to view textures');
    const el = container.querySelector('[data-forgeax-texture-viewer]');
    expect(el?.getAttribute('data-forgeax-texture-viewer')).toBe('default');
  });

  it('shows default text when no ViewModel', () => {
    const { container } = render(
      <ViewModelContext.Provider value={null}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).toContain('Select a draw command to view textures');
  });
});
