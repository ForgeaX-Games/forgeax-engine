import { ASSET_CHANGED_EVENT, type AssetChangedPayload, emitAssetChanged } from './events.js';

export { ASSET_CHANGED_EVENT, type AssetChangedPayload, emitAssetChanged };

export interface RichAssetChangedEventInput {
  readonly file?: string;
  readonly event: string;
  readonly kind: 'sidecar' | 'source';
  readonly guids: readonly string[];
  readonly sourcePath: string;
  readonly revision: number;
}

export function createAssetChangedEvent(
  input: RichAssetChangedEventInput,
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
