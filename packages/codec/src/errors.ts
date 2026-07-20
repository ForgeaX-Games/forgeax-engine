/**
 * Codec error model — closed union per D-8.
 *
 * All codec error codes live here as the SSOT. Runtime never extends the types
 * shared union; codec errors are nested in existing asset error detail.
 *
 * Union is order-locked and add-only-minor for Loop 2 additions.
 */

/** Order-locked closed union of codec error codes. */
export type CodecErrorCode =
  | 'decompression-failed'
  | 'codec-init-failed'
  | 'ktx2-parse-failed'
  | 'ktx2-unsupported-scheme'
  | 'transcode-failed'
  | 'ktx2-encode-failed';

/** Per-code narrowed detail payloads. */
export interface CodecErrorDetails {
  'decompression-failed': { readonly reason: string };
  'codec-init-failed': { readonly stage: string };
  'ktx2-parse-failed': { readonly reason: string };
  'ktx2-unsupported-scheme': { readonly scheme: number };
  'transcode-failed': { readonly sourceFormat: string; readonly targetFormat: string };
  'ktx2-encode-failed': { readonly mode: string; readonly reason: string };
}

/** Structured codec error with executable hint + per-code narrowed detail. */
export interface CodecError {
  readonly ok: false;
  readonly error: {
    readonly code: CodecErrorCode;
    readonly expected: string;
    readonly hint: string;
    readonly detail: CodecErrorDetails[CodecErrorCode];
  };
}

/** Success branch of a Result<T, CodecError>. */
export interface CodecOk<T> {
  readonly ok: true;
  readonly value: T;
}

/** Result type for codec operations — discriminated union on `.ok`. */
export type CodecResult<T> = CodecOk<T> | CodecError;

/** Error factory — produces a full CodecError object for the given code + detail. */
export function codecError<C extends CodecErrorCode>(
  code: C,
  detail: CodecErrorDetails[C],
): CodecError {
  const hints: Record<CodecErrorCode, string> = {
    'decompression-failed':
      'Check catalog row compression field and asset binary consistency; re-run asset import.',
    'codec-init-failed':
      'Uncompressed assets are still loadable. Verify the codec module is installed correctly.',
    'ktx2-parse-failed':
      'Check that the KTX2 file is valid and not truncated. Re-import the texture asset.',
    'ktx2-unsupported-scheme':
      'This supercompression scheme requires a future codec upgrade. Check the codec README Loop 2 extension points.',
    'transcode-failed':
      'Basis transcode failed for this source/target format pair. Verify the KTX2 payload is a valid Basis (ETC1S / UASTC) texture and re-import the asset.',
    'ktx2-encode-failed':
      'Basis encode failed for this compression mode. Verify the source image dimensions / pixel format match the mode (LDR rgba8 vs HDR rgba16float) and retry the asset import.',
  };

  return {
    ok: false,
    error: {
      code,
      expected: 'valid compressed data or supported compression scheme',
      hint: hints[code],
      detail,
    },
  };
}
