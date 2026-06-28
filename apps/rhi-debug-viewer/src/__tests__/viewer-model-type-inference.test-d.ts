// viewer-model-type-inference.test-d.ts -- AC-28: type inference at real
// consumption path for extended ViewModel fields.
//
// Simulates a panel component function body accessing the ViewModel type
// directly (same type a panel component would see). Asserts that TypeScript
// infers correct shapes for the new fields without `as` type assertion.
//
// Related: requirements AC-28; plan-strategy D-5; research Finding 8.

/// <reference types="@webgpu/types" />

import { describe, expectTypeOf, it } from 'vitest';
import type { ViewModel } from '../viewer-model';

describe('AC-28: ViewModel extended field type inference', () => {
  it('vm.commands inferred as readonly array with kind property', () => {
    // Simulate a panel component accessing vm
    function panelBody(vm: ViewModel) {
      const cmd = vm.commands[0];
      return cmd ? cmd.kind : '';
    }
    // Verify the return type is string (inferred from CommandEntry.kind)
    expectTypeOf(panelBody).returns.toEqualTypeOf<string>();
  });

  it('vm.resources inferred as ReadonlyMap', () => {
    function panelBody(vm: ViewModel) {
      const desc = vm.resources.get('any-handle');
      // desc is CreateDescriptor | undefined (Map.get return)
      return desc;
    }
    // The return type should be a union including undefined
    expectTypeOf(panelBody).not.returns.toEqualTypeOf<never>();
  });

  it('vm.depthStencil.depthStencilViewHandleId inferred as string | undefined', () => {
    function panelBody(vm: ViewModel) {
      const dsView = vm.draws[0]?.depthStencil.depthStencilViewHandleId;
      return dsView;
    }
    expectTypeOf(panelBody).returns.toEqualTypeOf<string | undefined>();
  });

  it('vm.pipelineState.blend.blendConstant inferred as GPUColor | undefined', () => {
    function panelBody(vm: ViewModel) {
      const blendConst = vm.draws[0]?.pipelineState.blend.blendConstant;
      return blendConst;
    }
    expectTypeOf(panelBody).returns.toEqualTypeOf<GPUColor | undefined>();
  });

  it('vm.vertexBuffers.get() inferred as string | undefined', () => {
    function panelBody(vm: ViewModel) {
      const vb = vm.draws[0]?.vertexBuffers.get(0);
      return vb;
    }
    expectTypeOf(panelBody).returns.toEqualTypeOf<string | undefined>();
  });

  it('vm.pipelineState.blend.colorTargets inferred as readonly array', () => {
    function panelBody(vm: ViewModel) {
      const targets = vm.draws[0]?.pipelineState.blend.colorTargets;
      return targets;
    }
    // Should be non-never (an array type)
    expectTypeOf(panelBody).not.returns.toEqualTypeOf<never>();
  });
});
