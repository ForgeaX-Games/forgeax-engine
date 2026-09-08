import { expectTypeOf } from 'vitest';
import { csmOverlayModeForKey, type CsmOverlayMode } from '../cascade-overlay.js';

type ExpectedMode = 'off' | 'all' | 'c1' | 'c2' | 'c3' | 'c4';

expectTypeOf<CsmOverlayMode>().toEqualTypeOf<ExpectedMode>();
expectTypeOf<'c5'>().not.toExtend<CsmOverlayMode>();
expectTypeOf(csmOverlayModeForKey).parameter(0).toEqualTypeOf<string>();
expectTypeOf(csmOverlayModeForKey).returns.toEqualTypeOf<CsmOverlayMode | null>();
