import { it } from 'vitest';
import { runChannelBrowserCase } from './lighting-channels-browser.fixture';

it('matches channels through publication with physical in both browser paths', {
  timeout: 300_000,
}, async () => {
  await runChannelBrowserCase('publication', 'physical', 'both');
});
