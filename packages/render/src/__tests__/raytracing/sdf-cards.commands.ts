import { fileURLToPath } from 'node:url';
import { buildMeshDistanceField } from '../../../../geometry/src/distance-field';
import {
  decodeMeshBinary,
  decodeMeshDistanceField,
  encodeMeshDistanceField,
  packMeshBin,
} from '../../../../geometry/src/index';
import { buildMeshCardLayout } from '../../../../geometry/src/mesh-card-layout';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  cookRayMaterial,
} from '../../../../shader-compiler/src/index';
import type { MeshCardLayout } from '../../../../types/src/index';
import { Materials } from '../../materials';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

function loadedLayout(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  cardLayout: MeshCardLayout,
) {
  const vertices = Float32Array.from(positions);
  const bytes = packMeshBin(
    {
      kind: 'mesh',
      cardLayout,
      vertices,
      indices: Uint32Array.from(indices),
      attributes: { position: vertices },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: indices.length,
          vertexCount: positions.length / 3,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'surface' }],
    },
    'card-fixture',
  ).unwrap();
  const loaded = decodeMeshBinary(bytes, [])?.cardLayout;
  if (!loaded) throw new Error('mesh-bin must preserve the cooked card layout before GPU capture');
  return loaded;
}
export async function prepareSdfCardsBaseFixture() {
  const layout = (await buildMeshCardLayout(sdfCubePositions, sdfCubeIndices)).unwrap();
  const field = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 24 })
  ).unwrap();
  const directory = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
  const sources = buildMaterialSourceCatalog(
    await collectMaterialSources([directory], [directory]),
  ).unwrap();
  const asset = Materials.standard({ baseColor: [0.8, 0.4, 0.2, 1], roughness: 0.65, specular: 0 });
  const card = (
    await cookRayMaterial({
      material: 'card',
      table: { card: asset },
      sources,
      context: 'card-capture',
    })
  ).unwrap();
  const ray = (
    await cookRayMaterial({ material: 'card', table: { card: asset }, sources })
  ).unwrap();
  return {
    layout: loadedLayout(sdfCubePositions, sdfCubeIndices, layout),
    field,
    card,
    ray,
    sources,
  };
}

let preparedFixture: ReturnType<typeof buildSdfCardsFixture> | undefined;

/** Coalesce immutable build work; each caller owns an independent POD copy. */
export async function prepareSdfCardsFixture() {
  preparedFixture ??= buildSdfCardsFixture();
  const pending = preparedFixture;
  try {
    return structuredClone(await pending);
  } catch (error) {
    if (preparedFixture === pending) preparedFixture = undefined;
    throw error;
  }
}

async function buildSdfCardsFixture() {
  const { layout, field, card, ray, sources } = await prepareSdfCardsBaseFixture();
  const hollow = (
    await buildMeshDistanceField(
      [...sdfCubePositions, ...sdfCubePositions.map((v) => v * 0.55)],
      [...sdfCubeIndices, ...sdfCubeIndices.map((v) => v + 8).reverse()],
      { resolution: 24 },
    )
  ).unwrap();
  const hollowLayout = (
    await buildMeshCardLayout(
      [...sdfCubePositions, ...sdfCubePositions.map((v) => v * 0.55)],
      [...sdfCubeIndices, ...sdfCubeIndices.map((v) => v + 8).reverse()],
      { resolution: 24 },
    )
  ).unwrap();
  const texturedAsset = Materials.standard({
    baseColor: [0.8, 0.4, 0.2, 1],
    roughness: 0.65,
    metallic: 0.25,
    specular: 0.5,
    emissive: [1, 0.5, 0.25],
    emissiveIntensity: 2,
    baseColorTexture: { texture: 'checker', sampler: 'nearest', coordinates: { set: 1 } },
  });
  const textured = {
    card: (
      await cookRayMaterial({
        material: 'texture',
        table: { texture: texturedAsset },
        sources,
        context: 'card-capture',
      })
    ).unwrap(),
    ray: (
      await cookRayMaterial({ material: 'texture', table: { texture: texturedAsset }, sources })
    ).unwrap(),
  };
  const normalAsset = Materials.standard({
    baseColor: [0.8, 0.4, 0.2, 1],
    roughness: 0.65,
    specular: 0,
    normalTexture: { texture: 'normal', sampler: 'nearest', coordinates: { set: 0 } },
  });
  const normalMap = {
    card: (
      await cookRayMaterial({
        material: 'normal',
        table: { normal: normalAsset },
        sources,
        context: 'card-capture',
      })
    ).unwrap(),
    ray: (
      await cookRayMaterial({ material: 'normal', table: { normal: normalAsset }, sources })
    ).unwrap(),
  };
  const sheetPositions = [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0];
  const sheetIndices = [0, 1, 2, 1, 3, 2];
  const sheetField = (
    await buildMeshDistanceField(sheetPositions, sheetIndices, { resolution: 24, twoSided: true })
  ).unwrap();
  const loadedSheetField = (
    await decodeMeshDistanceField(
      (await encodeMeshDistanceField(sheetField)).unwrap(),
      sheetField.meshDigest,
    )
  ).unwrap();
  const sheet = {
    field: {
      ...loadedSheetField,
      bricks: Array.from(loadedSheetField.bricks),
      values: Array.from(loadedSheetField.values),
    },
    positions: sheetPositions,
    indices: sheetIndices,
    one: (await buildMeshCardLayout(sheetPositions, sheetIndices)).unwrap(),
    two: (
      await buildMeshCardLayout(sheetPositions, sheetIndices, {
        triangleSidedness: new Uint8Array(sheetIndices.length / 3).fill(1),
      })
    ).unwrap(),
    materials: await Promise.all(
      [false, true].map(async (masked) => {
        const asset = Materials.standard({
          renderState: { cullMode: 'none' },
          baseColor: [0.8, 0.4, 0.2, 1],
          roughness: 0.65,
          specular: 0,
          ...(masked
            ? { alphaCutoff: 0.5, baseColorTexture: { texture: 'coverage', sampler: 'nearest' } }
            : {}),
        });
        return (
          await cookRayMaterial({
            material: 'sheet',
            table: { sheet: asset },
            sources,
            context: 'card-capture',
          })
        ).unwrap();
      }),
    ),
  };
  const layerPositions = [
    -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1, -1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0,
  ];
  const layerIndices = [0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6];
  const projection = {
    origin: [-1, 1, 2] as const,
    u: [1, 0, 0] as const,
    v: [0, -1, 0] as const,
    n: [0, 0, 1] as const,
    width: 2,
    height: 2,
    depth: 4,
  };
  const layers = {
    geometry: { positions: layerPositions, indices: layerIndices },
    layout: {
      ...(await buildMeshCardLayout(layerPositions, layerIndices)).unwrap(),
      cards: [projection],
    },
    backLayout: {
      ...(await buildMeshCardLayout(layerPositions, layerIndices.slice(6))).unwrap(),
      cards: [projection],
    },
  };
  return {
    layers,
    sheet,
    hollowLayout,
    normalMap,
    textured,
    hollow: { ...hollow, bricks: Array.from(hollow.bricks), values: Array.from(hollow.values) },
    layout,
    field: { ...field, bricks: Array.from(field.bricks), values: Array.from(field.values) },
    card,
    ray,
  };
}
export type SdfCardsFixture = Awaited<ReturnType<typeof prepareSdfCardsFixture>>;
export const sdfCardsCommands = { prepareSdfCardsFixture };
