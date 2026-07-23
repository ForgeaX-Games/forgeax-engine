import { Update } from '@forgeax/engine-ecs';
import { isEndpointError } from '@forgeax/engine-net';
import { createClient } from './client';

function endpointUrl(): string {
  const requested = new URLSearchParams(window.location.search).get('server');
  if (requested !== null) return requested;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.hostname}:8787`;
}

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#app');
  const state = document.querySelector<HTMLOutputElement>('[data-testid="snake-state"]');
  if (canvas === null || state === null) return;

  try {
    const client = await createClient(canvas, endpointUrl());
    const ready = await client.renderer.ready;
    if (!ready.ok) throw ready.error;

    client.world
      .addSystem(Update, {
        name: 'snake-client-observability',
        queries: [],
        fn: () => {
          state.dataset.directionCommandSendCount = String(
            client.directionCommandEvidence.directionCommandSendCount,
          );
          state.dataset.renderableTotal = String(client.renderer.frustumStats.total);
          state.dataset.renderableCulled = String(client.renderer.frustumStats.culled);
        },
      })
      .unwrap();

    client.app.onError((error) => {
      state.textContent = `${error.code}: ${error.hint}`;
    });
    const started = client.app.start();
    if (!started.ok) throw started.error;
  } catch (error) {
    if (isEndpointError(error)) {
      state.textContent = `${error.code}: ${error.hint} (${JSON.stringify(error.detail)})`;
    } else {
      state.textContent = error instanceof Error ? error.message : String(error);
    }
  }
}

void main();
