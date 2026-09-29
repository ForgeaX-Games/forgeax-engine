import type { RhiDevice } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';

import type {
  HealthListenerRegistry,
  LostListenerRegistry,
  RhiErrorListenerRegistry,
} from '../lifecycle';
import type { RhiBackendPack } from './backend-contract';

/**
 * Wire one device's loss promise into the renderer's shared health, error,
 * and lost listener registries. The same helper is used during construction
 * and recovery so a fresh device cannot silently lose the host subscriptions.
 */
export function attachDeviceLostFanout(
  device: RhiDevice,
  pack: RhiBackendPack,
  registries: {
    lostRegistry: LostListenerRegistry;
    errorRegistry: RhiErrorListenerRegistry;
    healthRegistry: HealthListenerRegistry;
    onDeviceLost?: (detail: string) => void;
  },
): void {
  const { lostRegistry, errorRegistry, healthRegistry, onDeviceLost } = registries;
  const lost = pack.instrumentation?.deviceLost?.(device) ?? device.lost;
  lost
    .then((info) => {
      const safe = {
        reason: info?.reason ?? 'unknown',
        message: info?.message ?? '',
      };
      onDeviceLost?.(`device.lost: ${safe.reason}; ${safe.message || '<empty>'}`);
      lostRegistry.fire(safe);
      if (safe.reason !== 'destroyed') {
        pack.instrumentation?.onDeviceLost?.();
        healthRegistry.fire({
          reason: 'device-lost',
          detail: { lostReason: safe.reason, message: safe.message },
          recoverable: true,
        });
        if (pack.translateErrorEventToRhiError) {
          const translated = pack.translateErrorEventToRhiError(safe);
          errorRegistry.fire(translated.error);
        } else {
          errorRegistry.fire(
            new RhiError({
              code: 'device-lost',
              expected:
                'device must remain alive (driver / browser must not destroy the GPUDevice)',
              hint: `device-lost reason: ${safe.reason}; message: ${safe.message || '<empty>'}`,
            }),
          );
        }
      }
    })
    .catch((error: unknown) => {
      pack.instrumentation?.onDeviceLost?.();
      onDeviceLost?.(`device.lost rejected: ${String(error)}`);
      lostRegistry.fire({ reason: 'unknown', message: String(error) });
      healthRegistry.fire({
        reason: 'device-lost',
        detail: { lostReason: 'unknown', message: String(error) },
        recoverable: true,
      });
      errorRegistry.fire(
        new RhiError({
          code: 'device-lost',
          expected: 'device.lost Promise resolves with GPUDeviceLostInfo',
          hint: `device.lost Promise rejected unexpectedly: ${String(error)}`,
        }),
      );
    });
}
