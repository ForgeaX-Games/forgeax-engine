import { it } from 'vitest';
import { assertUint4Readback } from './uint4-readback.assertions';
import { verifyUint4Readback } from './uint4-readback.fixture';

it('reads all four integer words at the selected work in a six-target pass', async ({ skip }) => {
  const result = await verifyUint4Readback();
  if (result.status === 'unavailable') return skip(result.reason);
  assertUint4Readback(result);
});
