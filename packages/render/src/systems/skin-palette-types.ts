import type { Buffer } from '@forgeax/engine-rhi';

/**
 * Per-draw palette slice metadata shared by the extract producer and the
 * palette allocator. The slice carries the buffer identity so storage and
 * uniform fallback paths converge at the record binding owner.
 */
export interface SkinPaletteSlice {
  readonly jointCount: number;
  /** Byte offset into buffer; uniform fallback slices always use zero. */
  readonly byteOffset: number;
  /** GPU buffer containing the slice's joint matrices. */
  readonly buffer: Buffer;
}
