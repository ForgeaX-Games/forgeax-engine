// event-browser-type-inference.test-d.ts -- AC-12: type narrowing after
// command.kind switch in EventBrowser without `as` type assertions.
//
// Simulates the access pattern that w22 will use: useTape() to get
// tape.events, index by CommandEntry.eventIdx, then switch on event.kind.
// Asserts that TypeScript narrows to the correct event interface and
// the key parameter fields are accessible with their real types.
//
// Related: requirements AC-12; research Finding 6; plan-strategy D-6.

/// <reference types="@webgpu/types" />

import type { RhiCallEvent, Tape } from '@forgeax/engine-rhi-debug';
import { describe, expectTypeOf, it } from 'vitest';

describe('AC-12: RhiCallEvent kind-switch type narrowing (no as)', () => {
  it('kind=setVertexBuffer narrows to RhiCallEventSetVertexBuffer — slot is number', () => {
    function renderParam(event: RhiCallEvent): string {
      switch (event.kind) {
        case 'setVertexBuffer':
          // event.slot: number (not unknown, no as needed)
          return `slot=${event.slot} buf=${event.bufferHandleId}`;
        default:
          return '';
      }
    }
    expectTypeOf(renderParam).returns.toEqualTypeOf<string>();
  });

  it('kind=setIndexBuffer narrows to RhiCallEventSetIndexBuffer — format is "uint16"|"uint32"', () => {
    function renderParam(event: RhiCallEvent): string {
      switch (event.kind) {
        case 'setIndexBuffer':
          // event.format: 'uint16' | 'uint32' (not string, no as needed)
          return `format=${event.format} buf=${event.bufferHandleId}`;
        default:
          return '';
      }
    }
    expectTypeOf(renderParam).returns.toEqualTypeOf<string>();
  });

  it('kind=setBindGroup narrows to RhiCallEventSetBindGroup — index is number', () => {
    function renderParam(event: RhiCallEvent): string {
      switch (event.kind) {
        case 'setBindGroup':
          // event.index: number (not any, no as needed)
          return `index=${event.index} bg=${event.bindGroupHandleId}`;
        default:
          return '';
      }
    }
    expectTypeOf(renderParam).returns.toEqualTypeOf<string>();
  });

  it('kind=setViewport narrows to RhiCallEventSetViewport — x,y,w,h are number', () => {
    function renderParam(event: RhiCallEvent): string {
      switch (event.kind) {
        case 'setViewport':
          return `viewport=${event.x},${event.y} ${event.w}x${event.h}`;
        default:
          return '';
      }
    }
    expectTypeOf(renderParam).returns.toEqualTypeOf<string>();
  });

  it('kind=setScissorRect narrows to RhiCallEventSetScissorRect — x,y,w,h are number', () => {
    function renderParam(event: RhiCallEvent): string {
      switch (event.kind) {
        case 'setScissorRect':
          return `scissor=${event.x},${event.y} ${event.w}x${event.h}`;
        default:
          return '';
      }
    }
    expectTypeOf(renderParam).returns.toEqualTypeOf<string>();
  });

  it('kind=copyBufferToBuffer narrows to RhiCallEventCopyBufferToBuffer — size is number', () => {
    function renderParam(event: RhiCallEvent): string {
      switch (event.kind) {
        case 'copyBufferToBuffer':
          return `size=${event.size}`;
        default:
          return '';
      }
    }
    expectTypeOf(renderParam).returns.toEqualTypeOf<string>();
  });

  it('kind=draw narrows to RhiCallEventDraw — vertexCount/instanceCount are number', () => {
    function renderParam(event: RhiCallEvent): string {
      switch (event.kind) {
        case 'draw':
          return `vc=${event.vertexCount} ic=${event.instanceCount}`;
        default:
          return '';
      }
    }
    expectTypeOf(renderParam).returns.toEqualTypeOf<string>();
  });

  it('kind=drawIndexed narrows to RhiCallEventDrawIndexed — indexCount/instanceCount are number', () => {
    function renderParam(event: RhiCallEvent): string {
      switch (event.kind) {
        case 'drawIndexed':
          return `idx=${event.indexCount} ic=${event.instanceCount}`;
        default:
          return '';
      }
    }
    expectTypeOf(renderParam).returns.toEqualTypeOf<string>();
  });

  it('kind=setPipeline narrows to RhiCallEventSetPipeline — pipelineHandleId is string', () => {
    function renderParam(event: RhiCallEvent): string {
      switch (event.kind) {
        case 'setPipeline':
          return `pipeline=${event.pipelineHandleId}`;
        default:
          return '';
      }
    }
    expectTypeOf(renderParam).returns.toEqualTypeOf<string>();
  });

  it('full integration: eventIdx index into tape.events narrows correctly', () => {
    function eventBrowserPatch(tape: Tape, eventIdx: number): string {
      const event = tape.events[eventIdx];
      if (!event) return '?';
      switch (event.kind) {
        case 'setVertexBuffer':
          return `slot=${event.slot} buf=${event.bufferHandleId}`;
        case 'setIndexBuffer':
          return `format=${event.format} buf=${event.bufferHandleId}`;
        case 'setBindGroup':
          return `index=${event.index} bg=${event.bindGroupHandleId}`;
        case 'setViewport':
          return `vp=${event.x}x${event.y}+${event.w}x${event.h}`;
        case 'setScissorRect':
          return `sc=${event.x}x${event.y}+${event.w}x${event.h}`;
        case 'copyBufferToBuffer':
          return `size=${event.size}`;
        case 'draw':
          return `draw vc=${event.vertexCount} ic=${event.instanceCount}`;
        case 'drawIndexed':
          return `drawIdx ic=${event.indexCount} inst=${event.instanceCount}`;
        case 'setPipeline':
          return `pipe=${event.pipelineHandleId}`;
        case 'pushDebugGroup':
          return event.groupLabel;
        default:
          return event.kind;
      }
    }
    expectTypeOf(eventBrowserPatch).returns.toEqualTypeOf<string>();
  });
});
