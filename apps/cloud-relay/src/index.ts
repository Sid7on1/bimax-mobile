import type {Env as AccountEnv} from "../../gateway/src/auth";
import { verifyAuth } from "../../gateway/src/auth";
import {checkRateLimit} from "../../gateway/src/ratelimit";
import {readBoundedJson} from "../../gateway/src/validation";
import {mintTransportTicket} from "../../gateway/src/relay-ticket";
import {registerRelayDevice,renewRelayDevice,verifyRelayDevice} from "./device-admission";
import { jwtVerify } from "jose";
/// <reference types="@cloudflare/workers-types" />
import { Room } from "./room";

export { Room };

export interface Env extends AccountEnv {
  ROOM: DurableObjectNamespace;
  RELAY_TICKET_SECRET: string;
}

const ROOM_PATH_REGEX = /^\/room\/([A-Za-z0-9_-]{1,128})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      let ok = (env.RELAY_TICKET_SECRET?.length ?? 0) >= 32;
      try { await env.DB.prepare('SELECT renewal_id FROM relay_devices LIMIT 0').all(); }
      catch { ok=false; }
      return Response.json({ ok }, { status: ok ? 200 : 503 });
    }
    if(request.method==='POST' && ['/v1/relay-device','/v1/relay-device/renew','/v1/relay-ticket'].includes(url.pathname)){
      try {
        const body=await readBoundedJson(request);
        if(url.pathname==='/v1/relay-device/renew'){
          const credential=request.headers.get('Authorization')?.replace(/^Bearer /,'')??'';
          if(credential.length>8192)throw Error('Invalid device credential');
          const device=await verifyRelayDevice(env,credential,body);
          const limit=await checkRateLimit('relay:'+device.userId,env);if(!limit.allowed)return Response.json({error:'Try again shortly'},{status:429});
          return Response.json(await renewRelayDevice(env,credential,body));
        }
        const account=await verifyAuth(request,env);if(!account)return Response.json({error:'Sign in to Bimax to connect from anywhere'},{status:401});
        const limit=await checkRateLimit('relay:'+account.userId,env);if(!limit.allowed)return Response.json({error:'Try again shortly'},{status:429});
        if(url.pathname==='/v1/relay-device')return Response.json(await registerRelayDevice(env,account.userId,body));
        if(body.role!=='mobile')throw Error('Register the paired Mac before requesting admission');
        return Response.json({ticket:await mintTransportTicket(env,account.userId,body)});
      }catch{return Response.json({error:'Cloud connection authorization denied'},{status:403});}
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
