/** Normalize Node/Vite incoming header values (string | string[]) to a single string. */
export function readRequestHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>> | undefined,
  name: string,
): string | undefined {
  const value = headers?.[name.toLowerCase()];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value[0];
}
