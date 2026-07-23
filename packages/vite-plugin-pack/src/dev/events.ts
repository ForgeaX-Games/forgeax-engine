export const ASSET_CHANGED_EVENT = 'forgeax:asset-changed';

export interface AssetChangedPayload {
  readonly file: string;
  readonly event: string;
  readonly kind: 'sidecar' | 'source';
  readonly guids?: readonly string[];
  readonly sourcePath?: string;
  readonly revision?: number;
}

export interface AssetChangedEventInput {
  readonly file?: string;
  readonly event: string;
  readonly kind: 'sidecar' | 'source';
  readonly guids: readonly string[];
  readonly sourcePath: string;
  readonly revision: number;
}

export function createAssetChangedEvent(
  input: AssetChangedEventInput,
):
  | { readonly type: 'custom'; readonly event: string; readonly data: AssetChangedPayload }
  | undefined {
  const guids = [...new Set(input.guids.map((guid) => guid.toLowerCase()))];
  if (guids.length === 0) return undefined;
  return {
    type: 'custom',
    event: ASSET_CHANGED_EVENT,
    data: {
      file: input.file ?? input.sourcePath,
      event: input.event,
      kind: input.kind,
      guids,
      sourcePath: input.sourcePath,
      revision: input.revision,
    },
  };
}

export interface AssetChangedServer {
  readonly ws?: { send(payload: { type: string } & Record<string, unknown>): void } | undefined;
}

export function emitAssetChanged(
  server: AssetChangedServer,
  file: string,
  event: string,
  kind: 'sidecar' | 'source',
): void {
  const data: AssetChangedPayload = { file, event, kind };
  server.ws?.send({ type: 'custom', event: ASSET_CHANGED_EVENT, data });
}
