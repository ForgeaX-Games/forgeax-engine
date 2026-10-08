import { it } from 'vitest';
import { runInvalidBundleOffsetFixture, runRenderBundleFixture } from './render-bundle.fixture';

it(
  'preserves native offset slice validation on cached submissions',
  runInvalidBundleOffsetFixture,
  60_000,
);

it('reuses render bundles and preserves captured Browser pixels and dynamic offsets', async () => {
  await runRenderBundleFixture(import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 8 : 60);
}, 60_000);
