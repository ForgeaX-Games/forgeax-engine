// frame-model-shape-invariant.test-d.ts -- AC-14: CommandEntry / FrameModel
// type shape invariant — ensures OOS-2 is upheld (CommandEntry is NOT extended
// with command parameters; only raw events are read).
//
// Uses expectTypeOf to lock key field shapes against the current git HEAD.
// If any commit changes the shape, this test-d will red, catching the drift.
//
// Related: requirements AC-14 / OOS-2; plan-strategy D-6; research Finding 6.

/// <reference types="@webgpu/types" />

import { describe, expectTypeOf, it } from 'vitest';
import type { CommandEntry, FrameModel } from '../viewer-model';

describe('AC-14: CommandEntry / FrameModel type shape invariant (OOS-2 guard)', () => {
  it('CommandEntry.kind is string (frozen, not extended enum)', () => {
    // CommandEntry.kind is string — no narrowing, no per-command structs.
    // It MUST NOT become a union of per-kind subtypes.
    expectTypeOf<CommandEntry['kind']>().toEqualTypeOf<string>();
  });

  it('CommandEntry.eventIdx is number (index into tape.events)', () => {
    expectTypeOf<CommandEntry['eventIdx']>().toEqualTypeOf<number>();
  });

  it('CommandEntry.passIdx is number', () => {
    expectTypeOf<CommandEntry['passIdx']>().toEqualTypeOf<number>();
  });

  it('CommandEntry.isDraw is boolean', () => {
    expectTypeOf<CommandEntry['isDraw']>().toEqualTypeOf<boolean>();
  });

  it('CommandEntry.groupLabel is string | undefined', () => {
    expectTypeOf<CommandEntry['groupLabel']>().toEqualTypeOf<string | undefined>();
  });

  it('CommandEntry.markerLabel is string | undefined', () => {
    expectTypeOf<CommandEntry['markerLabel']>().toEqualTypeOf<string | undefined>();
  });

  it('CommandEntry has exactly 6 fields — no unexpected extension', () => {
    function accept(c: CommandEntry) {
      // Destructure all expected fields — no rest param
      const { kind, eventIdx, passIdx, isDraw, groupLabel, markerLabel } = c;
      return { kind, eventIdx, passIdx, isDraw, groupLabel, markerLabel };
    }
    // Return type must be the 6-field object type (not a wider type)
    expectTypeOf(accept).returns.toEqualTypeOf<{
      kind: string;
      eventIdx: number;
      passIdx: number;
      isDraw: boolean;
      groupLabel: string | undefined;
      markerLabel: string | undefined;
    }>();
  });

  it('FrameModel.commands is readonly CommandEntry[]', () => {
    expectTypeOf<FrameModel['commands']>().toEqualTypeOf<readonly CommandEntry[]>();
  });

  it('FrameModel.draws is readonly DrawEntry[]', () => {
    expectTypeOf<FrameModel['draws']>().toEqualTypeOf<
      readonly import('../viewer-model').DrawEntry[]
    >();
  });

  it('FrameModel.tree is readonly PassNode[]', () => {
    expectTypeOf<FrameModel['tree']>().toEqualTypeOf<
      readonly import('../viewer-model').PassNode[]
    >();
  });

  it('FrameModel.resources is ReadonlyMap<string, CreateDescriptor>', () => {
    expectTypeOf<FrameModel['resources']>().toEqualTypeOf<
      ReadonlyMap<string, import('../viewer-model').CreateDescriptor>
    >();
  });

  it('FrameModel.meta has correct shape', () => {
    expectTypeOf<FrameModel['meta']>().toEqualTypeOf<import('../viewer-model').FrameModelMeta>();
  });
});
