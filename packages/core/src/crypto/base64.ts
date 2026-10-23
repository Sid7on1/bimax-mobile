const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const REV_TABLE = new Int16Array(256).fill(-1);
for (let i = 0; i < TABLE.length; i++) {
  REV_TABLE[TABLE.charCodeAt(i)] = i;
}

/**
 * Encodes a Uint8Array to standard Base64 string (with padding '=').
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("bytesToBase64: input must be a Uint8Array");
  }

  let result = "";
  const len = bytes.length;
  let i = 0;

  for (; i + 2 < len; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    result += TABLE[b0 >> 2];
    result += TABLE[((b0 & 3) << 4) | (b1 >> 4)];
    result += TABLE[((b1 & 15) << 2) | (b2 >> 6)];
    result += TABLE[b2 & 63];
  }

  if (i < len) {
    const b0 = bytes[i];
    if (i + 1 < len) {
      const b1 = bytes[i + 1];
      result += TABLE[b0 >> 2];
      result += TABLE[((b0 & 3) << 4) | (b1 >> 4)];
      result += TABLE[(b1 & 15) << 2];
      result += "=";
    } else {
      result += TABLE[b0 >> 2];
      result += TABLE[(b0 & 3) << 4];
      result += "==";
    }
  }

  return result;
}

/**
 * Decodes a standard Base64 string to Uint8Array.
 * Throws Error on invalid characters, invalid length, or bad padding.
 */
export function base64ToBytes(s: string): Uint8Array {
  if (typeof s !== "string") {
    throw new Error("base64ToBytes: input must be a string");
  }

  if (s.length === 0) {
    return new Uint8Array(0);
  }

  if (s.length % 4 !== 0) {
    throw new Error("base64ToBytes: invalid base64 string length (must be a multiple of 4)");
  }

  let padding = 0;
  if (s[s.length - 1] === "=") {
    padding++;
    if (s[s.length - 2] === "=") {
      padding++;
    }
  }

  // Ensure '=' does not appear before the end
  const firstEq = s.indexOf("=");
  if (firstEq !== -1 && firstEq < s.length - padding) {
    throw new Error("base64ToBytes: invalid padding placement");
  }

  const outputLen = (s.length / 4) * 3 - padding;
  const out = new Uint8Array(outputLen);
  let outIdx = 0;

  for (let i = 0; i < s.length; i += 4) {
    const c0 = s.charCodeAt(i);
    const c1 = s.charCodeAt(i + 1);
    const c2 = s.charCodeAt(i + 2);
    const c3 = s.charCodeAt(i + 3);

    const v0 = c0 < 256 ? REV_TABLE[c0] : -1;
    const v1 = c1 < 256 ? REV_TABLE[c1] : -1;
    if (v0 === -1 || v1 === -1) {
      throw new Error(`base64ToBytes: invalid base64 character in chunk at index ${i}`);
    }

    const isLastChunk = i + 4 === s.length;

    if (isLastChunk && padding === 2) {
      if (c2 !== 61 || c3 !== 61) {
        throw new Error("base64ToBytes: invalid padding characters");
      }
      out[outIdx++] = (v0 << 2) | (v1 >> 4);
    } else if (isLastChunk && padding === 1) {
      const v2 = c2 < 256 ? REV_TABLE[c2] : -1;
      if (v2 === -1 || c3 !== 61) {
        throw new Error("base64ToBytes: invalid base64 character or padding in last chunk");
      }
      out[outIdx++] = (v0 << 2) | (v1 >> 4);
      out[outIdx++] = ((v1 & 15) << 4) | (v2 >> 2);
    } else {
      const v2 = c2 < 256 ? REV_TABLE[c2] : -1;
      const v3 = c3 < 256 ? REV_TABLE[c3] : -1;
      if (v2 === -1 || v3 === -1) {
        throw new Error(`base64ToBytes: invalid base64 character in chunk at index ${i}`);
      }
      out[outIdx++] = (v0 << 2) | (v1 >> 4);
      out[outIdx++] = ((v1 & 15) << 4) | (v2 >> 2);
      out[outIdx++] = ((v2 & 3) << 6) | v3;
    }
  }

  return out;
}
