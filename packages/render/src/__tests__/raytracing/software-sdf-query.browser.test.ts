import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifySoftwareSdfQuery } from './software-sdf-query.fixture';

it('continues only executed near misses and replays source-dependent intervals', async () => {
  await verifySoftwareSdfQuery(await commands.prepareSdfCardsFixture());
}, 120000);
