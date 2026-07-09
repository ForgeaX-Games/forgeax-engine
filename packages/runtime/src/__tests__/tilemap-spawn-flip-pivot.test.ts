// tilemap-spawn-flip-pivot.test - 32 case H/V/D flip x pivot matrix
// (feat-20260608 M2 / m2-t1; plan-strategy §D-2).
//
// Asserts the per-cell entity Transform produced by
// `spawnDerivedRenderEntities` for the multi-cell + custom pivot form:
//
//   basePivotForX = D ? pivotY : pivotX
//   basePivotForY = D ? pivotX : pivotY
//   effectivePivotX = H ? (1 - basePivotForX) : basePivotForX
//   effectivePivotY = V ? (1 - basePivotForY) : basePivotForY
//   posX = (cellX + effectivePivotX + (0.5 - effectivePivotX) * widthCells)
//          * tileSizeX
//   posY = (cellY + effectivePivotY + (0.5 - effectivePivotY) * heightCells)
//          * tileSizeY
//   scaleX = (H ? -1 : 1) * widthCells  * tileSizeX
//   scaleY = (V ? -1 : 1) * heightCells * tileSizeY
//   quatZ  = D ? Math.SQRT1_2 : 0
//   quatW  = D ? Math.SQRT1_2 : 1
//
// The matrix iterates H/V/D in {false, true}^3 (8 combinations) x
// pivot in {0.0, 0.2, 0.5, 0.8} (4 combinations applied to both X and Y) =
// 32 cases. R-3 numerical anchor: V flip x pivotY=0.2, heightCells=4
// drives a 2.4-cell delta in the offset (0.5 - effectivePivotY) *
// heightCells term (1.2 -> -1.2). Total Transform.posY delta versus the
// no-flip form is 1.8 cells (delta-eff + delta-offset = 0.6 - 2.4).
//
// FALSIFY mode `invert-pivot-on-vflip`: the implementation must use
// effectivePivotY = 1 - pivotY under V flip. If a future regression
// breaks that, the same test fails - which is the intended falsifier
// signal (plan-strategy §D-2 + AC-10).
//
// Anchors: plan-tasks m2-t1; plan-strategy §D-2 (formula first-line +
// 32 case matrix); plan-decisions L-3 (pivot ground truth) + L-4
// (`requirements.md §AC-10 falsifier` charter F1 alignment).

import { Entity, World } from '@forgeax/engine-ecs';
import { type TilesetAsset, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ChildOf, encodeSortScope, TileLayer, Tilemap, Transform } from '../components';
import { encodeTileBits } from '../tile-bits';
import {
  resetTilemapChunkExtractCache,
  resetTilemapDerivedEntityTracker,
  tilemapChunkExtractSystem,
} from '../tilemap-chunk-extract-system';

const SQRT1_2 = Math.SQRT1_2;

interface Setup {
  widthCells: number;
  heightCells: number;
  pivotX: number;
  pivotY: number;
  cellX: number;
  cellY: number;
  flipH: boolean;
  flipV: boolean;
  flipDiagonal: boolean;
  tileSizeX: number;
  tileSizeY: number;
}

function expectedTransform(s: Setup): {
  posX: number;
  posY: number;
  scaleX: number;
  scaleY: number;
  quatZ: number;
  quatW: number;
} {
  const basePivotForX = s.flipDiagonal ? s.pivotY : s.pivotX;
  const basePivotForY = s.flipDiagonal ? s.pivotX : s.pivotY;
  const effX = s.flipH ? 1 - basePivotForX : basePivotForX;
  const effY = s.flipV ? 1 - basePivotForY : basePivotForY;
  return {
    posX: (s.cellX + effX + (0.5 - effX) * s.widthCells) * s.tileSizeX,
    posY: (s.cellY + effY + (0.5 - effY) * s.heightCells) * s.tileSizeY,
    scaleX: (s.flipH ? -1 : 1) * s.widthCells * s.tileSizeX,
    scaleY: (s.flipV ? -1 : 1) * s.heightCells * s.tileSizeY,
    quatZ: s.flipDiagonal ? SQRT1_2 : 0,
    quatW: s.flipDiagonal ? SQRT1_2 : 1,
  };
}

function readDerivedTransform(world: World): {
  posX: number;
  posY: number;
  scaleX: number;
  scaleY: number;
  quatZ: number;
  quatW: number;
} {
  type GraphArch = {
    key: string;
    columns: Map<number, Map<string, { view: ArrayLike<number> }>>;
  };
  const graph = (world as unknown as { _getGraph(): { archetypes: GraphArch[] } })._getGraph();
  for (const arch of world.inspect().archetypes) {
    if (!arch.componentNames.includes('Transform')) continue;
    if (!arch.componentNames.includes('MeshFilter')) continue;
    if (!arch.componentNames.includes('Layer')) continue;
    const derived = graph.archetypes.find((a) => a.key === arch.key);
    if (!derived) continue;
    const entityCol = derived.columns.get(Entity.id)?.get('self')?.view as Uint32Array | undefined;
    if (!entityCol) continue;
    for (let i = 0; i < entityCol.length; i++) {
      const e = entityCol[i];
      if (e === undefined || e === 0) continue;
      const t = world.get(e as never, Transform).unwrap();
      return {
        posX: t.posX,
        posY: t.posY,
        scaleX: t.scaleX,
        scaleY: t.scaleY,
        quatZ: t.quatZ,
        quatW: t.quatW,
      };
    }
  }
  throw new Error('expected one derived Transform but found none');
}

function runOneCase(s: Setup): {
  posX: number;
  posY: number;
  scaleX: number;
  scaleY: number;
  quatZ: number;
  quatW: number;
} {
  const world = new World();
  const tileset: TilesetAsset = {
    kind: 'tileset',
    guid: `test/spawn-flip-pivot/${s.flipH ? 'H' : '-'}${s.flipV ? 'V' : '-'}${s.flipDiagonal ? 'D' : '-'}/px${s.pivotX}py${s.pivotY}`,
    atlases: [toShared<'TextureAsset'>(101)],
    tileWidth: 16,
    tileHeight: 16,
    columns: 1,
    rows: 1,
    regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    tiles: [
      {
        regionIndex: 0,
        widthCells: s.widthCells,
        heightCells: s.heightCells,
        pivotX: s.pivotX,
        pivotY: s.pivotY,
      },
    ],
  };
  const tilesetHandle = world.allocSharedRef<'TilesetAsset', TilesetAsset>('TilesetAsset', tileset);
  const cols = Math.max(s.cellX + s.widthCells + 1, 16);
  const rows = Math.max(s.cellY + s.heightCells + 1, 16);
  const tilemap = world
    .spawn(
      {
        component: Tilemap,
        data: {
          cols,
          rows,
          tileSizeX: s.tileSizeX,
          tileSizeY: s.tileSizeY,
          chunkSize: 16,
          tileset: tilesetHandle,
        },
      },
      { component: Transform, data: {} },
    )
    .unwrap();
  const tiles = new Uint32Array(cols * rows);
  tiles[s.cellY * cols + s.cellX] = encodeTileBits(1, s.flipH, s.flipV, s.flipDiagonal, false);
  world.spawn(
    {
      component: TileLayer,
      data: { tiles, layerOrder: 0, dirty: 1, sortScope: encodeSortScope('per-cell') },
    },
    { component: ChildOf, data: { parent: tilemap } },
  );
  resetTilemapChunkExtractCache();
  resetTilemapDerivedEntityTracker();
  tilemapChunkExtractSystem(world, 0);
  return readDerivedTransform(world);
}

describe('spawnDerivedRenderEntities — 32 case H/V/D flip x pivot matrix (M2)', () => {
  const widthCells = 3;
  const heightCells = 4;
  const tileSizeX = 16;
  const tileSizeY = 16;
  const cellX = 5;
  const cellY = 10;
  const pivots = [0.0, 0.2, 0.5, 0.8] as const;

  for (const flipH of [false, true] as const) {
    for (const flipV of [false, true] as const) {
      for (const flipDiagonal of [false, true] as const) {
        for (const pivot of pivots) {
          const tag = `H=${flipH ? 1 : 0} V=${flipV ? 1 : 0} D=${flipDiagonal ? 1 : 0} pivot=${pivot}`;
          it(`case ${tag} matches plan-strategy §D-2 formula`, () => {
            const setup: Setup = {
              widthCells,
              heightCells,
              pivotX: pivot,
              pivotY: pivot,
              cellX,
              cellY,
              flipH,
              flipV,
              flipDiagonal,
              tileSizeX,
              tileSizeY,
            };
            const got = runOneCase(setup);
            const want = expectedTransform(setup);
            expect(got.posX).toBeCloseTo(want.posX, 4);
            expect(got.posY).toBeCloseTo(want.posY, 4);
            expect(got.scaleX).toBeCloseTo(want.scaleX, 4);
            expect(got.scaleY).toBeCloseTo(want.scaleY, 4);
            expect(got.quatZ).toBeCloseTo(want.quatZ, 5);
            expect(got.quatW).toBeCloseTo(want.quatW, 5);
          });
        }
      }
    }
  }

  // R-3 numerical anchor: V flip x pivotY=0.2 must shift the (0.5 - eff)
  // offset by exactly 2.4 cells (0.6 cell-budget x heightCells=4). The
  // total posY delta versus the no-flip form is 1.8 cells (delta-eff =
  // -0.6 cell + delta-offset = -2.4 cell ... wait: posY_vflip - posY_nf
  // = -1.8 cells * tileSize). The 2.4-cell budget below isolates the
  // (0.5 - effectivePivotY) * heightCells term so the falsifier is
  // independent of the (eff - pivot) shift.
  it('R-3 anchor: V flip x pivotY=0.2 offset budget = 2.4 cell', () => {
    const baseSetup: Setup = {
      widthCells,
      heightCells,
      pivotX: 0.5,
      pivotY: 0.2,
      cellX,
      cellY,
      flipH: false,
      flipV: false,
      flipDiagonal: false,
      tileSizeX,
      tileSizeY,
    };
    const noFlipPosY = expectedTransform(baseSetup).posY;
    const vFlipPosY = expectedTransform({ ...baseSetup, flipV: true }).posY;
    const totalDeltaCells = (noFlipPosY - vFlipPosY) / tileSizeY;
    // Total delta = (0.5 - 0.2) * 4 - ((1 - 0.2) - 0.2) - (0.5 - (1-0.2)) * 4
    //             = 1.2 - 0.6 - (-1.2) = 1.8 cells
    expect(totalDeltaCells).toBeCloseTo(1.8, 5);

    const noFlipOffset = (0.5 - 0.2) * heightCells;
    const vFlipOffset = (0.5 - (1 - 0.2)) * heightCells;
    const offsetDeltaCells = noFlipOffset - vFlipOffset;
    expect(offsetDeltaCells).toBeCloseTo(2.4, 5);

    // Round-trip the actual implementation under V flip + pivotY=0.2
    // and confirm the formula-predicted posY matches.
    const got = runOneCase({ ...baseSetup, flipV: true });
    expect(got.posY).toBeCloseTo(vFlipPosY, 4);
  });

  it('unit-cell + center pivot retains the M0 1x1 baseline (AC-14 non-degradation)', () => {
    const got = runOneCase({
      widthCells: 1,
      heightCells: 1,
      pivotX: 0.5,
      pivotY: 0.5,
      cellX: 0,
      cellY: 0,
      flipH: false,
      flipV: false,
      flipDiagonal: false,
      tileSizeX: 16,
      tileSizeY: 16,
    });
    expect(got.posX).toBeCloseTo(0.5 * 16, 5);
    expect(got.posY).toBeCloseTo(0.5 * 16, 5);
    expect(got.scaleX).toBe(16);
    expect(got.scaleY).toBe(16);
    expect(got.quatZ).toBe(0);
    expect(got.quatW).toBe(1);
  });
});
