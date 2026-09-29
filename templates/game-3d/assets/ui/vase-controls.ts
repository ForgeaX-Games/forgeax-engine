import { VASE_CHANNEL, VASE_PARAMETERS, type VaseState } from '../runtime-vase/vase-program.ts';

/** The Host owns DOM; the Engine owns generation. Both borrow GameHost.port. */
export function installVaseControls(root: ShadowRoot, port: MessagePort): () => void {
  const form = root.querySelector<HTMLFormElement>('[data-ui-part="vase-controls"]');
  const status = root.querySelector<HTMLElement>('[data-ui-part="vase-status"]');
  const button = form?.querySelector<HTMLButtonElement>('button');
  if (!form || !status || !button) throw new Error('Runtime vase UI is incomplete');
  const controls = VASE_PARAMETERS.map((parameter) => {
    const label = document.createElement('label');
    label.textContent = parameter.name[0]!.toUpperCase() + parameter.name.slice(1);
    const input = document.createElement('input');
    input.name = parameter.name;
    input.type = 'number';
    input.min = String(parameter.minimum);
    input.max = String(parameter.maximum);
    input.step = parameter.type === 'u32' ? '1' : '0.05';
    input.value = String(parameter.default);
    input.required = true;
    label.append(input);
    form.insertBefore(label, button);
    return input;
  });
  const receive = (event: MessageEvent) => {
    if (event.data?.channel !== VASE_CHANNEL || event.data.kind !== 'state') return;
    const state: VaseState = event.data.state;
    button.disabled = state.busy;
    for (const input of controls) {
      input.disabled = state.busy;
      if (!state.busy && !state.error) input.value = String(state.values[input.name as keyof typeof state.values]);
    }
    status.textContent = state.busy ? 'Generating...' : state.error
      ? 'Could not generate. Previous vase kept; check the values and retry.'
      : `${state.vertexCount ?? 0} vertices · Generated in game`;
    status.dataset.state = state.busy ? 'busy' : state.error ? 'error' : 'ready';
  };
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (button.disabled || !form.reportValidity()) return;
    button.disabled = true;
    port.postMessage({ channel: VASE_CHANNEL, kind: 'generate',
      values: Object.fromEntries(controls.map((input) => [input.name, input.valueAsNumber])),
    });
  };
  form.addEventListener('submit', submit);
  port.addEventListener('message', receive);
  port.start();
  port.postMessage({ channel: VASE_CHANNEL, kind: 'inspect' });
  return () => {
    form.removeEventListener('submit', submit);
    port.removeEventListener('message', receive);
    for (const input of controls) input.parentElement?.remove();
  };
}
