import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 1.2 hello-triangle', () => import('../index.ts'));
