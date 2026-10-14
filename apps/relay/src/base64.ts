/**
 * Encodes a Uint8Array to base64 using btoa.
 * Workers-safe, no Buffer.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decodes a base64 string to Uint8Array using atob.
 * Workers-safe, no Buffer.
 */
export function base64ToBytes(s: string): Uint8Array {
  const binary = atob(s);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
