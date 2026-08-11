import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  GLTF_ERROR_HINTS,
  type GltfError,
  type GltfErrorCode,
  type GltfSkinAttrAsymmetricDetail,
  type GltfVersionUnsupportedDetail,
  gltfErr,
} from '../errors.js';

const EXPECTED_IN_POLICY_ORDER = [
  'GLB 12-byte header (magic 0x46546C67 + version=2 + length) plus mandatory JSON chunk',
  'asset.version === "2.0"',
  'accessor byte range within bufferView.byteLength',
  'extension listed in v1 allowlist (see EXTENSION_ALLOWLIST in @forgeax/engine-gltf)',
  'dense fixed-stride accessor with supported componentType',
  'externalLoader resolved the URI into an ArrayBuffer without throwing',
  "sidecar <source>.meta.json (importer: 'gltf') present in same directory",
  'all instance attribute accessors share the same count',
  'image/mimeType is image/jpeg or image/png',
  'skin.joints.length <= MAX_JOINTS (256)',
  'animation sampler interpolation is LINEAR or STEP',
  'no animation channel targets morph weights (path !== "weights")',
  'every joint node has a non-empty name and belongs to an acyclic hierarchy',
  'image bytes extractable from bufferView / data-URI / external URI without corruption',
  'mesh primitive declares JOINTS_0 and WEIGHTS_0 symmetrically (both present or both absent)',
  'every animation channel resolves to one uniquely named scene node and stable target ID',
] as const;

const HINTS_IN_POLICY_ORDER = [
  'verify .glb is not truncated; rerun: forgeax-engine-remote-gltf import <path>',
  'asset.version must be "2.0"; v1 or v3 not supported',
  'rebuild .gltf with valid bufferViews; check accessor index; ensure accessor.byteOffset + EFFECTIVE_STRIDE * (count - 1) + element_size <= bufferView.byteLength',
  'see feat-future-gltf-extensions-allowlist; remove this extension or wait for the allowlist to expand',
  'sparse: see feat-future-gltf-sparse-accessor; morph: see feat-future-gltf-morph; interleaved: see feat-future-gltf-mesh-multi-section',
  'check sidecar meta.json + textures/ directory + vite-plugin-pack /__pack/lookup route',
  'run: forgeax-engine-remote-gltf import <path>',
  'EXT_mesh_gpu_instancing requires TRANSLATION/ROTATION/SCALE accessors to share count; see https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/EXT_mesh_gpu_instancing/README.md#extending-nodes-with-instance-attributes',
  'convert to JPG/PNG via external tool; only image/jpeg and image/png are supported',
  'reduce joint count below MAX_JOINTS (256) or see OOS-skin-max-joints',
  'see OOS-skin-cubicspline; convert CUBICSPLINE to LINEAR/STEP in DCC tool',
  'see OOS-skin-morph-anim; remove morph targets from animation channels in DCC tool',
  'ensure every joint node has a non-empty name and the node hierarchy is acyclic',
  'verify the bufferView byte range / data: URI base64 / external URI sibling file is intact next to the .gltf source; rerun: forgeax-engine-remote-gltf import <path>',
  'glTF spec requires JOINTS_0 and WEIGHTS_0 to appear together for each skinned primitive; add the missing attribute or remove the present one in the DCC tool',
  'name every node in the animated hierarchy and ensure each animated full path is unique',
] as const;

const policyErrors: readonly GltfError[] = [
  gltfErr('gltf-malformed-header', { filePath: 'model.glb', byteOffset: 0 }),
  gltfErr('gltf-version-unsupported', { filePath: 'model.gltf', actualVersion: '1.0' }),
  gltfErr('gltf-buffer-out-of-bounds', {
    accessor: 0,
    byteOffset: 0,
    byteLength: 4,
    bufferIndex: 0,
  }),
  gltfErr('gltf-extension-unsupported', {
    extension: 'KHR_x',
    source: 'extensionsRequired',
  }),
  gltfErr('gltf-accessor-type-mismatch', { accessorIndex: 0, reason: 'sparse' }),
  gltfErr('gltf-texture-load-failed', { uri: 'textures/test.png' }),
  gltfErr('gltf-meta-missing', {
    filePath: 'model.gltf',
    expectedMetaPath: 'model.gltf.meta.json',
  }),
  gltfErr('gltf-instancing-count-mismatch', {
    nodeIndex: 0,
    accessor: 'TRANSLATION',
    expectedCount: 2,
    actualCount: 3,
  }),
  gltfErr('gltf-image-mime-unsupported', { mimeType: 'image/bmp' }),
  gltfErr('gltf-skin-joint-count-exceeded', { skinIndex: 0, jointCount: 300, maxJoints: 256 }),
  gltfErr('gltf-animation-cubicspline-unsupported', { animationIndex: 0, samplerIndex: 1 }),
  gltfErr('gltf-morph-unsupported', { animationIndex: 0, channelIndex: 2, nodeIndex: 3 }),
  gltfErr('gltf-skin-joint-name-missing', {
    reason: 'name-missing',
    skinIndex: 0,
    jointPathIndex: 4,
    nodeIndex: 5,
  }),
  gltfErr('gltf-image-extract-failed', { imageIndex: 0, source: 'bufferView', reason: 'sample' }),
  gltfErr('gltf-skin-attr-asymmetric', {
    meshIndex: 0,
    primitiveIndex: 0,
    hasJoints: true,
    hasWeights: false,
  }),
  gltfErr('gltf-animation-target-invalid', {
    reason: 'name-missing',
    animationIndex: 0,
    channelIndex: 0,
    nodeIndex: 0,
  }),
];

describe('glTF error policy owner', () => {
  it('projects one exact sixteen-code policy surface with stable own-key order', () => {
    const codes = policyErrors.map(({ code }) => code);

    expect(codes).toHaveLength(16);
    expect(new Set(codes).size).toBe(16);
    expect(Object.keys(GLTF_ERROR_HINTS)).toEqual(codes);
    expect(Object.getOwnPropertyNames(GLTF_ERROR_HINTS)).toEqual(codes);
    expect(Object.values(GLTF_ERROR_HINTS)).toEqual(HINTS_IN_POLICY_ORDER);

    for (const code of codes) {
      expect(Object.prototype.propertyIsEnumerable.call(GLTF_ERROR_HINTS, code)).toBe(true);
    }
  });

  it('keeps every expected and hint string byte-identical through gltfErr', () => {
    for (const [index, error] of policyErrors.entries()) {
      expect(error.expected).toBe(EXPECTED_IN_POLICY_ORDER[index]);
      expect(error.hint).toBe(HINTS_IN_POLICY_ORDER[index]);
      expect(GLTF_ERROR_HINTS[error.code]).toBe(HINTS_IN_POLICY_ORDER[index]);
      expect(Object.keys(error)).toEqual(['code', 'expected', 'hint', 'detail']);
    }
  });

  it('preserves the public hint type and representative detail narrowing', () => {
    expectTypeOf(GLTF_ERROR_HINTS).toEqualTypeOf<Readonly<Record<GltfErrorCode, string>>>();

    const versionError = gltfErr('gltf-version-unsupported', {
      filePath: 'model.gltf',
      actualVersion: '1.0',
    });
    expectTypeOf(versionError.detail).toEqualTypeOf<GltfVersionUnsupportedDetail>();
    expect(versionError.detail.actualVersion).toBe('1.0');

    const skinError = gltfErr('gltf-skin-attr-asymmetric', {
      meshIndex: 2,
      primitiveIndex: 1,
      hasJoints: true,
      hasWeights: false,
    });
    expectTypeOf(skinError.detail).toEqualTypeOf<GltfSkinAttrAsymmetricDetail>();
    expect(skinError.detail.meshIndex).toBe(2);
    expect(skinError.detail.hasWeights).toBe(false);
  });
});
