import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 6.2 ibl-irradiance', () => import('../index.ts'));
