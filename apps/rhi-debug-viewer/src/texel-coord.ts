// texel-coord.ts — coordinate mapping from canvas pixel to texel under
// zoom + object-fit contain (D-4).
//
// Zoom is either 'fit' (object-fit contain) or a number (scale factor).
// The canvas CSS dimensions may differ from the texture's native drawing-buffer
// size; this module translates a canvas-relative mouse offset to the texel
// (floor to integer pixel index). Returns null for letterbox/OOB pixels.

export type Zoom = 'fit' | number;

export interface TexelCoord {
  readonly x: number;
  readonly y: number;
}

/**
 * Map a canvas-relative pixel coordinate to the texel it targets.
 * @param mouseX - Horizontal offset within the canvas element.
 * @param mouseY - Vertical offset within the canvas element.
 * @param canvasW - CSS / rendered width of the canvas element.
 * @param canvasH - CSS / rendered height of the canvas element.
 * @param texW - Native texture width (pixels).
 * @param texH - Native texture height (pixels).
 * @param zoom - Current zoom mode.
 * @returns The texel (x,y) or null when the pixel is OOB / letterbox.
 */
export function canvasToTexel(
  mouseX: number,
  mouseY: number,
  canvasW: number,
  canvasH: number,
  texW: number,
  texH: number,
  zoom: Zoom,
): TexelCoord | null {
  if (texW <= 0 || texH <= 0) return null;

  let scale: number;
  let offsetX: number;
  let offsetY: number;

  if (zoom === 'fit') {
    // object-fit contain: scale by the smaller axis.
    scale = Math.min(canvasW / texW, canvasH / texH);
    offsetX = (canvasW - texW * scale) / 2;
    offsetY = (canvasH - texH * scale) / 2;
  } else {
    scale = zoom;
    offsetX = 0;
    offsetY = 0;
  }

  const texX = (mouseX - offsetX) / scale;
  const texY = (mouseY - offsetY) / scale;

  // Outside the displayed texture → letterbox / OOB.
  if (texX < 0 || texX >= texW || texY < 0 || texY >= texH) return null;

  return { x: Math.floor(texX), y: Math.floor(texY) };
}
