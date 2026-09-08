/** Canonical mesh binary wire facts shared by build-time and runtime owners. */

export const MESH_BIN_VERSION = 4 as const;
export const MESH_BIN_PROJECTION_VERSION = 1 as const;
export const MESH_BIN_HEADER_V4_BYTES = 80;
export const MESH_BIN_DIGEST_BYTES = 32;

export interface MeshBinHeaderV4 {
  readonly version: 4;
  readonly projectionVersion: 1;
  readonly mask: number;
  readonly digest: string;
  readonly stride: number;
  readonly vertexCount: number;
  readonly vertexBytes: number;
  readonly indexCount: number;
  readonly indexWidth: 0 | 2 | 4;
  readonly indexBytes: number;
  readonly jsonBytes: number;
}

export interface MeshBinContractError {
  readonly code:
    | 'mesh-bin-header-truncated'
    | 'mesh-bin-version-unsupported'
    | 'mesh-bin-header-invalid';
  readonly subject: 'mesh-bin';
  readonly sourceKey: string;
  readonly expected: string;
  readonly actual: string;
  readonly recovery: string;
}

export type MeshBinHeaderResult =
  | { readonly ok: true; readonly value: MeshBinHeaderV4 }
  | { readonly ok: false; readonly error: MeshBinContractError };

function failure(
  code: MeshBinContractError['code'],
  sourceKey: string,
  expected: string,
  actual: string,
): MeshBinHeaderResult {
  return {
    ok: false,
    error: {
      code,
      subject: 'mesh-bin',
      sourceKey,
      expected,
      actual,
      recovery: 're-cook the source with its Meta sidecar through the build-time importer',
    },
  };
}

function digestBytes(digest: string): Uint8Array {
  const bytes = new Uint8Array(MESH_BIN_DIGEST_BYTES);
  bytes.set(new TextEncoder().encode(digest).subarray(0, MESH_BIN_DIGEST_BYTES));
  return bytes;
}

function readDigest(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0+$/u, '');
}

export function writeMeshBinHeader(header: MeshBinHeaderV4, out: Uint8Array): void {
  if (out.byteLength < MESH_BIN_HEADER_V4_BYTES) {
    throw new RangeError('mesh-bin v4 header output is truncated');
  }
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, header.version, true);
  view.setUint32(4, header.projectionVersion, true);
  view.setUint32(8, header.mask, true);
  view.setUint32(12, header.stride, true);
  view.setUint32(16, header.vertexCount, true);
  view.setUint32(20, header.vertexBytes, true);
  view.setUint32(24, header.indexCount, true);
  view.setUint32(28, header.indexWidth, true);
  view.setUint32(32, header.indexBytes, true);
  view.setUint32(36, header.jsonBytes, true);
  out.set(digestBytes(header.digest), 48);
}

export function decodeMeshBinHeader(
  bytes: Uint8Array,
  sourceKey = '<unknown mesh source>',
): MeshBinHeaderResult {
  if (bytes.byteLength < MESH_BIN_HEADER_V4_BYTES) {
    return failure(
      'mesh-bin-header-truncated',
      sourceKey,
      `mesh-bin v4 header (${MESH_BIN_HEADER_V4_BYTES} bytes)`,
      `${bytes.byteLength} bytes`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0, true);
  if (version !== MESH_BIN_VERSION) {
    return failure('mesh-bin-version-unsupported', sourceKey, 'mesh-bin v4', `version ${version}`);
  }
  const projectionVersion = view.getUint32(4, true);
  const mask = view.getUint32(8, true);
  const stride = view.getUint32(12, true);
  const vertexCount = view.getUint32(16, true);
  const vertexBytes = view.getUint32(20, true);
  const indexCount = view.getUint32(24, true);
  const indexWidth = view.getUint32(28, true);
  const indexBytes = view.getUint32(32, true);
  const jsonBytes = view.getUint32(36, true);
  const digest = readDigest(bytes.subarray(48, 48 + MESH_BIN_DIGEST_BYTES));
  if (
    projectionVersion !== MESH_BIN_PROJECTION_VERSION ||
    mask === 0 ||
    stride === 0 ||
    !Number.isSafeInteger(vertexCount) ||
    !Number.isSafeInteger(vertexBytes) ||
    !Number.isSafeInteger(indexCount) ||
    !Number.isSafeInteger(indexBytes) ||
    !Number.isSafeInteger(jsonBytes) ||
    (indexCount === 0 && indexWidth !== 0) ||
    (indexCount > 0 && indexWidth !== 2 && indexWidth !== 4) ||
    indexBytes !== indexCount * indexWidth ||
    vertexBytes !== vertexCount * stride ||
    digest.length === 0
  ) {
    return failure(
      'mesh-bin-header-invalid',
      sourceKey,
      'safe v4 projection, stride, cardinality, and payload byte lengths',
      `projection=${projectionVersion}; mask=${mask}; stride=${stride}; vertexBytes=${vertexBytes}; indexBytes=${indexBytes}; digest=${digest}`,
    );
  }
  return {
    ok: true,
    value: {
      version: 4,
      projectionVersion: 1,
      mask,
      digest,
      stride,
      vertexCount,
      vertexBytes,
      indexCount,
      indexWidth: indexWidth as 0 | 2 | 4,
      indexBytes,
      jsonBytes,
    },
  };
}
