// Outer-message classifier for `EngineEnvironmentError`. Split out of
// createRenderer.ts so it can be unit-tested without booting the renderer.
//
// Why: `createRenderer` wraps Channel 2 / Channel 3 backend failures in a
// single `EngineEnvironmentError("no usable rendering backend", { ... })`.
// When the inner failure is genuinely GPU-class (`adapter-unavailable`,
// `feature-not-enabled`, ...) that wording is correct. When the inner
// failure is `ShaderError(manifest-malformed)` / `PackError` / `AssetError`
// the same wording sends downstream investigation chasing GPU adapter caps
// for hours -- exactly what happened in the 2026-06-09 Studio diagnosis
// (see `docs/feedbacks/2026-06-09-webkit-hdr-pipeline-runs-on-safari-26-release.md`).
//
// The classifier preserves the GPU wording for genuine adapter / device /
// feature / limit / OOM / device-lost failures and switches to
// `engine init failed (<Name>: <code>)` for everything else, so an AI user
// reading either `error.message` (text) or the structured `.detail` lands
// on the right hypothesis at first glance.

const ENV_GPU_CLASS_RHI_CODES: ReadonlySet<string> = new Set([
  'adapter-unavailable',
  'feature-not-enabled',
  'limit-exceeded',
  'rhi-not-available',
  'device-lost',
  'oom',
]);

/**
 * Pick an outer EngineEnvironmentError message based on the inner failure shape.
 *
 * @param baseGpuMessage  The historical GPU-class wording, e.g.
 *                        `'no usable rendering backend'` or
 *                        `'no usable rendering backend (Channel 3 fallback failed)'`.
 *                        Returned verbatim for GPU-class inner errors.
 * @param primary         The inner error (RhiError / ShaderError / PackError /
 *                        AssetError / raw Error / undefined). Inspected
 *                        structurally; never narrowed to a class.
 * @returns               The chosen outer message string.
 */
export function classifyEnvErrorReason(
  baseGpuMessage: string,
  primary: { code?: unknown; name?: unknown } | undefined,
): string {
  if (!primary || typeof primary !== 'object') return baseGpuMessage;
  const code = (primary as { code?: unknown }).code;
  if (typeof code === 'string' && ENV_GPU_CLASS_RHI_CODES.has(code)) {
    return baseGpuMessage;
  }
  const name =
    typeof (primary as { name?: unknown }).name === 'string'
      ? (primary as { name: string }).name
      : 'inner';
  if (typeof code === 'string' && code.length > 0) {
    return `engine init failed (${name}: ${code})`;
  }
  return `engine init failed (${name})`;
}

/**
 * bug-20260610-edge-webgpu-disabled-fallback: detect the
 * "browser is configured to disable hardware GPU acceleration" pattern.
 *
 * Symptom (observed on Edge 149 with `edge://flags/#enable-unsafe-webgpu = Disabled`):
 *   - `navigator.gpu` is truthy (Edge keeps the property for compat sniffing)
 *   - `canvas.getContext('webgpu')` returns a non-null context (also sniffing-compat)
 *   - `navigator.gpu.requestAdapter()` returns `null` (the real "off" signal)
 *   - All WebGL contexts (`webgl`, `webgl2`, `experimental-webgl`) return `null`
 *     globally — Edge ties the WebGPU flag to the entire hardware GL stack.
 *   - Only Canvas2D survives.
 *
 * Engine result: Channel 2 (rhi-webgpu) fails with `adapter-unavailable`; Channel 3
 * (rhi-wgpu wasm GL backend) fails with `adapter-unavailable` because the wasm
 * backend cannot create a WebGL2 context. Both inner errors are GPU-class so
 * `classifyEnvErrorReason` (correctly) keeps the GPU wording on the outer
 * message — but a downstream AI user needs to know **this is a browser-config
 * issue, not a real GPU absence**.
 *
 * The pattern is Channel-2-error.code='adapter-unavailable' AND Channel-3-error
 * also surfaces `adapter-unavailable` / `rhi-not-available` (i.e. *both*
 * channels report environmental failure rather than asset / shader / pipeline
 * errors). When matched, append browser-config guidance to the outer message
 * so it lands in `error.message` and the bootstrap report.
 *
 * Returns `undefined` when the pattern does not match — the caller composes
 * the existing `(reason)` message verbatim (zero-regression for every
 * non-Edge-flag-disabled scenario).
 */
const ENV_DUAL_CHANNEL_ENV_FAIL_CODES: ReadonlySet<string> = new Set([
  'adapter-unavailable',
  'rhi-not-available',
]);

export function composeEnvErrorHint(webgpuError: unknown, wgpuError: unknown): string | undefined {
  const c1 = (webgpuError as { code?: unknown } | undefined)?.code;
  const c2 = (wgpuError as { code?: unknown } | undefined)?.code;
  const w1 = typeof c1 === 'string' ? c1 : undefined;
  const w2 = typeof c2 === 'string' ? c2 : undefined;
  if (w1 === undefined || w2 === undefined) return undefined;
  if (!ENV_DUAL_CHANNEL_ENV_FAIL_CODES.has(w1)) return undefined;
  if (!ENV_DUAL_CHANNEL_ENV_FAIL_CODES.has(w2)) return undefined;
  return [
    'both channels report environmental failure',
    'on Edge: check edge://flags/#enable-unsafe-webgpu is Enabled (Disabled also blocks WebGL2 in 149+)',
    'on Chrome/Firefox: re-enable hardware acceleration in browser settings',
  ].join('; ');
}

/** Test-only export — keeps the public API surface limited to the named functions above. */
export const __classifyEnvErrorReasonForTest = classifyEnvErrorReason;
export const __composeEnvErrorHintForTest = composeEnvErrorHint;
