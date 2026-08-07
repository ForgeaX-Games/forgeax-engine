const DATA_URI_BASE64_RE = /^data:[^;,]*(?:;[^,;]+)*;base64,(.*)$/;

export function dataUriBase64Payload(uri: string): string | undefined {
  const match = DATA_URI_BASE64_RE.exec(uri);
  return match === null ? undefined : (match[1] ?? '');
}

export function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
