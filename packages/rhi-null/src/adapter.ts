// @forgeax/engine-rhi-null/src/adapter - headless adapter.
//
// requestDevice mints a fresh RhiNullDevice, wiring its queue + command-encoder
// factory. features / limits are empty (the headless backend enables nothing
// beyond the always-true caps profile); the two-step requestAdapter ->
// requestDevice path mirrors the spec idiom (research Finding A1 row 2).
//
// Related: requirements AC-02 (createRenderer ready chain needs adapter ->
// device) + AC-12; research Finding A1 row 2.

import type {
  RequestDeviceOptions,
  Result,
  RhiAdapter,
  RhiDevice,
  RhiError as RhiErrorType,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { RhiNullCommandEncoder } from './command-encoder';
import { RhiNullDevice } from './device';
import { RhiNullQueue } from './queue';

/** Headless adapter. Holds an empty feature set + limits map; requestDevice
 *  builds a fully-wired RhiNullDevice. */
export class RhiNullAdapter implements RhiAdapter {
  readonly features: ReadonlySet<GPUFeatureName> = new Set();
  readonly limits: Readonly<Record<string, number>> = {};

  // forgeax-async-whitelist is not needed: this returns Promise<Result<...>>
  // per the spec contract; never rejects.
  requestDevice(
    _opts?: RequestDeviceOptions | undefined,
  ): Promise<Result<RhiDevice, RhiErrorType>> {
    const device = new RhiNullDevice(
      new RhiNullQueue(),
      (bookkeeper, dev) => new RhiNullCommandEncoder(bookkeeper, dev),
    );
    return Promise.resolve(ok(device));
  }
}
