import {
  type AssetDecoder,
  type AssetDecoderContribution,
  type AssetKind,
  type AssetLoadError,
  err,
  type MeshAsset,
  ok,
  type Result,
} from '@forgeax/engine-types';
import { decodeMeshBinary, normalizeMeshPayload } from './mesh-binary';
import { createPrimitiveMesh, type PrimitiveMeshKind } from './primitive-mesh';

export const meshAssetKind: AssetKind<MeshAsset, 'mesh'> = {
  kind: 'mesh',
} as AssetKind<MeshAsset, 'mesh'>;

const PROCEDURAL_MESH_KINDS: Readonly<Record<string, PrimitiveMeshKind>> = {
  'procedural-cube': 'cube',
  'procedural-triangle': 'triangle',
  'procedural-quad': 'quad',
  'procedural-sphere': 'sphere',
  'procedural-cylinder': 'cylinder',
  'procedural-nine-slice-quad': 'nine-slice-quad',
};

function proceduralMesh(payload: unknown): Result<MeshAsset, AssetLoadError> | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const geometry = (payload as { readonly geometry?: unknown }).geometry;
  if (typeof geometry !== 'string') return undefined;
  const kind = PROCEDURAL_MESH_KINDS[geometry];
  if (kind === undefined) return undefined;
  const result = createPrimitiveMesh(kind);
  if (result.ok) return result;
  return err({
    code: 'asset-package-invalid',
    expected: `a valid procedural ${kind} mesh payload`,
    hint: 'recook the authored procedural mesh descriptor',
    detail: { guid: '', reason: 'procedural mesh creation failed' },
  });
}

/** Geometry validates mesh payload shape before any render owner consumes it. */
export const meshAssetDecoder: AssetDecoder<MeshAsset> = {
  async decode({ envelope, artifacts }): Promise<Result<MeshAsset, AssetLoadError>> {
    const payload = envelope.payload;
    const procedural = proceduralMesh(payload);
    if (procedural !== undefined) {
      if (!procedural.ok) {
        return err<AssetLoadError>({
          code: 'asset-package-invalid',
          expected: procedural.error.expected,
          hint: procedural.error.hint,
          detail: { guid: envelope.guid, reason: 'procedural mesh creation failed' },
        });
      }
      return procedural;
    }
    const body = envelope.artifacts.body;
    if (body !== undefined) {
      const bytes = await artifacts.read(body);
      if (!bytes.ok) return err<AssetLoadError>(bytes.error);
      const decoded = decodeMeshBinary(bytes.value, envelope.refs);
      if (decoded === undefined) {
        return err({
          code: 'asset-package-invalid',
          expected: 'a valid mesh-binary/4 body artifact with a local-space AABB',
          hint: 'recook the mesh binary and publish its validated geometry payload',
          detail: { guid: envelope.guid, reason: 'mesh binary decode failed' },
        });
      }
      return ok(decoded);
    }
    const normalized = normalizeMeshPayload(payload, envelope.refs);
    if (normalized !== undefined) return ok(normalized);
    if (
      payload.kind !== 'mesh' ||
      !(payload.vertices instanceof Float32Array) ||
      payload.vertices.length === 0 ||
      payload.aabb === undefined
    ) {
      return err({
        code: 'asset-package-invalid',
        expected: 'a mesh payload with vertices and a local-space AABB',
        hint: 'recook the mesh binary and publish its validated geometry payload',
        detail: { guid: envelope.guid, reason: 'mesh payload failed geometry validation' },
      });
    }
    return ok(payload);
  },
};

export const meshAssetContribution: AssetDecoderContribution<MeshAsset, 'mesh'> = {
  kind: meshAssetKind,
  decoder: meshAssetDecoder,
  consumer: 'Geometry',
};
