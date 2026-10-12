import { useCallback, useEffect, useRef, useState } from "react";
import type { Envelope, MessageKind, DeviceRole } from "@bimax/protocol";
import { RelayClient, type ClientStatus, type WsImpl } from "./client";

export function useRelay(opts: {
  url: string;
  deviceId: string;
  role: DeviceRole;
  enabled: boolean;
  onMessage?: (env: Envelope<MessageKind, unknown>) => void;
}): { status: ClientStatus; send: (env: Envelope<MessageKind, unknown>) => void } {
  const [status, setStatus] = useState<ClientStatus>("offline");
  const clientRef = useRef<RelayClient | null>(null);
  const onMessageRef = useRef(opts.onMessage);
  onMessageRef.current = opts.onMessage;

  const { url, deviceId, role, enabled } = opts;

  useEffect(() => {
    if (!enabled) {
      setStatus("offline");
      return;
    }

    const client = new RelayClient({
      url,
      deviceId,
      role,
      wsImpl: ((): WsImpl => {
        if (typeof WebSocket === "undefined") {
          throw new Error("useRelay: global WebSocket is not available");
        }
        return WebSocket as unknown as WsImpl;
      })(),
      onMessage: (env) => {
        onMessageRef.current?.(env);
      },
      onStatus: (s) => {
        setStatus(s);
      },
    });

    clientRef.current = client;
    client.connect();

    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [url, deviceId, role, enabled]);

  const send = useCallback((env: Envelope<MessageKind, unknown>) => {
    clientRef.current?.send(env);
  }, []);

  return { status, send };
}
