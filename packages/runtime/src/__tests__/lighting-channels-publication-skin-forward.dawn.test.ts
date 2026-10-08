import { it } from 'vitest';
import { runChannelDawnCase } from './lighting-channels-dawn.fixture';

it('matches and replays publication skin forward channels on Dawn', {
  timeout: 300_000,
}, async () => {
  await runChannelDawnCase('publication', 'skin', 'forward');
});
