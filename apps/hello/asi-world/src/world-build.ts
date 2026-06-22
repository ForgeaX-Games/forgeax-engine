// World-data conversion: read the asi_world JSON shapes we already mirror in
// ./types.ts, return:
//   - layers : { heightKey, layerOrder, tiles: Uint32Array(cols*rows) } per
//     terrain height bucket; one TileLayer per height. Within a single
//     bucket the topmost graphic_index for each (x, y) wins (asi_world
//     cells already only carry the on-screen index).
//   - regions / tilesetTiles : 1:1 from the .tsj file, which is the SSOT
//     of the atlas rectangle layout.
//   - passable : Uint8Array(cols*rows); 1 = walkable. Built from terrain.json
//     plus terrain-config.json (`passability.category`). Multi-height
//     stacking collapses to "blocked if ANY layer at this cell is blocked"
//     — matches asi_world's `cellMobilityArbitration.blockedRule = anyLayerImpassable`.

import type {
  ObjectTypeConfigFile,
  TerrainConfigFile,
  TerrainFile,
  TerrainObject,
  TsjFile,
  TsjTile,
} from './types';

export interface BuiltLayer {
  readonly heightKey: string;
  readonly layerOrder: number;
  readonly tiles: Uint32Array;
}

export interface BuiltWorld {
  readonly cols: number;
  readonly rows: number;
  readonly tileSize: number;
  readonly layers: readonly BuiltLayer[];
  readonly passable: Uint8Array;
  readonly objects: readonly PlacedObject[];
}

export interface PlacedObject {
  readonly tile: TsjTile;
  readonly cellX: number;
  readonly cellY: number;
  readonly typeId: string;
  readonly blocksMovement: boolean;
}

const HEIGHT_LAYER_BASE = 100;

export function buildWorld(args: {
  terrain: TerrainFile;
  terrainConfig: TerrainConfigFile;
  terrainTsj: TsjFile;
  objectTsj: TsjFile;
  objectTypes: ObjectTypeConfigFile;
}): BuiltWorld {
  const { terrain, terrainConfig, terrainTsj, objectTsj, objectTypes } = args;
  const cols = terrain.cols;
  const rows = terrain.rows;
  const tileSize = terrainTsj.tilewidth;

  const passable = new Uint8Array(cols * rows);
  passable.fill(1);

  const heightKeys = Object.keys(terrain.cells).sort(
    (a, b) => Number(a) - Number(b),
  );
  const layers: BuiltLayer[] = [];
  for (const heightKey of heightKeys) {
    const cellsAtHeight = terrain.cells[heightKey] ?? [];
    const tiles = new Uint32Array(cols * rows);
    for (const cell of cellsAtHeight) {
      if (cell.x < 0 || cell.x >= cols || cell.y < 0 || cell.y >= rows) continue;
      // graphic_index is an array (one entry per stacked sub-layer at this
      // cell); the TOPMOST entry is what asi_world renders on top, so we
      // pick the last one. id+1 because we reserve id=0 as 'transparent'
      // (forgeax tilemap convention; tile id 0 yields a transparent cell).
      const idx = cell.graphic_index.length > 0
        ? cell.graphic_index[cell.graphic_index.length - 1]
        : undefined;
      if (idx === undefined) continue;
      tiles[cell.y * cols + cell.x] = idx + 1;

      // Terrain passability: any sub-layer impassable = blocked.
      for (const tplName of cell.template_id) {
        const tpl = terrainConfig.templates[tplName];
        if (tpl?.passability?.category === 'impassable') {
          passable[cell.y * cols + cell.x] = 0;
          break;
        }
      }
    }
    const heightNum = Number(heightKey);
    // height -99 in asi_world is a "sunken" floor — render below default 0.
    // Otherwise stack so taller heights paint over lower ones.
    const layerOrder = heightNum === -99
      ? -HEIGHT_LAYER_BASE
      : heightNum * HEIGHT_LAYER_BASE;
    layers.push({ heightKey, layerOrder, tiles });
  }

  const objectTilesById = new Map<number, TsjTile>();
  for (const t of objectTsj.tiles) objectTilesById.set(t.id, t);

  const placed: PlacedObject[] = [];
  for (const obj of terrain.objects) {
    const otype = objectTypes.types[obj.typeId];
    if (!otype) continue;
    const tile = objectTilesById.get(otype.graphic);
    if (!tile) continue;
    if (obj.x < 0 || obj.x >= cols || obj.y < 0 || obj.y >= rows) continue;
    const blocks = otype.passability?.blocksMovement === true
      || tileBlocksByCollider(tile);
    placed.push({
      tile,
      cellX: obj.x,
      cellY: obj.y,
      typeId: obj.typeId,
      blocksMovement: blocks,
    });
    if (blocks) {
      // mark the cells covered by the object's collider rect.
      stampObjectFootprint(passable, cols, rows, obj, tile);
    }
  }

  return { cols, rows, tileSize, layers, passable, objects: placed };
}

function tileBlocksByCollider(tile: TsjTile): boolean {
  // Closed-enum exhaustive switch (charter P3): no silent fallthrough on
  // unknown collider.type. Each variant produces a definite boolean.
  const c = tile.collider;
  switch (c.type) {
    case 'none':
      return false;
    case 'rect': {
      const [, , w, h] = c.rect;
      // Treat objects with a non-trivial collider rect as solid by default.
      // Tiny dust/grass colliders (< 0.25 of the tile) stay walkable so the
      // map doesn't become a wall of bushes.
      return w > 0.25 && h > 0.25;
    }
    case 'polygon': {
      // Polygons in asi_world tag complex non-rect shapes (tree canopies /
      // angled rocks). Any polygon with >= 3 points is treated as solid;
      // a 3-vertex collider already implies a non-trivial footprint.
      return c.points.length >= 3;
    }
  }
}

function stampObjectFootprint(
  passable: Uint8Array,
  cols: number,
  rows: number,
  obj: TerrainObject,
  tile: TsjTile,
): void {
  // Polygon colliders take the rect-bbox approximation (foot stamp only
  // needs to block movement; pixel-accurate collision is the consumer's
  // job — out of scope here).
  if (tile.collider.type === 'none') return;
  const [rx, ry, rw, rh] =
    tile.collider.type === 'rect' ? tile.collider.rect : polygonBbox(tile.collider.points);
  // tile.{width,height} are atlas pixels; the object footprint in cells is
  // (width/16) × (height/16). The collider rect is normalized inside the
  // tile bounds. Pivot.y is from the bottom (asi_world convention), so the
  // foot-anchor cell at (obj.x, obj.y) sits at the bottom of the sprite.
  const cellsW = Math.max(1, Math.round(tile.width / 16));
  const cellsH = Math.max(1, Math.round(tile.height / 16));
  const colliderColsF = rw * cellsW;
  const colliderRowsF = rh * cellsH;
  const colliderCols = Math.max(1, Math.ceil(colliderColsF));
  const colliderRows = Math.max(1, Math.ceil(colliderRowsF));
  const startCol = obj.x + Math.floor(rx * cellsW) - Math.floor(cellsW / 2);
  const startRow = obj.y - colliderRows + 1 + Math.floor(ry * cellsH);
  for (let dy = 0; dy < colliderRows; dy++) {
    for (let dx = 0; dx < colliderCols; dx++) {
      const cx = startCol + dx;
      const cy = startRow + dy;
      if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
      passable[cy * cols + cx] = 0;
    }
  }
}

function polygonBbox(
  points: readonly (readonly [number, number])[],
): readonly [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of points) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

export function pickFloorSpawnCell(world: BuiltWorld): { cellX: number; cellY: number } {
  // Walk from the centre outward until we find a passable cell.
  const cx0 = Math.floor(world.cols / 2);
  const cy0 = Math.floor(world.rows / 2);
  const maxR = Math.max(world.cols, world.rows);
  for (let r = 0; r < maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const cx = cx0 + dx;
        const cy = cy0 + dy;
        if (cx < 0 || cx >= world.cols || cy < 0 || cy >= world.rows) continue;
        if (world.passable[cy * world.cols + cx] === 1) {
          return { cellX: cx, cellY: cy };
        }
      }
    }
  }
  return { cellX: cx0, cellY: cy0 };
}
