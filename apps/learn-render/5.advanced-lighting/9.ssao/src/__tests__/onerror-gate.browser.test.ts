import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 5.9 ssao', () => import('../main.ts'));
