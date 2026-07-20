// derive-render-data-skin.unit.test.ts -- feat-20260611-fox-skinning-vertex-
// attribute-chain M3 / w15: AC-09.ii deriveRenderDataMesh layout discrimination.
//
// Verifies the 18F discriminator: a MeshAsset whose attributes contain
// skinIndex (i.e. a glTF primitive carrying JOINTS_0/WEIGHTS_0 went through
// the parse-gltf -> bridge path) projects to MeshRenderData.layout === '18F';
// without skinIndex it stays '12F'. Static tsc narrowing is necessary but
// insufficient -- a fallthrough or implicit default would not be caught at
// compile time, so the runtime assertion guards the actual switch (R-1).
//
// Anchors: requirements AC-09.ii; plan-strategy D-1 (12F/18F float-count
// naming, no semantic 'skin'); plan-strategy R-1 (single-member -> two-member
// union evolution); research E-2 (render-data.ts:118 hardcoded layout).

import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { deriveRenderDataMesh } from '../render-data';

function meshWithoutSkin(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(4 * 12),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    attributes: {},
    aabb: new Float32Array(6),
    submeshes: [{ indexOffset: 0, indexCount: 6, vertexCount: 4, topology: 'triangle-list' }],
  };
}

function meshWithSkin(): MeshAsset {
  // 4 verts * 18F = 72 floats. skinIndex is 4 uint16 per vertex; skinWeight
  // 4 float per vertex. Values are placeholders -- deriveRenderDataMesh only
  // inspects the *presence* of skinIndex.
  return {
    kind: 'mesh',
    vertices: new Float32Array(4 * 18),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    attributes: {
      skinIndex: new Uint16Array(4 * 4),
      skinWeight: new Float32Array(4 * 4),
    },
    aabb: new Float32Array(6),
    submeshes: [{ indexOffset: 0, indexCount: 6, vertexCount: 4, topology: 'triangle-list' }],
  };
}

describe('feat-20260611 / M3 / w15 - deriveRenderDataMesh layout 12F/18F discriminator', () => {
  it("AC-09.ii (a) MeshAsset with attributes.skinIndex -> layout === '18F'", () => {
    const res = deriveRenderDataMesh(meshWithSkin());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.layout).toBe('18F');
  });

  it("AC-09.ii (b) MeshAsset without skinIndex -> layout === '12F' (no regression)", () => {
    const res = deriveRenderDataMesh(meshWithoutSkin());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.layout).toBe('12F');
  });

  it('AC-09.ii (c) skinWeight alone (without skinIndex) does not flip layout to 18F', () => {
    // Defensive: the bridge always writes both skinIndex and skinWeight when
    // a primitive carries JOINTS_0/WEIGHTS_0 (M2/w8). The discriminator is
    // skinIndex; a hypothetical asset writing only skinWeight (which would
    // be a parse-gltf fail-fast upstream -- AC-06) must not be misread as
    // 18F at this projection layer.
    const mesh: MeshAsset = {
      ...meshWithoutSkin(),
      attributes: { skinWeight: new Float32Array(16) },
    };
    const res = deriveRenderDataMesh(mesh);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.layout).toBe('12F');
  });
});
