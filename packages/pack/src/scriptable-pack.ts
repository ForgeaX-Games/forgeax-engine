import type { Asset, AssetGuid, AssetPublicationEnvelope, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { AssetGuid as AssetGuidCodec } from './guid.js';

/** Closed ordinary kind vocabulary shared by authoring, producers, and loaders. */
export type ScriptablePackAssetKind = Asset['kind'];

/** Complete ordinary Asset kind vocabulary exposed by ScriptablePack discovery. */
export const SCRIPTABLE_PACK_ASSET_KINDS = [
  'mesh',
  'material',
  'scene',
  'texture',
  'equirect',
  'sampler',
  'font',
  'render-pipeline',
  'tileset',
  'video',
  'skeleton',
  'skin',
  'animation-clip',
  'animation-graph',
  'audio',
  'particle-effect',
] as const satisfies readonly ScriptablePackAssetKind[];

/** Machine-readable producer/loader floor owned by engine-pack. */
export const SCRIPTABLE_PACK_CAPABILITY_MANIFEST = {
  assetKinds: SCRIPTABLE_PACK_ASSET_KINDS,
  durablePayload: true,
  refs: true,
  artifacts: true,
  hostCapabilities: ['audio-install', 'video-play', 'particle-execute'] as const,
} as const;

export function isScriptablePackAssetKind(value: string): value is ScriptablePackAssetKind {
  return (SCRIPTABLE_PACK_ASSET_KINDS as readonly string[]).includes(value);
}

export interface ScriptablePackAssetDeclaration<
  TKind extends ScriptablePackAssetKind = ScriptablePackAssetKind,
> {
  readonly guid: AssetGuid;
  readonly kind: TKind;
  readonly name?: string;
}

export type ScriptablePackAssetDeclarations = Readonly<
  Record<string, ScriptablePackAssetDeclaration>
>;

export type ScriptablePackExternalAssets = Readonly<Record<string, AssetGuid>>;

/**
 * Component-shaped input accepted by a ScriptablePack scene declaration.
 * Engine component tokens satisfy this shape; plain `{ type }` rows keep the
 * Pack contract independent of ECS and survive the isolated module worker.
 */
export interface ScriptablePackSceneComponentInput {
  readonly name: string;
  readonly fields: Readonly<Record<string, string | { readonly type: string }>>;
}

/** Neutral scene schema projection owned by the Pack definition. */
export interface ScriptablePackSceneComponent {
  readonly name: string;
  readonly fields: Readonly<Record<string, string>>;
}

function sceneComponentFieldType(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.type === 'string') return value.type;
  return undefined;
}

/** Derive the frozen, ECS-neutral schema used by scene output producers. */
export function projectScriptablePackSceneComponents(
  components: readonly ScriptablePackSceneComponentInput[] | undefined,
): readonly ScriptablePackSceneComponent[] {
  return (components ?? []).map((component) => ({
    name: component.name,
    fields: Object.fromEntries(
      Object.entries(component.fields).map(([fieldName, field]) => [
        fieldName,
        sceneComponentFieldType(field) as string,
      ]),
    ),
  }));
}

/** Pack-facing name for the shared Engine publication envelope. */
export type ScriptablePackPublicationEnvelope = AssetPublicationEnvelope;

/** Structured domain failure permitted to cross the isolated build-time AssetReader seam. */
export interface ScriptablePackErrorProvenance {
  /** Published source generation observed by the reader, when available. */
  readonly generation?: number;
  /** Stable producer identity for the failed output, when available. */
  readonly sourceKey?: string;
  /** GUID associated with the failed read or output, when available. */
  readonly guid?: string;
}

export interface ScriptablePackReadError {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
  readonly provenance?: ScriptablePackErrorProvenance;
}

export type ScriptablePackAssetFor<TDescriptor extends ScriptablePackAssetDeclaration> =
  TDescriptor extends { readonly kind: infer TKind extends ScriptablePackAssetKind }
    ? Extract<Asset, { readonly kind: TKind }>
    : never;

export type ScriptablePackOutputs<TAssets extends ScriptablePackAssetDeclarations> = {
  readonly [TKey in keyof TAssets]: TAssets[TKey] extends ScriptablePackAssetDeclaration
    ? ScriptablePackAssetFor<TAssets[TKey]>
    : never;
};

export interface AssetReader {
  /** Load a declared GUID as a durable payload; this never mints a World handle. */
  readByGuid<TAsset extends Asset = Asset>(
    guid: AssetGuid,
  ): Promise<Result<TAsset, ScriptablePackReadError>>;
}

export type ScriptablePackBuildResult<
  TAssets extends ScriptablePackAssetDeclarations,
  TError,
> = Result<ScriptablePackOutputs<TAssets>, TError>;

export interface ScriptablePackDefinition<
  TAssets extends ScriptablePackAssetDeclarations = ScriptablePackAssetDeclarations,
  TExternal extends ScriptablePackExternalAssets = ScriptablePackExternalAssets,
  TError = ScriptablePackReadError,
> {
  readonly schemaVersion: '1.0.0';
  readonly packageId: AssetGuid;
  readonly name?: string;
  readonly assets: TAssets;
  /** Component tokens/schema rows used by scene ref externalization. */
  readonly sceneComponents?: readonly ScriptablePackSceneComponentInput[];
  readonly externalAssets: TExternal;
  readonly build: (
    assetReader: AssetReader,
  ) =>
    | ScriptablePackBuildResult<TAssets, TError>
    | Promise<ScriptablePackBuildResult<TAssets, TError>>;
}

export interface ScriptablePackSourceClosureEntry {
  readonly path: string;
  readonly digest: string;
}

export interface ScriptablePackMetaJson {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'external-asset-package';
  readonly packageId: string;
  readonly name?: string;
  readonly importer: 'pack-ts';
  readonly source: string;
  readonly importSettings: {
    readonly contractVersion: '1.0.0';
    readonly externalAssets: readonly {
      readonly alias: string;
      readonly guid: string;
    }[];
  };
  readonly subAssets: readonly {
    readonly guid: string;
    readonly sourceIndex: number;
    readonly sourceKey: string;
    readonly kind: ScriptablePackAssetKind;
    readonly name?: string;
  }[];
}

export interface ScriptablePackOperationEnvelope {
  readonly requestId: string;
  readonly expectedRevision?: string;
}

export type ScriptablePackGatewayOperation =
  | (ScriptablePackOperationEnvelope & {
      readonly kind: 'preflight';
      readonly sourcePath: string;
    })
  | (ScriptablePackOperationEnvelope & {
      readonly kind: 'create-scriptable-pack';
      readonly sourcePath: string;
      readonly name?: string;
      readonly initialOutput: {
        readonly sourceKey: string;
        readonly kind: ScriptablePackAssetKind;
        readonly name?: string;
      };
    })
  | (ScriptablePackOperationEnvelope & {
      readonly kind: 'add-output';
      readonly sourcePath: string;
      readonly sourceKey: string;
      readonly assetKind: ScriptablePackAssetKind;
      readonly name?: string;
    })
  | (ScriptablePackOperationEnvelope & {
      readonly kind: 'add-external-asset';
      readonly sourcePath: string;
      readonly alias: string;
      readonly guid: AssetGuid;
    })
  | (ScriptablePackOperationEnvelope & {
      readonly kind: 'rename-display';
      readonly sourcePath: string;
      readonly target:
        | { readonly kind: 'package' }
        | { readonly kind: 'output'; readonly sourceKey: string };
      readonly name: string;
    })
  | (ScriptablePackOperationEnvelope & {
      readonly kind: 'remove-output';
      readonly sourcePath: string;
      readonly sourceKey: string;
      /** Exact incoming reference identities acknowledged by the caller. */
      readonly confirmIncomingRefs?: readonly string[];
    })
  | (ScriptablePackOperationEnvelope & {
      readonly kind: 'clone-scriptable-pack';
      readonly sourcePath: string;
      readonly targetPath: string;
    })
  | (ScriptablePackOperationEnvelope & {
      readonly kind: 'inspect-meta';
      readonly sourcePath: string;
    })
  | (ScriptablePackOperationEnvelope & {
      readonly kind: 'rebuild' | 'cold-cook';
      readonly sourcePath: string;
    });

export interface ScriptablePackMutationCapabilities {
  readonly inspect: true;
  readonly rebuild: true;
  readonly coldCook: true;
  readonly create?: true;
  readonly addOutput?: true;
  readonly addExternalAsset?: true;
  readonly renameDisplay?: true;
  readonly removeOutput?: true;
  readonly clone?: true;
  readonly reason?: string;
}

export interface ScriptablePackPreflight {
  readonly sourcePath: string;
  readonly revision: string;
  readonly meta: ScriptablePackMetaJson;
  readonly capabilities: ScriptablePackMutationCapabilities;
  readonly incomingRefs: readonly string[];
}

export interface ScriptablePackGatewayMutation {
  readonly sourcePath: string;
  readonly revision: string;
  readonly meta: ScriptablePackMetaJson;
}

export interface ScriptablePackAuthoringGateway {
  execute(
    operation: ScriptablePackGatewayOperation,
  ): Promise<Result<ScriptablePackGatewayMutation | ScriptablePackPreflight, ScriptablePackError>>;
}

export type ScriptablePackAuthoringMutation =
  | (ScriptablePackOperationEnvelope & {
      readonly kind: 'create-scriptable-pack';
      readonly sourcePath: string;
      readonly packageId: AssetGuid;
      readonly name?: string;
      readonly initialOutput: {
        readonly sourceKey: string;
        readonly kind: ScriptablePackAssetKind;
        readonly guid: AssetGuid;
        readonly name?: string;
      };
    })
  | (ScriptablePackOperationEnvelope & {
      readonly kind: 'add-output';
      readonly sourcePath: string;
      readonly sourceKey: string;
      readonly assetKind: ScriptablePackAssetKind;
      readonly guid: AssetGuid;
      readonly name?: string;
    })
  | Extract<
      ScriptablePackGatewayOperation,
      { readonly kind: 'add-external-asset' | 'rename-display' | 'remove-output' }
    >
  | (ScriptablePackOperationEnvelope & {
      readonly kind: 'clone-scriptable-pack';
      readonly sourcePath: string;
      readonly targetPath: string;
      readonly packageId: AssetGuid;
      readonly outputGuids: Readonly<Record<string, AssetGuid>>;
    });

export interface ScriptablePackAuthoringPort {
  preflight(
    sourcePath: string,
  ): Promise<Result<Omit<ScriptablePackPreflight, 'sourcePath'>, ScriptablePackError>>;
  mutate(
    operation: ScriptablePackAuthoringMutation,
  ): Promise<
    Result<{ readonly sourcePath: string; readonly revision: string }, ScriptablePackError>
  >;
  inspect(
    sourcePath: string,
  ): Promise<
    Result<
      { readonly revision: string; readonly meta: ScriptablePackMetaJson },
      ScriptablePackError
    >
  >;
  rebuild(
    sourcePath: string,
    mode: 'rebuild' | 'cold-cook',
  ): Promise<
    Result<
      { readonly revision: string; readonly meta: ScriptablePackMetaJson },
      ScriptablePackError
    >
  >;
}

/** Keep GUID allocation and multi-identity operations in one auditable gateway transaction. */
export function createScriptablePackAuthoringGateway(
  port: ScriptablePackAuthoringPort,
  allocateGuid: () => AssetGuid = AssetGuidCodec.random,
): ScriptablePackAuthoringGateway {
  const requests = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly result: Promise<
        Result<ScriptablePackGatewayMutation | ScriptablePackPreflight, ScriptablePackError>
      >;
    }
  >();

  async function mutationResult(
    result: Awaited<ReturnType<ScriptablePackAuthoringPort['mutate']>>,
  ): Promise<Result<ScriptablePackGatewayMutation, ScriptablePackError>> {
    if (!result.ok) return result;
    const inspected = await port.inspect(result.value.sourcePath);
    if (!inspected.ok) return inspected;
    return ok({
      sourcePath: result.value.sourcePath,
      revision: inspected.value.revision,
      meta: inspected.value.meta,
    });
  }

  async function dispatch(
    operation: ScriptablePackGatewayOperation,
  ): Promise<Result<ScriptablePackGatewayMutation | ScriptablePackPreflight, ScriptablePackError>> {
    switch (operation.kind) {
      case 'preflight': {
        const preflight = await port.preflight(operation.sourcePath);
        return preflight.ok
          ? ok({ sourcePath: operation.sourcePath, ...preflight.value })
          : preflight;
      }
      case 'inspect-meta': {
        const inspected = await port.inspect(operation.sourcePath);
        return inspected.ok
          ? ok({ sourcePath: operation.sourcePath, ...inspected.value })
          : inspected;
      }
      case 'rebuild':
      case 'cold-cook': {
        const preflight = await port.preflight(operation.sourcePath);
        if (!preflight.ok) return preflight;
        if (
          operation.expectedRevision !== undefined &&
          operation.expectedRevision !== preflight.value.revision
        ) {
          return err({
            code: 'pack-source-revision-conflict',
            expected: operation.expectedRevision,
            actual: preflight.value.revision,
            hint: 'inspect the current source revision, then retry the build with a new requestId',
            retryable: true,
            recoveryActions: ['asset.preflight', 'mint-request-id'],
            detail: { requestId: operation.requestId, sourcePath: operation.sourcePath },
          });
        }
        const rebuilt = await port.rebuild(operation.sourcePath, operation.kind);
        return rebuilt.ok ? ok({ sourcePath: operation.sourcePath, ...rebuilt.value }) : rebuilt;
      }
      case 'create-scriptable-pack':
        return mutationResult(
          await port.mutate({
            ...operation,
            packageId: allocateGuid(),
            initialOutput: { ...operation.initialOutput, guid: allocateGuid() },
          }),
        );
      case 'add-output':
        return mutationResult(await port.mutate({ ...operation, guid: allocateGuid() }));
      case 'clone-scriptable-pack': {
        const inspected = await port.inspect(operation.sourcePath);
        if (!inspected.ok) return inspected;
        const outputGuids = Object.fromEntries(
          inspected.value.meta.subAssets.map((asset) => [asset.sourceKey, allocateGuid()]),
        );
        return mutationResult(
          await port.mutate({
            ...operation,
            packageId: allocateGuid(),
            outputGuids,
          }),
        );
      }
      case 'add-external-asset':
      case 'rename-display':
      case 'remove-output':
        return mutationResult(await port.mutate(operation));
    }
  }

  return {
    execute(operation) {
      if (operation.requestId.trim().length === 0) {
        return Promise.resolve(
          err({
            code: 'pack-source-operation-committed',
            expected: 'a non-empty caller-minted requestId',
            actual: operation.requestId,
            hint: 'mint a new requestId and retry the operation once',
            retryable: true,
            recoveryActions: ['mint-request-id'],
            detail: { requestId: operation.requestId, sourcePath: operation.sourcePath },
          }),
        );
      }
      const fingerprint = JSON.stringify(operation);
      const prior = requests.get(operation.requestId);
      if (prior !== undefined) {
        if (prior.fingerprint === fingerprint) return prior.result;
        return Promise.resolve(
          err({
            code: 'pack-source-operation-committed',
            expected: 'one immutable operation per requestId',
            actual: operation.kind,
            hint: 'read the original operation result or mint a new requestId',
            retryable: false,
            recoveryActions: ['read-operation-run', 'mint-request-id'],
            detail: { requestId: operation.requestId, sourcePath: operation.sourcePath },
          }),
        );
      }
      const result = dispatch(operation);
      requests.set(operation.requestId, { fingerprint, result });
      return result;
    },
  };
}

const SCRIPTABLE_PACK_REQUEST_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
  description: 'Caller-minted identity for one idempotent ScriptablePack operation.',
} as const;
const SCRIPTABLE_PACK_SOURCE_PATH_SCHEMA = {
  type: 'string',
  minLength: 8,
  pattern: '^[^/].*\\.pack\\.ts$',
  description: 'Game-root-relative ScriptablePack source path.',
} as const;
const SCRIPTABLE_PACK_OWNER_GUID_SCHEMA = {
  type: 'string',
  format: 'uuid',
  description: 'Catalog GUID used to resolve the producer-owned source subject.',
} as const;
const SCRIPTABLE_PACK_REVISION_SCHEMA = {
  type: 'string',
  minLength: 64,
  maxLength: 64,
  pattern: '^[a-f0-9]{64}$',
  description: 'SHA-256 source revision returned by preflight.',
} as const;
const SCRIPTABLE_PACK_SOURCE_KEY_SCHEMA = { type: 'string', minLength: 1 } as const;
const SCRIPTABLE_PACK_ASSET_KIND_SCHEMA = {
  enum: SCRIPTABLE_PACK_ASSET_KINDS,
  description: 'Ordinary Asset kind supported by the ScriptablePack producer/loader matrix.',
} as const;
const SCRIPTABLE_PACK_NAME_SCHEMA = { type: 'string', minLength: 1 } as const;

function scriptablePackArgsSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
  options: { readonly subject?: boolean; readonly guidSubject?: boolean } = {},
) {
  const subjectRequired = ['requestId', ...required];
  return {
    type: 'object',
    properties: {
      sourcePath: SCRIPTABLE_PACK_SOURCE_PATH_SCHEMA,
      ownerGuid: SCRIPTABLE_PACK_OWNER_GUID_SCHEMA,
      requestId: SCRIPTABLE_PACK_REQUEST_ID_SCHEMA,
      ...properties,
    },
    required: subjectRequired,
    ...(options.subject === false
      ? {}
      : {
          anyOf: [
            { required: [...subjectRequired, 'sourcePath'] },
            { required: [...subjectRequired, 'ownerGuid'] },
            ...(options.guidSubject === false ? [] : [{ required: [...subjectRequired, 'guid'] }]),
          ],
        }),
    additionalProperties: false,
  } as const;
}

export const SOURCE_AUTHORING_OPERATION_DESCRIPTORS = [
  {
    id: 'asset-source.create',
    kind: 'create',
    domain: 'session',
    title: 'Create Asset Source',
    argsSchema: scriptablePackArgsSchema(
      {
        name: SCRIPTABLE_PACK_NAME_SCHEMA,
        initialOutput: {
          type: 'object',
          properties: {
            sourceKey: SCRIPTABLE_PACK_SOURCE_KEY_SCHEMA,
            kind: SCRIPTABLE_PACK_ASSET_KIND_SCHEMA,
            name: SCRIPTABLE_PACK_NAME_SCHEMA,
          },
          required: ['sourceKey', 'kind'],
          additionalProperties: false,
        },
      },
      ['sourcePath', 'initialOutput'],
      { subject: false },
    ),
  },
  {
    id: 'asset-source.add-output',
    kind: 'add-output',
    domain: 'session',
    title: 'Add Asset Source Output',
    argsSchema: scriptablePackArgsSchema(
      {
        sourceKey: SCRIPTABLE_PACK_SOURCE_KEY_SCHEMA,
        assetKind: SCRIPTABLE_PACK_ASSET_KIND_SCHEMA,
        name: SCRIPTABLE_PACK_NAME_SCHEMA,
        expectedRevision: SCRIPTABLE_PACK_REVISION_SCHEMA,
      },
      ['sourceKey', 'assetKind', 'expectedRevision'],
    ),
  },
  {
    id: 'asset-source.add-external-asset',
    kind: 'add-external-asset',
    domain: 'session',
    title: 'Add Asset Source External Asset',
    argsSchema: scriptablePackArgsSchema(
      {
        alias: SCRIPTABLE_PACK_SOURCE_KEY_SCHEMA,
        guid: { type: 'string', format: 'uuid' },
        expectedRevision: SCRIPTABLE_PACK_REVISION_SCHEMA,
      },
      ['alias', 'guid', 'expectedRevision'],
      { guidSubject: false },
    ),
  },
  {
    id: 'asset-source.rename',
    kind: 'rename',
    domain: 'session',
    title: 'Rename Asset Source Display Name',
    argsSchema: scriptablePackArgsSchema(
      {
        target: {
          oneOf: [
            {
              type: 'object',
              properties: { kind: { const: 'package' } },
              required: ['kind'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                kind: { const: 'output' },
                sourceKey: SCRIPTABLE_PACK_SOURCE_KEY_SCHEMA,
              },
              required: ['kind', 'sourceKey'],
              additionalProperties: false,
            },
          ],
        },
        name: SCRIPTABLE_PACK_NAME_SCHEMA,
        expectedRevision: SCRIPTABLE_PACK_REVISION_SCHEMA,
      },
      ['target', 'name', 'expectedRevision'],
    ),
  },
  {
    id: 'asset-source.remove-output',
    kind: 'remove-output',
    domain: 'session',
    title: 'Remove Asset Source Output',
    destructive: true,
    argsSchema: scriptablePackArgsSchema(
      {
        sourceKey: SCRIPTABLE_PACK_SOURCE_KEY_SCHEMA,
        confirmIncomingRefs: { type: 'array', items: { type: 'string' } },
        expectedRevision: SCRIPTABLE_PACK_REVISION_SCHEMA,
      },
      ['sourceKey', 'expectedRevision'],
    ),
  },
  {
    id: 'asset-source.clone',
    kind: 'clone',
    domain: 'session',
    title: 'Clone Asset Source',
    argsSchema: scriptablePackArgsSchema(
      {
        targetPath: SCRIPTABLE_PACK_SOURCE_PATH_SCHEMA,
        expectedRevision: SCRIPTABLE_PACK_REVISION_SCHEMA,
      },
      ['targetPath', 'expectedRevision'],
    ),
  },
  {
    id: 'asset-source.rebuild',
    kind: 'rebuild',
    domain: 'session',
    title: 'Rebuild Asset Source',
    argsSchema: scriptablePackArgsSchema({ expectedRevision: SCRIPTABLE_PACK_REVISION_SCHEMA }, [
      'expectedRevision',
    ]),
  },
  {
    id: 'asset-source.cold-cook',
    kind: 'cold-cook',
    domain: 'session',
    title: 'Cold Cook Asset Source',
    argsSchema: scriptablePackArgsSchema({ expectedRevision: SCRIPTABLE_PACK_REVISION_SCHEMA }, [
      'expectedRevision',
    ]),
  },
] as const;

export type ScriptablePackError =
  | {
      readonly code: 'pack-source-load-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly sourcePath: string;
        readonly reason: 'module-load' | 'timeout' | 'source-changed';
        readonly phase: 'module-load' | 'build';
        readonly diagnostic: string;
        readonly timeoutMs?: number;
      };
    }
  | {
      readonly code: 'pack-source-definition-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly sourcePath?: string;
        readonly propertyPath: string;
        readonly actual: string;
      };
    }
  | {
      readonly code: 'pack-source-output-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly missingGuids: readonly string[];
        readonly unexpectedSourceKeys: readonly string[];
        readonly kindMismatches: readonly {
          readonly sourceKey: string;
          readonly expected: string;
          readonly actual: string;
        }[];
      };
    }
  | {
      readonly code: 'pack-source-external-closure-mismatch';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly undeclaredReferencedGuids: readonly string[];
        readonly undeclaredReadGuids: readonly string[];
        readonly unusedDeclaredGuids: readonly string[];
      };
    }
  | {
      readonly code:
        | 'pack-source-path-invalid'
        | 'pack-source-revision-conflict'
        | 'pack-source-mutation-unsupported'
        | 'pack-source-reference-conflict'
        | 'pack-source-write-failed'
        | 'pack-source-build-cycle'
        | 'pack-source-publication-timeout'
        | 'pack-source-operation-committed';
      readonly expected: string;
      readonly actual?: string;
      readonly hint: string;
      readonly retryable: boolean;
      readonly recoveryActions: readonly string[];
      readonly detail: {
        readonly requestId?: string;
        readonly sourcePath?: string;
        readonly packageId?: string;
        readonly sourceKey?: string;
        readonly incomingRefs?: readonly string[];
      };
    };

function actual(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (ArrayBuffer.isView(value)) return value.constructor.name;
  return typeof value;
}

function invalid(
  propertyPath: string,
  expected: string,
  value: unknown,
  sourcePath?: string,
): Result<never, ScriptablePackError> {
  return err({
    code: 'pack-source-definition-invalid',
    expected,
    hint: 'repair the default exported ScriptablePack definition, then inspect Meta again',
    detail: {
      ...(sourcePath === undefined ? {} : { sourcePath }),
      propertyPath,
      actual: actual(value),
    },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAssetGuid(value: unknown): value is AssetGuid {
  return value instanceof Uint8Array && value.byteLength === 16;
}

function guidKey(guid: AssetGuid): string {
  return AssetGuidCodec.format(guid);
}

function freezeDefinition(
  definition: ScriptablePackDefinition,
): Readonly<ScriptablePackDefinition> {
  const assets = Object.fromEntries(
    Object.entries(definition.assets).map(([sourceKey, descriptor]) => [
      sourceKey,
      Object.freeze({ ...descriptor, guid: descriptor.guid.slice() as AssetGuid }),
    ]),
  );
  const externalAssets = Object.fromEntries(
    Object.entries(definition.externalAssets).map(([alias, guid]) => [
      alias,
      guid.slice() as AssetGuid,
    ]),
  );
  const sceneComponents =
    definition.sceneComponents === undefined
      ? undefined
      : Object.freeze(
          projectScriptablePackSceneComponents(definition.sceneComponents).map((component) =>
            Object.freeze({
              ...component,
              fields: Object.freeze({ ...component.fields }),
            }),
          ),
        );
  return Object.freeze({
    ...definition,
    packageId: definition.packageId.slice() as AssetGuid,
    assets: Object.freeze(assets),
    externalAssets: Object.freeze(externalAssets),
    ...(sceneComponents === undefined ? {} : { sceneComponents }),
  });
}

export function validateScriptablePackDefinition(
  value: unknown,
  sourcePath?: string,
): Result<Readonly<ScriptablePackDefinition>, ScriptablePackError> {
  if (!isRecord(value))
    return invalid('$', 'a ScriptablePack definition object', value, sourcePath);
  if (value.schemaVersion !== '1.0.0') {
    return invalid('$.schemaVersion', "the literal '1.0.0'", value.schemaVersion, sourcePath);
  }
  if (!isAssetGuid(value.packageId)) {
    return invalid('$.packageId', 'a 16-byte AssetGuid', value.packageId, sourcePath);
  }
  if (value.name !== undefined && typeof value.name !== 'string') {
    return invalid('$.name', 'a string when present', value.name, sourcePath);
  }
  if (!isRecord(value.assets) || Object.keys(value.assets).length === 0) {
    return invalid(
      '$.assets',
      'a non-empty sourceKey to descriptor object',
      value.assets,
      sourcePath,
    );
  }
  if (!isRecord(value.externalAssets)) {
    return invalid(
      '$.externalAssets',
      'an alias to AssetGuid object',
      value.externalAssets,
      sourcePath,
    );
  }
  if (value.sceneComponents !== undefined) {
    if (!Array.isArray(value.sceneComponents)) {
      return invalid(
        '$.sceneComponents',
        'an array of component tokens or neutral schema rows when present',
        value.sceneComponents,
        sourcePath,
      );
    }
    const componentNames = new Set<string>();
    for (const [componentIndex, component] of value.sceneComponents.entries()) {
      if (!isRecord(component)) {
        return invalid(
          `$.sceneComponents[${componentIndex}]`,
          'a component token or neutral schema row',
          component,
          sourcePath,
        );
      }
      if (typeof component.name !== 'string' || component.name.trim().length === 0) {
        return invalid(
          `$.sceneComponents[${componentIndex}].name`,
          'a non-empty component name',
          component.name,
          sourcePath,
        );
      }
      if (componentNames.has(component.name)) {
        return invalid(
          `$.sceneComponents[${componentIndex}].name`,
          'component names to be unique within one ScriptablePack',
          component.name,
          sourcePath,
        );
      }
      componentNames.add(component.name);
      if (!isRecord(component.fields)) {
        return invalid(
          `$.sceneComponents[${componentIndex}].fields`,
          'a field-name to schema-type object',
          component.fields,
          sourcePath,
        );
      }
      for (const [fieldName, field] of Object.entries(component.fields)) {
        const type = sceneComponentFieldType(field);
        if (fieldName.trim().length === 0 || type === undefined || type.trim().length === 0) {
          return invalid(
            `$.sceneComponents[${componentIndex}].fields`,
            'field names with non-empty string schema types',
            field,
            sourcePath,
          );
        }
      }
    }
  }
  if (typeof value.build !== 'function') {
    return invalid('$.build', 'a build(assetReader) function', value.build, sourcePath);
  }

  const packageGuid = guidKey(value.packageId);
  const localGuids = new Set<string>();
  for (const [sourceKey, descriptor] of Object.entries(value.assets)) {
    if (sourceKey.trim().length === 0) {
      return invalid('$.assets', 'non-empty sourceKey object keys', sourceKey, sourcePath);
    }
    if (!isRecord(descriptor)) {
      return invalid(
        `$.assets[${JSON.stringify(sourceKey)}]`,
        'an asset descriptor',
        descriptor,
        sourcePath,
      );
    }
    if (!isAssetGuid(descriptor.guid)) {
      return invalid(
        `$.assets[${JSON.stringify(sourceKey)}].guid`,
        'a 16-byte AssetGuid',
        descriptor.guid,
        sourcePath,
      );
    }
    if (typeof descriptor.kind !== 'string' || !isScriptablePackAssetKind(descriptor.kind)) {
      return invalid(
        `$.assets[${JSON.stringify(sourceKey)}].kind`,
        'one of SCRIPTABLE_PACK_ASSET_KINDS',
        descriptor.kind,
        sourcePath,
      );
    }
    if (descriptor.name !== undefined && typeof descriptor.name !== 'string') {
      return invalid(
        `$.assets[${JSON.stringify(sourceKey)}].name`,
        'a string when present',
        descriptor.name,
        sourcePath,
      );
    }
    const guid = guidKey(descriptor.guid);
    if (guid === packageGuid || localGuids.has(guid)) {
      return invalid(
        `$.assets[${JSON.stringify(sourceKey)}].guid`,
        'a GUID unique within the package and distinct from packageId',
        descriptor.guid,
        sourcePath,
      );
    }
    localGuids.add(guid);
  }

  const externalGuids = new Set<string>();
  for (const [alias, guidValue] of Object.entries(value.externalAssets)) {
    if (alias.trim().length === 0) {
      return invalid('$.externalAssets', 'non-empty alias object keys', alias, sourcePath);
    }
    if (!isAssetGuid(guidValue)) {
      return invalid(
        `$.externalAssets[${JSON.stringify(alias)}]`,
        'a 16-byte AssetGuid',
        guidValue,
        sourcePath,
      );
    }
    const guid = guidKey(guidValue);
    if (guid === packageGuid || localGuids.has(guid) || externalGuids.has(guid)) {
      return invalid(
        `$.externalAssets[${JSON.stringify(alias)}]`,
        'a unique foreign GUID not owned by this package',
        guidValue,
        sourcePath,
      );
    }
    externalGuids.add(guid);
  }

  return ok(freezeDefinition(value as unknown as ScriptablePackDefinition));
}

export function projectScriptablePackMeta(
  definition: ScriptablePackDefinition,
  source: string,
): ScriptablePackMetaJson {
  const subAssets = Object.entries(definition.assets)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceKey, descriptor], sourceIndex) => ({
      guid: guidKey(descriptor.guid),
      sourceIndex,
      sourceKey,
      kind: descriptor.kind,
      ...(descriptor.name === undefined ? {} : { name: descriptor.name }),
    }));
  const externalAssets = Object.entries(definition.externalAssets)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([alias, guid]) => ({ alias, guid: guidKey(guid) }));
  return {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    packageId: guidKey(definition.packageId),
    ...(definition.name === undefined ? {} : { name: definition.name }),
    importer: 'pack-ts',
    source,
    importSettings: { contractVersion: '1.0.0', externalAssets },
    subAssets,
  };
}
