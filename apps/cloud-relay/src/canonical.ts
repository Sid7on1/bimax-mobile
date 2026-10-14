/**
 * Deterministic canonical JSON: recursively sorts object keys, removes all whitespace.
 * Byte-identical semantics to apps/mobile/lib/crypto/keys.ts.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new Error("canonicalJson: cannot serialize undefined");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];

  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && typeof v !== "function" && typeof v !== "symbol") {
      entries.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
    }
  }

  return `{${entries.join(",")}}`;
}
