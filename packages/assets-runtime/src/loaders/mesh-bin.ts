import {
  deriveVertexLayoutProjectionFromMask,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import {
  decodeMeshBinHeader,
  MESH_BIN_HEADER_V4_BYTES,
  type MeshBinHeaderV4,
} from '@forgeax/engine-pack';
import { err, ok, type Result, type VertexAttributeMap } from '@forgeax/engine-types';
import { MeshBinAssetError } from '../errors/asset';

export interface UnpackedMeshBin {
  readonly version: 4;
  readonly projection: VertexLayoutProjection;
  readonly vertices: Float32Array;
  readonly attributes: VertexAttributeMap;
  readonly indices?: Uint16Array | Uint32Array;
  readonly submeshes: ReadonlyArray<Record<string, unknown>>;
  readonly materialSlots: readonly {
    readonly slotName: string;
    readonly sourceKey?: string;
    readonly defaultMaterialRef?: number;
  }[];
  readonly aabb?: Float32Array;
  readonly morphTargets?: ReadonlyArray<Record<string, Float32Array>>;
  readonly morphWeights?: Float32Array;
}

function fail(
  sourceKey: string,
  expected: string,
  actual: string,
  header?: Partial<MeshBinHeaderV4>,
  reason: import('@forgeax/engine-types').AssetMeshBinContractViolationReason = 'header-invalid',
  expectedFacts?: import('@forgeax/engine-types').AssetMeshBinContractFacts,
  actualFacts?: import('@forgeax/engine-types').AssetMeshBinContractFacts,
): Result<UnpackedMeshBin, MeshBinAssetError> {
  return err(
    new MeshBinAssetError({
      sourceKey,
      expected,
      actual,
      ...(header === undefined ? {} : { header }),
      reason,
      ...(expectedFacts === undefined ? {} : { expectedFacts }),
      ...(actualFacts === undefined ? {} : { actualFacts }),
    }),
  );
}

function copyAttributes(
  source: Float32Array,
  header: MeshBinHeaderV4,
  projection: VertexLayoutProjection,
): VertexAttributeMap {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const attributes: Record<string, Float32Array | Uint16Array> = {};
  for (const entry of projection.attributes) {
    const components = entry.byteLength / (entry.format === 'uint16x4' ? 2 : 4);
    const target =
      entry.format === 'uint16x4'
        ? new Uint16Array(header.vertexCount * components)
        : new Float32Array(header.vertexCount * components);
    for (let vertex = 0; vertex < header.vertexCount; vertex++) {
      for (let component = 0; component < components; component++) {
        const offset =
          vertex * header.stride + entry.offset + component * (entry.format === 'uint16x4' ? 2 : 4);
        if (target instanceof Uint16Array)
          target[vertex * components + component] = view.getUint16(offset, true);
        else target[vertex * components + component] = view.getFloat32(offset, true);
      }
    }
    attributes[entry.key] = target;
  }
  return attributes as VertexAttributeMap;
}

export function unpackMeshBinV4(
  bytes: Uint8Array,
  sourceKey: string,
): Result<UnpackedMeshBin, MeshBinAssetError> {
  const headerResult = decodeMeshBinHeader(bytes, sourceKey);
  if (!headerResult.ok) {
    const reason =
      headerResult.error.code === 'mesh-bin-header-truncated'
        ? 'header-truncated'
        : headerResult.error.code === 'mesh-bin-version-unsupported'
          ? 'version-unsupported'
          : 'header-invalid';
    const actualFacts = {
      byteLength: bytes.byteLength,
      ...(bytes.byteLength >= 4
        ? {
            version: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
              0,
              true,
            ),
          }
        : {}),
    };
    return fail(
      sourceKey,
      headerResult.error.expected,
      headerResult.error.actual,
      undefined,
      reason,
      reason === 'header-truncated'
        ? { field: 'byteLength', byteLength: MESH_BIN_HEADER_V4_BYTES }
        : reason === 'version-unsupported'
          ? { field: 'version', version: 4 }
          : undefined,
      actualFacts,
    );
  }
  const header = headerResult.value;
  const projectionResult = deriveVertexLayoutProjectionFromMask(header.mask);
  if (!projectionResult.ok) {
    return fail(
      sourceKey,
      projectionResult.error.expected,
      `mask=${header.mask}`,
      header,
      'projection-mismatch',
      {
        field: 'mask',
        mask: projectionResult.error.detail.knownMask,
      },
      {
        field: 'mask',
        mask: header.mask,
        projectionVersion: header.projectionVersion,
        stride: header.stride,
        digest: header.digest,
      },
    );
  }
  const projection = projectionResult.value;
  if (
    projection.schemaVersion !== header.projectionVersion ||
    projection.arrayStride !== header.stride ||
    projection.digest !== header.digest
  ) {
    return fail(
      sourceKey,
      'wire projection version, mask, stride, and digest to match geometry projection',
      `projection=${projection.schemaVersion}/${projection.arrayStride}/${projection.digest}; wire=${header.projectionVersion}/${header.stride}/${header.digest}`,
      header,
      'projection-mismatch',
      {
        field: 'projectionVersion',
        projectionVersion: projection.schemaVersion,
        mask: projection.mask,
        stride: projection.arrayStride,
        digest: projection.digest,
      },
    );
  }
  const payloadBytes = header.vertexBytes + header.indexBytes + header.jsonBytes;
  if (MESH_BIN_HEADER_V4_BYTES + payloadBytes !== bytes.byteLength) {
    return fail(
      sourceKey,
      `exactly ${MESH_BIN_HEADER_V4_BYTES + payloadBytes} bytes`,
      `${bytes.byteLength} bytes`,
      header,
      'payload-length-mismatch',
      { field: 'byteLength', byteLength: MESH_BIN_HEADER_V4_BYTES + payloadBytes },
      {
        field: 'byteLength',
        byteLength: bytes.byteLength,
        vertexBytes: header.vertexBytes,
        indexBytes: header.indexBytes,
        jsonBytes: header.jsonBytes,
      },
    );
  }
  let offset = MESH_BIN_HEADER_V4_BYTES;
  const vertexBytes = bytes.subarray(offset, offset + header.vertexBytes);
  const vertices = new Float32Array(vertexBytes.byteLength / 4);
  new Uint8Array(vertices.buffer).set(vertexBytes);
  offset += header.vertexBytes;
  let indices: Uint16Array | Uint32Array | undefined;
  if (header.indexCount > 0) {
    const indexBytes = bytes.subarray(offset, offset + header.indexBytes);
    if (header.indexWidth === 2) {
      indices = new Uint16Array(header.indexCount);
      new Uint8Array(indices.buffer).set(indexBytes);
    } else {
      indices = new Uint32Array(header.indexCount);
      new Uint8Array(indices.buffer).set(indexBytes);
    }
    offset += header.indexBytes;
  }
  const jsonBytes = bytes.subarray(offset, offset + header.jsonBytes);
  let meta: {
    submeshes?: ReadonlyArray<Record<string, unknown>>;
    materialSlots?: readonly {
      readonly slotName: string;
      readonly sourceKey?: string;
      readonly defaultMaterialRef?: number;
    }[];
    aabb?: readonly number[];
    morphTargets?: ReadonlyArray<Record<string, readonly number[]>>;
    morphWeights?: readonly number[];
  };
  try {
    meta = JSON.parse(new TextDecoder().decode(jsonBytes)) as typeof meta;
  } catch (error) {
    return fail(
      sourceKey,
      'valid mesh-bin v4 JSON metadata',
      error instanceof Error ? error.message : String(error),
      header,
      'metadata-invalid',
      { field: 'metadata' },
      { field: 'metadata' },
    );
  }
  if (
    !Array.isArray(meta.submeshes) ||
    meta.submeshes.length === 0 ||
    !Array.isArray(meta.materialSlots)
  ) {
    return fail(
      sourceKey,
      'non-empty submeshes and materialSlots metadata',
      'metadata table missing',
      header,
      'metadata-invalid',
      { field: 'metadata' },
      { field: 'metadata' },
    );
  }
  const attributes = copyAttributes(vertices, header, projection);
  for (const attribute of projection.attributes) {
    const value = attributes[attribute.key];
    if (value === undefined)
      return fail(
        sourceKey,
        `decoded ${attribute.key} attribute`,
        'attribute missing',
        header,
        'attribute-invalid',
        {
          field: 'attribute',
          attribute: attribute.key,
          expectedLength:
            header.vertexCount * (attribute.byteLength / (attribute.format === 'uint16x4' ? 2 : 4)),
        },
        {
          field: 'attribute',
          attribute: attribute.key,
          mask: header.mask,
          stride: header.stride,
          vertexCount: header.vertexCount,
        },
      );
    if (value instanceof ArrayBuffer) continue;
    for (const component of value) {
      if (!Number.isFinite(component))
        return fail(
          sourceKey,
          'finite vertex payload',
          `non-finite ${attribute.key}`,
          header,
          'payload-non-finite',
          { field: 'attribute', attribute: attribute.key },
          {
            field: 'attribute',
            attribute: attribute.key,
            mask: header.mask,
            stride: header.stride,
            vertexCount: header.vertexCount,
            elementIndex: [...value].findIndex((component) => !Number.isFinite(component)),
            actualValue: Number.isNaN(component)
              ? 'nan'
              : component === Number.POSITIVE_INFINITY
                ? 'positive-infinity'
                : 'negative-infinity',
          },
        );
    }
  }
  const morphTargets = meta.morphTargets?.map((target) =>
    Object.fromEntries(
      Object.entries(target).map(([key, value]) => [key, new Float32Array(value)]),
    ),
  );
  const mesh: UnpackedMeshBin = {
    version: 4,
    projection,
    vertices,
    attributes,
    ...(indices === undefined ? {} : { indices }),
    submeshes: meta.submeshes,
    materialSlots: meta.materialSlots,
    ...(meta.aabb === undefined ? {} : { aabb: new Float32Array(meta.aabb) }),
    ...(morphTargets === undefined ? {} : { morphTargets }),
    ...(meta.morphWeights === undefined
      ? {}
      : { morphWeights: new Float32Array(meta.morphWeights) }),
  };
  return ok(mesh);
}
