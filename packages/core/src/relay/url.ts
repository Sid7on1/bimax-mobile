/** Validate before opening a socket or trusting a QR. Plain WS is confined to explicit LAN addresses. */
export function validateRelayUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const parts = host.split(".").map(Number);
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) && parts.every((n) => n >= 0 && n <= 255);
  const local =
    host === "localhost" ||
    host === "[::1]" ||
    (ipv4 &&
      (parts[0] === 127 ||
        parts[0] === 10 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168)));
  if (
    !value ||
    value.length > 4096 ||
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "wss:" && !(url.protocol === "ws:" && local))
  )
    throw new Error("Relay requires WSS, or WS at a local network address");
  return url.toString();
}
