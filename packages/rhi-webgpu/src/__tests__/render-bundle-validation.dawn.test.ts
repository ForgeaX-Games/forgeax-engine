import { it } from 'vitest';
import { runRenderBundleValidation } from './render-bundle-validation.fixture';

it(
  'validates reusable bundles, attachment compatibility, destroyed resources and pass-state reset on Dawn',
  runRenderBundleValidation,
  60_000,
);
