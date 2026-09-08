import type { ArtifactRef } from '@forgeax/engine-tool-runtime';
import { evaluateMaterialOracle, type MaterialOracleInput } from '../evidence/oracle.js';
import type { PreviewAssetRegistry, PreviewRenderRuntime } from '../host/preview-host.js';
import { canonicalPresentation, createCanonicalPreviewRecipe } from '../kit/canonical.js';
import { assetLoadFailure, type ResourcePreviewArgs, subjectFailure } from './subject.js';

export interface MaterialSubjectInspection {
  readonly subjectDigest: string;
  readonly program: string;
  readonly pass: string;
  readonly bindingsDigest: string;
  readonly closureDigest: string;
}

type InspectionResult =
  | { readonly ok: true; readonly value: MaterialSubjectInspection }
  | ReturnType<typeof subjectFailure>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function digest(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function inspectMaterialSubject(input: {
  readonly guid: string;
  readonly asset: unknown;
  readonly digest?: string;
  readonly ownerFacts?: Readonly<Record<string, string | number | boolean>>;
}): InspectionResult {
  if (!isRecord(input.asset) || input.asset.kind !== 'material') {
    return subjectFailure('resource-preview-kind-mismatch', 'a MaterialAsset with kind material', {
      phase: 'subject',
      guid: input.guid,
      actualKind:
        isRecord(input.asset) && typeof input.asset.kind === 'string'
          ? input.asset.kind
          : 'unknown',
    });
  }
  const passes = input.asset.passes;
  if (!Array.isArray(passes) || passes.length === 0) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'a MaterialAsset with at least one pass',
      {
        phase: 'subject',
        guid: input.guid,
        field: 'passes',
      },
    );
  }
  const first = passes[0];
  if (!isRecord(first) || typeof first.name !== 'string' || !isRecord(first.program)) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'every material pass to declare a program',
      {
        phase: 'subject',
        guid: input.guid,
        field: 'passes[0]',
      },
    );
  }
  if (typeof first.program.module !== 'string' || first.program.module.length === 0) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'the material program module identity to be present',
      {
        phase: 'subject',
        guid: input.guid,
        field: 'passes[0].program.module',
      },
    );
  }
  const owner = input.asset.ownerFacts;
  const ownerFacts = isRecord(owner) ? owner : input.ownerFacts;
  const subjectDigest = digest(input.asset.digest ?? input.digest ?? ownerFacts?.subjectDigest);
  const bindingsDigest = digest(input.asset.bindingsDigest ?? ownerFacts?.bindingsDigest);
  const closureDigest = digest(input.asset.closureDigest ?? ownerFacts?.closureDigest);
  if (subjectDigest === undefined || bindingsDigest === undefined || closureDigest === undefined) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'the MaterialAsset owner to publish subject, bindings, and closure digests',
      { phase: 'subject', guid: input.guid, field: 'ownerFacts' },
    );
  }
  return {
    ok: true,
    value: {
      subjectDigest,
      program: first.program.module,
      pass: first.name,
      bindingsDigest,
      closureDigest,
    },
  };
}

export async function executeMaterialPreview(
  args: ResourcePreviewArgs,
  input: {
    readonly assets?: PreviewAssetRegistry;
    readonly renderer?: PreviewRenderRuntime;
    readonly rendererReady: boolean;
    readonly worldReady: boolean;
    readonly runId: string;
    readonly artifacts?: readonly ArtifactRef[];
  },
) {
  if (input.assets === undefined)
    return subjectFailure(
      'resource-preview-subject-invalid',
      'resource preview host to expose the existing AssetRegistry',
      { phase: 'asset-registry', runId: input.runId },
    );
  const loaded = await input.assets.loadByGuid<Record<string, unknown>>(args.guid);
  if (!loaded.ok)
    return assetLoadFailure(
      'AssetRegistry.loadByGuid to resolve the requested material',
      input.runId,
      loaded.error,
    );
  const inspected = inspectMaterialSubject({
    guid: args.guid,
    asset: loaded.value,
    ...(loaded.digest === undefined ? {} : { digest: loaded.digest }),
    ...(loaded.ownerFacts === undefined ? {} : { ownerFacts: loaded.ownerFacts }),
  });
  if (!inspected.ok) return inspected;
  const renderer = input.renderer;
  if (
    !input.rendererReady ||
    !input.worldReady ||
    renderer === undefined ||
    renderer.drawCalls <= 0 ||
    renderer.nonBlackPixels <= 0 ||
    renderer.observation === undefined
  )
    return subjectFailure(
      'resource-preview-oracle-failed',
      'shared World and Renderer to be ready',
      { phase: 'renderer', runId: input.runId },
    );
  const observed: MaterialOracleInput['observed'] = {
    subjectDigest: digest(renderer.observation.subjectDigest) ?? '',
    program: digest(renderer.observation.program) ?? '',
    pass: digest(renderer.observation.pass) ?? '',
    bindingsDigest: digest(renderer.observation.bindingsDigest) ?? '',
    closureDigest: digest(renderer.observation.closureDigest) ?? '',
    rendererHealthy: input.rendererReady && input.worldReady,
    drawCalls: renderer.drawCalls,
    nonBlackPixels: renderer.nonBlackPixels,
  };
  const oracle = evaluateMaterialOracle({ requested: inspected.value, observed });
  if (oracle.status !== 'passed') {
    return subjectFailure(
      'resource-preview-oracle-failed',
      'the rendered material observation to match the loaded owner facts',
      { phase: 'oracle', runId: input.runId, ...oracle.detail },
    );
  }
  return {
    ok: true as const,
    value: {
      subject: {
        kind: 'material' as const,
        guid: args.guid,
        digest: inspected.value.subjectDigest,
      },
      presentation: canonicalPresentation('material'),
      recipe: createCanonicalPreviewRecipe('material'),
      oracle,
      artifacts: input.artifacts ?? [],
    },
    artifacts: input.artifacts ?? [],
  };
}
