// transform-animation.ts -- pure helper exposing the LO §1.5 demo's
// per-frame Transform mapping as a t-only function so the unit test
// (transform-state.test.ts) can assert field values without booting a
// renderer / canvas / WebGPU. The system fn body in index.ts calls
// `computeTransformAt(elapsedSeconds)` each tick; the renderer reads
// the mutated Transform SoA columns and the engine-internal mat4
// composer turns them into the GPU uniform.
//
// Charter P5 producer / consumer split: the helper produces the field
// values; the system fn consumes them to write Transform columns; the
// engine RenderSystem consumes the columns to compose the world matrix.
//
// LO §1.5 verbatim (from the canonical learnopengl.com chapter):
//   trans = glm::translate(trans, glm::vec3(0.5f, -0.5f, 0.0f));
//   trans = glm::rotate(trans, (float)glfwGetTime(), glm::vec3(0,0,1));
//   trans = glm::scale(trans, glm::vec3(0.5, 0.5, 0.5));
//
// forgeax maps this to the Transform component's 10 f32 SoA columns:
//   posXYZ      = (0.5, -0.5, 0)               (LO translate constant).
//   quatXYZW     = (0, 0, sin(t/2), cos(t/2))   (Z-axis quaternion).
//   scaleXYZ    = sin-pulse 0.5 + 0.5*sin(t*2pi/3) (D-8 / OOS-8 carve-
//                                                   out animates the
//                                                   static glm::vec3(
//                                                   0.5) into a
//                                                   visible pulse).
//
// Plan-decisions L-3: the sin-pulse public formula is documented as
// `0.5 + 0.5 * sin(t * 2 pi / 3)` -- the touch-zero bottom is briefly
// invisible at t = 1.5s mod 3s (per request, OOS-8 already accepts this
// trade off). README "diff with LO" row carries the carve-out note.

import { quat } from '@forgeax/engine-math';

export interface TransformFieldsAt {
  readonly posX: number;
  readonly posY: number;
  readonly posZ: number;
  readonly quatX: number;
  readonly quatY: number;
  readonly quatZ: number;
  readonly quatW: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly scaleZ: number;
}

const PULSE_PERIOD_SECONDS = 3;
const TWO_PI = Math.PI * 2;
const Z_AXIS: Readonly<[number, number, number]> = [0, 0, 1];

/**
 * Compute the LO §1.5 Transform field values at elapsed time `t`
 * (seconds). Pure function -- allocates one `Quat` per call.
 *
 * @param t elapsed seconds since the demo's animation epoch.
 */
export function computeTransformAt(t: number): TransformFieldsAt {
  // LO translate constant.
  const posX = 0.5;
  const posY = -0.5;
  const posZ = 0;

  // LO rotate(t, Z) -> quat.fromAxisAngle(Z_AXIS, t).
  const q = quat.fromAxisAngle(quat.create(), Z_AXIS, t);

  // sin-pulse scale animation (D-8): 0.5 + 0.5 * sin(t * 2 pi / 3).
  const pulse = 0.5 + 0.5 * Math.sin((t * TWO_PI) / PULSE_PERIOD_SECONDS);

  return {
    posX,
    posY,
    posZ,
    quatX: q[0] ?? 0,
    quatY: q[1] ?? 0,
    quatZ: q[2] ?? 0,
    quatW: q[3] ?? 1,
    scaleX: pulse,
    scaleY: pulse,
    scaleZ: pulse,
  };
}
