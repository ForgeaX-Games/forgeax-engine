import {
  createEngineWorkspaceRuntime,
  createEngineWorkspaceTools,
  ENGINE_WORKSPACE_STATE_TOPIC,
  ENGINE_WORKSPACE_TOOL_SOURCE,
  type EngineWorkspaceProvider,
  type EngineWorkspaceRuntime,
  snapshotEngineWorkspace,
} from '@forgeax/engine-app';
import type { Context } from '@forgeax/engine-plugin';
import type { ToolApi, ToolExecutionContext } from '@forgeax/engine-tool-runtime';
import type { DevKitHostBinding } from './host-binding.js';
import { createWorkspaceLiveTools } from './workspace-live-tools.js';
import {
  createDevKitWorkspaceProvider,
  DevKitWorkspaceError,
  type DevKitWorkspaceProviderOptions,
} from './workspace-provider.js';

export const ENGINE_WORKSPACE_CALL_SERVICE = 'engine.workspace.call';
export const ENGINE_WORKSPACE_CAPABILITIES_SERVICE = 'engine.workspace.capabilities';

export interface DevKitWorkspacePluginOptions extends DevKitWorkspaceProviderOptions {
  readonly hostBinding: DevKitHostBinding;
  readonly provider?: EngineWorkspaceProvider;
  /** Restrict this workspace adapter to observing independent runs. */
  readonly runAccess?: 'control' | 'observe';
  readonly authorize?: (input: {
    readonly operation: string;
    readonly args: unknown;
    readonly caller: ToolExecutionContext['caller'];
    readonly signal: AbortSignal;
  }) => boolean | Promise<boolean>;
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    engineWorkspace: EngineWorkspaceRuntime;
    engineWorkspaceCatalog: { notePublished(): void };
  }
}

/** Engine domain owner, independent of any product frontend or browser launcher. */
export const devKitWorkspacePlugin = {
  name: 'forgeax:devkit-workspace',
  inject: ['toolApi'],
  provide: ['engineWorkspace', 'engineWorkspaceCatalog'],
  apply(ctx: Context, options: DevKitWorkspacePluginOptions) {
    const backend = options.hostBinding.backend;
    const api = ctx.get('toolApi') as ToolApi;
    let catalogEpoch = 0;
    const publish = () =>
      backend.transport.publish(
        ENGINE_WORKSPACE_STATE_TOPIC,
        snapshotEngineWorkspace(runtime, catalogEpoch),
      );
    const notePublished = () => {
      catalogEpoch += 1;
      publish();
    };
    const runtime = createEngineWorkspaceRuntime(
      options.provider ??
        createDevKitWorkspaceProvider({
          ...options,
          onTargetChanged: () => {
            publish();
            options.onTargetChanged?.();
          },
        }),
    );
    const tools = [
      ...createEngineWorkspaceTools(runtime, publish),
      ...createWorkspaceLiveTools(),
    ].map((tool) => ({
      descriptor: tool.descriptor,
      async execute(args: unknown, context: ToolExecutionContext) {
        if (
          (tool.descriptor.id.startsWith('engine.run.') &&
            tool.descriptor.id !== 'engine.run.observe' &&
            (options.runAccess === 'observe' || context.caller?.kind === 'frontend')) ||
          (options.authorize &&
            !(await options.authorize({
              operation: tool.descriptor.id,
              args,
              caller: context.caller,
              signal: context.signal,
            })))
        ) {
          return {
            ok: false as const,
            error: {
              code: 'engine-workspace-unauthorized',
              expected: 'an authorized Engine operation',
              hint: 'Use an admitted identity with permission for this target.',
            },
          };
        }
        context.signal.throwIfAborted();
        return tool.execute(args, context);
      },
    }));
    const provider = api.registerProvider({
      providerId: `engine-workspace:${ctx.fiber.uid}`,
      sourceId: ENGINE_WORKSPACE_TOOL_SOURCE,
      realm: 'host',
      module: '@forgeax/engine-devkit',
      fiberId: String(ctx.fiber.uid),
      tools,
    });
    const capabilities = backend.transport.register(ENGINE_WORKSPACE_CAPABILITIES_SERVICE, () => ({
      apiVersion: runtime.apiVersion,
      operations: tools.map(
        ({ descriptor: { id, path, title, summary, inputSchema, outputSchema } }) => ({
          id,
          path,
          title,
          summary,
          inputSchema,
          outputSchema,
        }),
      ),
    }));
    const call = backend.transport.register(
      ENGINE_WORKSPACE_CALL_SERVICE,
      async ({ payload, caller, signal }) => {
        if (
          !payload ||
          typeof payload !== 'object' ||
          !('operation' in payload) ||
          typeof payload.operation !== 'string'
        ) {
          throw new TypeError('Engine workspace call requires an operation');
        }
        const terminal = await api.run(payload.operation, 'args' in payload ? payload.args : {}, {
          sourceId: ENGINE_WORKSPACE_TOOL_SOURCE,
          providerId: provider.owner.providerId,
          generation: provider.owner.generation,
          caller,
          signal,
        }).terminal;
        if (terminal.outcome === 'failed') {
          throw new DevKitWorkspaceError(
            terminal.failure.code,
            terminal.failure.expected,
            terminal.failure.hint,
            { failure: terminal.failure },
          );
        }
        return terminal.result;
      },
    );
    const disconnect = backend.transport.onClientDisconnect((caller) => {
      const opened = runtime.project;
      const target = opened?.target;
      if (opened && target && runtime.runtimePack)
        void runtime
          .runtimePack({
            ...opened,
            targetId: target.targetId,
            worldId: target.worldId,
            connectionId: caller.connectionId,
            request: { operation: 'release' },
          })
          .catch(() => {})
          .finally(publish);
      for (const preview of [...runtime.previews, runtime.play])
        if (preview)
          void Promise.resolve()
            .then(() =>
              preview.revokeConnection?.({
                targetId: preview.target.targetId,
                connectionId: caller.connectionId,
              }),
            )
            .catch(() => {})
            .finally(publish);
    });
    ctx.provide('engineWorkspace', runtime);
    ctx.provide('engineWorkspaceCatalog', { notePublished });
    ctx.effect(() => async () => {
      call();
      capabilities();
      disconnect();
      await provider.revoke('Engine workspace plugin disposed');
      await runtime.dispose();
    });
  },
};
