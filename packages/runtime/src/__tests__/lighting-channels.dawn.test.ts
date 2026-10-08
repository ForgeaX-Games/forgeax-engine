import { it } from 'vitest';
import type { ChannelReceiver } from './lighting-channels.fixture';
import { runChannelDawnCase } from './lighting-channels-dawn.fixture';

it.each(
  (['world', 'publication'] as const).flatMap((mode) =>
    (['sections', 'instances', 'transparent', 'physical'] as ChannelReceiver[]).map((receiver) => ({
      mode,
      receiver,
    })),
  ),
)('matches surface lighting channels through $mode with $receiver on Dawn', {
  timeout: 300_000,
}, async ({ mode, receiver }) => {
  await runChannelDawnCase(mode, receiver, 'both');
});
