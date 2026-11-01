import type { WebSocketLike, WsImpl } from "./client";

export type NativeWebSocketConstructor = new (
  url: string,
  protocols?: string[],
  options?: { headers: { Origin: string } },
) => WebSocketLike;

/**
 * RN's iOS SocketRocket/Android adapters synthesize an HTTP Origin. Native LAN
 * clients have no browser origin; explicitly clear that header using RN's native
 * constructor option. Browser constructors cannot override their real Origin and
 * the relay still rejects it. Cloud sockets keep their existing defaults.
 */
export function relaySocketConstructor(
  Implementation: NativeWebSocketConstructor,
  native: boolean,
): WsImpl {
  if (!native) return Implementation;
  return class NativeRelaySocket extends Implementation {
    constructor(url: string) {
      super(url, [], new URL(url).protocol === "ws:" ? { headers: { Origin: "" } } : undefined);
    }
  };
}
