import { it } from 'vitest';
import { verifyRasterPassLabels } from './raster-pass-label.fixture';

it('retains raster labels and pixels through actual capture and fresh replay', async () => {
  await verifyRasterPassLabels();
});
