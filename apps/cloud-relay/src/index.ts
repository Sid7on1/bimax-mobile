import { jwtVerify } from "jose";
/// <reference types="@cloudflare/workers-types" />
import { Room } from "./room";

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace;
  RELAY_TICKET_SECRET: string;
}

const ROOM_PATH_REGEX = /^\/room\/([A-Za-z0-9_-]{1,128})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const ok = (env.RELAY_TICKET_SECRET?.length ?? 0) >= 32;
      return Response.json({ ok }, { status: ok ? 200 : 503 });
    }
    const match = url.pathname.match(ROOM_PATH_REGEX);
    if (!match) {
      return new Response("Not Found", { status: 404 });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 400 });
    }

    const roomId = match[1];
    if (!env.RELAY_TICKET_SECRET || env.RELAY_TICKET_SECRET.length < 32)
      return new Response("Admission unavailable", { status: 503 });
    let deviceId: string, role: string, helloPubkey: string;
    try {
      const { payload } = await jwtVerify(
        url.searchParams.get("ticket") ?? "",
        new TextEncoder().encode(env.RELAY_TICKET_SECRET),
        {
          algorithms: ["HS256"],
          issuer: "bimax-gateway",
          audience: "bimax-relay",
          requiredClaims: ["sub", "exp", "iat"],
        },
      );
      if (
        payload.roomId !== roomId ||
        typeof payload.deviceId !== "string" ||
        !["desktop", "mobile"].includes(String(payload.role)) ||
        typeof payload.helloPubkey !== "string" ||
        !/^[A-Za-z0-9+/]{43}=$/.test(payload.helloPubkey)
      )
        throw new Error("Wrong room");
      deviceId = payload.deviceId;
      role = String(payload.role);
      helloPubkey = payload.helloPubkey;
    } catch {
      return new Response("Room admission required", { status: 401 });
    }
    const id = env.ROOM.idFromName("room:" + roomId);
    const stub = env.ROOM.get(id);
    // Strip bearer material before forwarding; clients cannot spoof these headers.
    url.searchParams.delete("ticket");
    const headers = new Headers(request.headers);
    headers.set("X-Bimax-Device", deviceId);
    headers.set("X-Bimax-Role", role);
    headers.set("X-Bimax-Hello-Key", helloPubkey);
    return stub.fetch(new Request(url, { method: request.method, headers }));
  },
};
