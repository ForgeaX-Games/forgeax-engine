import { createToolPreviewRecipe } from '@forgeax/engine-app';
import { Context } from '@forgeax/engine-plugin';
import {
  createContextCapabilityResolver,
  installCatalogLoader,
  projectPluginEntries,
} from '@forgeax/engine-plugin/loader';
import { createNativePreviewHost, RESOURCE_PREVIEW_DEFAULT_SIZE } from '@forgeax/engine-preview';
import {
  createToolRuntime,
  type ToolContribution,
  type ToolRunOptions,
  type ToolTerminal,
} from '@forgeax/engine-tool-runtime';
import {
  publishPreviewArtifacts,
  type ResourcePreviewReportInput,
  runBrowserResourcePreviewHost,
} from './browser-host.js';
import {
  createNativePreviewCatalog,
  nativePreviewPlugins,
  nativePreviewTools,
} from './preview-catalog.js';

const previewPluginEntries = nativePreviewPlugins.map(([name]) => ({
  id: `forgeax-preview-${name.slice(name.lastIndexOf('/') + 1)}`,
  name,
  realm: 'host' as const,
}));
const previewToolIds = new Set(nativePreviewTools.map(({ descriptor }) => descriptor.id));

export function isNativePreviewTool(id: string): boolean {
  return previewToolIds.has(id);
}

export async function runNativePreviewTool(
  contribution: ToolContribution<unknown, unknown>,
  args: unknown,
  options: ToolRunOptions,
  projectRoot: string,
): Promise<ToolTerminal<unknown>> {
  const kind = contribution.descriptor.id.split('.')[0];
  if (kind !== 'material' && kind !== 'mesh' && kind !== 'texture' && kind !== 'vfx') {
    throw new Error(`unsupported native preview operation ${contribution.descriptor.id}`);
  }
  const parsed = contribution.descriptor.argsSchema.parse(args);
  if (!parsed.ok) {
    return {
      outcome: 'failed',
      failure: {
        code: 'tool-invalid-args',
        expected: 'preview arguments to match the operation argsSchema',
        hint: 'Pass { guid } and an optional power-of-two size from AssetRegistry catalog identity.',
        detail: { message: parsed.error, value: null },
      },
      artifacts: [],
    };
  }
  const request = parsed.value as { readonly guid: string; readonly size?: number };
  const { guid, size = RESOURCE_PREVIEW_DEFAULT_SIZE } = request;
  const selectedPreviewPlugin = nativePreviewPlugins.find(([, plugin]) =>
    plugin.tools.some(({ descriptor }) => descriptor.id === contribution.descriptor.id),
  );
  if (selectedPreviewPlugin === undefined) {
    throw new Error(`native preview plugin does not export ${contribution.descriptor.id}`);
  }
  const selectedPluginName = selectedPreviewPlugin[0];
  const snapshot = options.snapshot ?? { revision: 0, digest: `sha256:project:${projectRoot}` };
  const previewRunId = `${contribution.descriptor.id}:${crypto.randomUUID()}`;
  const browser = await runBrowserResourcePreviewHost(
    projectRoot,
    createToolPreviewRecipe({
      presentation: 'hidden',
      viewport: { width: size, height: size },
      frames: 32,
    }),
    snapshot,
    previewRunId,
    options.signal ?? new AbortController().signal,
    { kind, guid, size },
    { publish: false },
  );
  if (!browser.ok || browser.value.resource === undefined) {
    const failure = browser.ok
      ? {
          code: 'tool-preview-bootstrap-failed',
          expected: 'the Browser resource bootstrap to return AssetRegistry owner facts',
          hint: 'Inspect resource-bootstrap and retry after the owner publishes the GUID payload.',
          detail: { phase: 'resource-owner' },
        }
      : browser.error;
    return {
      outcome: 'failed',
      failure: {
        code: 'tool-domain-failed',
        expected: failure.expected ?? 'the Browser resource bootstrap to succeed',
        hint: failure.hint ?? 'Inspect the Browser resource bootstrap failure and retry.',
        detail: {
          code: failure.code,
          ...(failure.detail === undefined ? {} : { payload: failure.detail }),
        },
      },
      artifacts: [],
    };
  }
  const resource = browser.value.resource;
  const ctx = new Context();
  try {
    const host = createNativePreviewHost({
      runId: `${contribution.descriptor.id}:native`,
      snapshot,
      projectRoot,
      backend: 'webgpu',
      signal: options.signal ?? new AbortController().signal,
      assets: {
        loadByGuid: async <TAsset>() => ({
          ok: true as const,
          value: resource.asset as TAsset,
          ...(resource.digest === undefined ? {} : { digest: resource.digest }),
          ...(resource.ownerFacts === undefined ? {} : { ownerFacts: resource.ownerFacts }),
        }),
      },
      renderer: {
        rendererReady: browser.value.trace.events.includes('renderer-created'),
        worldReady: browser.value.trace.events.includes('world-updated'),
        drawCalls: browser.value.drawCalls,
        nonBlackPixels: browser.value.nonBlackPixels,
        ...(resource.observation === undefined
          ? resource.ownerFacts === undefined
            ? {}
            : { observation: resource.ownerFacts }
          : { observation: resource.observation }),
        ...(kind === 'vfx' && resource.observation !== undefined
          ? {
              vfx: {
                dispatches:
                  typeof resource.observation.dispatches === 'number'
                    ? resource.observation.dispatches
                    : 0,
                indirectDraws:
                  typeof resource.observation.indirectDraws === 'number'
                    ? resource.observation.indirectDraws
                    : 0,
                subjectOutputs:
                  typeof resource.observation.subjectOutputs === 'number'
                    ? resource.observation.subjectOutputs
                    : 0,
              },
            }
          : {}),
        texture: { drawCalls: browser.value.drawCalls },
      },
      artifacts: browser.value.artifacts,
    });
    const { loader } = await installCatalogLoader(
      ctx,
      createNativePreviewCatalog(host, selectedPluginName),
      'host',
    );
    await loader.root.update(
      projectPluginEntries(
        previewPluginEntries.filter(({ name }) => name === selectedPluginName),
        'host',
        'host',
      ),
    );
    await loader.await();
    const nativeContribution = nativePreviewTools.find(
      (candidate) => candidate.descriptor.id === contribution.descriptor.id,
    );
    if (nativeContribution === undefined) {
      throw new Error(`native preview plugin does not export ${contribution.descriptor.id}`);
    }
    const terminal = await createToolRuntime([nativeContribution]).run(nativeContribution, args, {
      ...options,
      snapshot,
      capabilityResolver: createContextCapabilityResolver(ctx),
    }).terminal;
    if (terminal.outcome !== 'succeeded') return terminal;
    const domainResult = terminal.result as {
      readonly subject: ResourcePreviewReportInput['subject'];
      readonly presentation: ResourcePreviewReportInput['presentation'];
      readonly oracle: ResourcePreviewReportInput['oracle'];
    };
    let published: Awaited<ReturnType<typeof publishPreviewArtifacts>>;
    try {
      published = await publishPreviewArtifacts(projectRoot, previewRunId, browser.value, {
        snapshot,
        subject: domainResult.subject,
        presentation: domainResult.presentation,
        oracle: domainResult.oracle,
      });
    } catch (cause) {
      return {
        outcome: 'failed',
        failure: {
          code: 'tool-domain-failed',
          expected: 'the preview report and all capture artifacts to publish atomically',
          hint: 'Inspect the artifact manifest identity or digest failure and retry the same ToolRun.',
          detail: {
            code: 'tool-artifact-manifest-invalid',
            payload: cause instanceof Error ? cause.message : String(cause),
          },
        },
        artifacts: [],
      };
    }
    const report = published.manifest.artifacts.find((artifact) => artifact.role === 'report');
    if (report === undefined) {
      throw new Error('resource preview publisher returned no report artifact');
    }
    return {
      ...terminal,
      result: {
        ...(terminal.result as Record<string, unknown>),
        actualCarrier: browser.value.actualCarrier,
        report: {
          kind: 'tool-result' as const,
          digest: report.digest,
          uri: report.uri,
          mediaType: report.mediaType,
          sizeBytes: report.byteLength,
        },
        artifacts: published.artifacts,
      },
      artifacts: published.artifacts,
    };
  } finally {
    await ctx.fiber.dispose();
  }
}
