import {sha256Bytes} from "./crypto/keys";
import { fetch as expoFetch } from "expo/fetch";
import { requestChat, type StreamChatOptions } from "./chat-stream";
// lib/gateway.ts
import { supabase } from "./supabase";

export const DEFAULT_GATEWAY_URL = "https://bimax-gateway.sid7vish.workers.dev";

export function getGatewayUrl(): string {
  return process.env.EXPO_PUBLIC_GATEWAY_URL || DEFAULT_GATEWAY_URL;
}

export type { ChatMessageParam, StreamChatOptions } from "./chat-stream";
export interface StreamChatDependencies {
  getAccessToken?: () => Promise<string | null>;
  getGatewayUrl?: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface UsageInfo {
  tokensUsed: number;
  tokenBudget: number;
  resetAt: string;
}

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function getUsage(): Promise<UsageInfo | null> {
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const res = await fetch(`${getGatewayUrl()}/v1/usage`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as UsageInfo;
  } catch {
    return null;
  }
}

export function streamChat(options: StreamChatOptions, deps?: StreamChatDependencies) {
  return requestChat(options, {
    getAccessToken: deps?.getAccessToken ?? getAccessToken,
    getGatewayUrl: deps?.getGatewayUrl ?? getGatewayUrl,
    fetchImpl: deps?.fetchImpl ?? (expoFetch as unknown as typeof fetch),
    timeoutMs: deps?.timeoutMs,
  });
}

/** Acquire a room-scoped, short-lived upgrade ticket. Tokens never enter saved pairing URLs. */
export async function authorizeRelayUrl(
  relayUrl: string,
  deviceId: string,
  helloPubkey: string,
): Promise<string> {
  const url = new URL(relayUrl);
  if (url.protocol === "ws:") return relayUrl; // Explicit LAN transport.
  if (url.protocol !== "wss:") throw new Error("Invalid relay transport");
  const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,128})$/);
  if (!match) throw new Error("Invalid relay room");
  const token = await getAccessToken();
  if (!token) throw new Error("Sign in to connect");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10_000);
  try {
    const service=url.host===new URL(CLOUD_RELAY_SERVICE).host?CLOUD_RELAY_SERVICE:getGatewayUrl();
    const response = await expoFetch(`${service}/v1/relay-ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: match[1], deviceId, role: "mobile", helloPubkey }),
      signal: abort.signal,
    });
    if (!response.ok) throw new Error("Relay admission denied");
    const data = await relayResponse(response as unknown as Response);
    if(typeof data.ticket!=="string"||data.ticket.length>4096)throw Error("Invalid relay ticket");
    url.searchParams.set("ticket", data.ticket);
    return url.toString();
  } finally {
    clearTimeout(timeout);
  }
}

export const CLOUD_RELAY_SERVICE = "https://bimax-relay.sid7vish.workers.dev";
async function relayResponse(response: Response): Promise<Record<string,unknown>> {
  if(!response.ok)throw Error('Secure relay authorization is unavailable');
  const reader=response.body?.getReader();if(!reader)throw Error('Secure relay response unavailable');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192){await reader.cancel();throw Error('Invalid relay response');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const value:unknown=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid relay response');return value as Record<string,unknown>;
}
export function cloudRoomUrl(helloPubkey:string):string {
  if(!/^[A-Za-z0-9+/]{43}=$/.test(helloPubkey))throw Error('Invalid desktop relay key');
  const roomId=Array.from(sha256Bytes(new TextEncoder().encode(helloPubkey)),b=>b.toString(16).padStart(2,'0')).join('');
  return CLOUD_RELAY_SERVICE.replace(/^https:/,'wss:')+'/room/'+roomId;
}
export async function registerPairedCloud(proof: Record<string,unknown>, isCurrent=()=>true):Promise<{relayUrl:string;credential:string;deviceId:string}>{
  if(typeof proof.deviceId!=='string')throw Error('Invalid desktop identity');
  const token=await getAccessToken();if(!token)throw Error('Sign in to Bimax to connect from anywhere');if(!isCurrent())throw Error('Account or secure session changed');
  const response=await expoFetch(CLOUD_RELAY_SERVICE+'/v1/relay-device',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(proof),signal:AbortSignal.timeout(15000)});
  const result=await relayResponse(response as unknown as Response);
  if(result.deviceId!==proof.deviceId||result.relayUrl!==cloudRoomUrl(String(proof.helloPubkey))||typeof result.credential!=='string'||!/^rd_[a-f0-9-]{36}$/.test(result.credential))throw Error('Invalid paired-device relay grant');
  return {deviceId:proof.deviceId,relayUrl:result.relayUrl,credential:result.credential};
}
