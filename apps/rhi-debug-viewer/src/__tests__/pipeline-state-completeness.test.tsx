import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ViewerPanels } from '../App';
import type { ViewerModel } from '../viewer-model';
import { makeEmptyResourceLifecycle } from './viewer-model-fixtures';

function model(): ViewerModel {
  return {
    commands: [],
    resources: [],
    resourceLifecycle: makeEmptyResourceLifecycle(),
    works: [
      {
        workIndex: 2,
        eventIndex: 9,
        passIndex: 1,
        kind: 'draw',
        commandIndex: 3,
        drawCall: { vertexCount: 3, instanceCount: 4 },
        pipeline: {
          status: 'available',
          pipelineHandleId: 'pipeline:main',
          kind: 'render',
          descriptor: { topology: 'triangle-list' },
          shaders: [
            {
              stage: 'vertex',
              moduleHandleId: 'shader:vertex',
              entryPoint: 'vsMain',
              source: 'vertex source',
            },
            {
              stage: 'fragment',
              moduleHandleId: 'shader:fragment',
              entryPoint: 'fsMain',
              source: 'fragment source',
            },
          ],
        },
        bindings: [
          {
            groupIndex: 2,
            binding: 1,
            bindGroupId: 'bind-group:main',
            resourceId: 'texture:color',
            resourceKind: 'texture',
            bufferOffset: null,
            bufferSize: null,
          },
        ],
        vertexBuffers: [{ slot: 0, bufferHandleId: 'buffer:vertex', offset: 8, size: 36 }],
        indexBuffer: { bufferHandleId: 'buffer:index', format: 'uint16', offset: 0, size: 12 },
        attachments: { colorViewHandleIds: ['view:color'], depthStencilViewHandleId: 'view:depth' },
      },
    ],
    passes: [
      {
        passIndex: 1,
        kind: 'render',
        beginEventIndex: 8,
        endEventIndex: 11,
        workIndices: [2],
        commandIndices: [3],
        colorAttachmentViewHandleIds: ['view:color'],
        depthStencilViewHandleId: 'view:depth',
      },
    ],
    events: [],
  };
}

describe('PipelineState completeness', () => {
  it('renders pipeline identity, shaders, bindings, and vertex/index ranges', () => {
    const { container } = render(<ViewerPanels model={model()} />);
    fireEvent.click(container.querySelector('[data-forgeax-work-index="2"]') as HTMLElement);
    expect(screen.getByText('pipeline:main')).toBeTruthy();
    expect(screen.getAllByText(/vsMain/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/fsMain/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/bind-group:main/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/buffer:vertex/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/uint16/).length).toBeGreaterThan(0);
  });

  it('keeps all eight pipeline sections anchored to one selected work', () => {
    const { container } = render(<ViewerPanels model={model()} />);
    fireEvent.click(container.querySelector('[data-forgeax-work-index="2"]') as HTMLElement);
    for (const label of [
      'Input Assembly',
      'Vertex Input',
      'Shaders',
      'Rasterizer',
      'Depth-Stencil',
      'Blend',
      'Multisample',
      'Resource Bindings',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(container.querySelector('[data-forgeax-work-index="2"]')).not.toBeNull();
  });
});
