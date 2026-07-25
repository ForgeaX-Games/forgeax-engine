const GPU_CODES = new Set([
  'adapter-unavailable',
  'feature-not-enabled',
  'limit-exceeded',
  'rhi-not-available',
  'device-lost',
  'oom',
]);
export function classifyEnvErrorReason(
  base: string,
  primary: { code?: unknown; name?: unknown } | undefined,
): string {
  if (!primary || typeof primary !== 'object') return base;
  const code = primary.code;
  if (typeof code === 'string' && GPU_CODES.has(code)) return base;
  const name = typeof primary.name === 'string' ? primary.name : 'inner';
  return typeof code === 'string' && code.length > 0
    ? `engine init failed (${name}: ${code})`
    : `engine init failed (${name})`;
}
export function composeEnvErrorHint(webgpuError: unknown, wgpuError: unknown): string | undefined {
  const a = (webgpuError as { code?: unknown } | undefined)?.code;
  const b = (wgpuError as { code?: unknown } | undefined)?.code;
  if (
    (a === 'adapter-unavailable' || a === 'rhi-not-available') &&
    (b === 'adapter-unavailable' || b === 'rhi-not-available')
  )
    return 'both channels report environmental failure';
  return undefined;
}
