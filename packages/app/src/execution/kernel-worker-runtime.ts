import type { QuerySpan, SharedSpanBinding } from '@forgeax/engine-ecs';

interface KernelJobMessage {
  readonly kind: 'kernel-job';
  readonly moduleUrl: string;
  readonly binding: SharedSpanBinding;
  readonly control: Int32Array;
  readonly status: Int32Array;
  readonly jobIndex: number;
}

interface KernelInitMessage {
  readonly kind: 'kernel-init';
  readonly ready: Int32Array;
}

interface KernelPreloadMessage {
  readonly kind: 'kernel-preload';
  readonly moduleUrl: string;
  readonly control: Int32Array;
  readonly status: Int32Array;
  readonly jobIndex: number;
}

const scope = globalThis as unknown as {
  onmessage:
    | ((event: MessageEvent<KernelJobMessage | KernelInitMessage | KernelPreloadMessage>) => void)
    | null;
};

async function loadKernel(
  moduleUrl: string,
): Promise<{ run: (spans: readonly QuerySpan[]) => unknown }> {
  const module = await import(/* @vite-ignore */ moduleUrl);
  const candidate = (module.default ?? module) as { run?: unknown };
  if (typeof candidate.run !== 'function') {
    throw new TypeError('SharedKernel module default export has no run function.');
  }
  return candidate as { run: (spans: readonly QuerySpan[]) => unknown };
}

function spanFromBinding(binding: SharedSpanBinding): QuerySpan {
  return {
    length: binding.length,
    get(component) {
      const fields = binding.read[component.name];
      if (fields === undefined)
        throw new Error(`Kernel read access is not declared for ${component.name}.`);
      return fields as never;
    },
    mut(component) {
      const fields = binding.write[component.name];
      if (fields === undefined)
        throw new Error(`Kernel write access is not declared for ${component.name}.`);
      return fields as never;
    },
  };
}

scope.onmessage = (event): void => {
  const job = event.data;
  if (job.kind === 'kernel-init') {
    Atomics.add(job.ready, 0, 1);
    Atomics.notify(job.ready, 0);
    return;
  }
  if (job.kind === 'kernel-preload') {
    void loadKernel(job.moduleUrl)
      .then(() => {
        Atomics.store(job.status, job.jobIndex, 1);
      })
      .catch(() => {
        Atomics.store(job.status, job.jobIndex, -1);
      })
      .finally(() => {
        Atomics.add(job.control, 0, 1);
        Atomics.notify(job.control, 0);
      });
    return;
  }
  if (job.kind !== 'kernel-job') return;
  void loadKernel(job.moduleUrl)
    .then((kernel) => {
      const returned = kernel.run([spanFromBinding(job.binding)]);
      if (returned instanceof Promise) throw new TypeError('SharedKernel run must be synchronous.');
      Atomics.store(job.status, job.jobIndex, 1);
    })
    .catch(() => {
      Atomics.store(job.status, job.jobIndex, -1);
    })
    .finally(() => {
      Atomics.add(job.control, 0, 1);
      Atomics.notify(job.control, 0);
    });
};
