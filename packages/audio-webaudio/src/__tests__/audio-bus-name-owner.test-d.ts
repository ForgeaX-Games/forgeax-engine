import type { AudioState, BusName } from '@forgeax/engine-audio';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('HostAudioState bus name owner', () => {
  it('keeps the host state focused on lifecycle and error evidence', () => {
    expectTypeOf<AudioState>().toMatchTypeOf<{
      readonly contextState: 'running' | 'suspended' | 'closed';
      readonly activeSourceCount: number;
      readonly lastError: unknown;
    }>();
  });

  it('preserves the exact closed bus vocabulary', () => {
    expectTypeOf<BusName>().toEqualTypeOf<'sfx' | 'music'>();
    const acceptBusName = (busName: BusName): BusName => busName;
    expect(acceptBusName('sfx')).toBe('sfx');
    expect(acceptBusName('music')).toBe('music');
    // @ts-expect-error BusName intentionally excludes additional buses.
    acceptBusName('voice');
  });
});
