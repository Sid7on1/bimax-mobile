/// <reference types="@cloudflare/workers-types" />
import { Room } from "./room";

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace;
}

const ROOM_PATH_REGEX = /^\/room\/([A-Za-z0-9_-]{1,128})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(ROOM_PATH_REGEX);
    if (!match) {
      return new Response("Not Found", { status: 404 });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 400 });
    }

    const roomId = match[1];
    const id = env.ROOM.idFromName("room:" + roomId);
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  },
};
